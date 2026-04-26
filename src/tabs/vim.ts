// Vim mode — cursor management, key handler, modeline UI, search/refile, ex
// commands, and the row-action commands (clone-as-child, new-tab-below, new-
// group-above, inline rename). Everything that's "you press a key, palefox
// does something" lives here.
//
// This is the largest single module in palefox. It's organized into sections
// via comment markers (// === Section === ) so you can navigate by jumping
// between them. Keep additions in their right section.
//
// Public API (factory-returned): see VimAPI below. Most surface is for vim's
// own init (createModeline, setupVimKeys), the row-click hook (activateVim,
// setCursor), the row-dblclick hooks (cloneAsSibling, startRename), and the
// onTabOpen hook (consumePendingCursorMove).

import { CHORD_TIMEOUT, INDENT } from "./constants.ts";
import {
  allRows,
  dataOf,
  hasChildren,
  isHorizontal,
  levelOf,
  levelOfRow,
  subtreeRows,
  tabById,
  treeData,
} from "./helpers.ts";
import { createLogger } from "./log.ts";
import { hzDisplay, rowOf, savedTabQueue, selection, state, treeOf } from "./state.ts";
import type { Row, Tab } from "./types.ts";
import type { LayoutAPI } from "./layout.ts";
import type { RowsAPI } from "./rows.ts";
import { makePicker, type PickerItem, type PickerAction } from "./picker.ts";

declare const document: Document;

const log = createLogger("tabs/vim");

// =============================================================================
// INTERFACE
// =============================================================================

export type VimDeps = {
  /** Row-rendering API. Vim drives row sync after tree mutations and on
   *  collapse/expand of horizontal popouts. */
  readonly rows: RowsAPI;
  /** Panel layout API. Vim toggles urlbar top-layer when expanding/collapsing
   *  horizontal-mode popouts. */
  readonly layout: LayoutAPI;
  /** Persist tree state to disk. */
  readonly scheduleSave: () => void;
  /** Clear the multi-select highlight. */
  readonly clearSelection: () => void;
  /** Extend the multi-select range up to the given row. */
  readonly selectRange: (row: Row) => void;
  /** The native #sidebar-main element — used for the search "single match
   *  found, dismiss sidebar" event. */
  readonly sidebarMain: HTMLElement;
  /** Temporal substrate — read for :restore / :sessions / :history,
   *  written via :checkpoint. */
  readonly history: import("./history.ts").HistoryAPI;
  /** Content-focus bridge — content_focus.ts frame script reports back
   *  whether the active page's focused element is editable. We use it to
   *  bail palefox keys when the user is typing into a content input. */
  readonly contentFocus: import("./content-focus.ts").ContentFocusAPI;
};

export type VimAPI = {
  /** Move the vim cursor to a row (or null to clear). */
  readonly setCursor: (row: Row | null) => void;
  /** Activate vim mode on the given row — focuses panel + sets cursor. */
  readonly activateVim: (row: Row | null) => void;
  /** Move cursor by delta (+1 down, -1 up). Skips hidden rows; selects the
   *  underlying tab if the cursor lands on a tab row. Returns true if the
   *  cursor actually moved. Used by legacy onTabClose for cursor handoff. */
  readonly moveCursor: (delta: number) => boolean;
  /** Give the tree panel keyboard focus. Idempotent. */
  readonly focusPanel: () => void;

  /** One-time init: build the modeline DOM at the bottom of the window. */
  readonly createModeline: () => void;
  /** One-time init: install the document keydown listener. */
  readonly setupVimKeys: () => void;
  /** One-time init: install the global keydown listener (t / : / Alt+X /
   *  ` / o / O / x). Fires regardless of sidebar focus. */
  readonly setupGlobalKeys: () => void;

  /** Duplicate a tab and place it as a child of the source tab. Sets the
   *  pending-cursor-move flag so the new row gets the cursor. */
  readonly cloneAsSibling: (tab: Tab) => void;
  /** Start inline rename of a tab or group row. */
  readonly startRename: (row: Row) => void;

  /** Consume the "next-new-row should get the cursor" flag. Called from
   *  onTabOpen in legacy. Returns true exactly once after a flag-setting
   *  action (newTabBelow / cloneAsSibling). */
  readonly consumePendingCursorMove: () => boolean;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makeVim(deps: VimDeps): VimAPI {
  const { rows, layout, scheduleSave, clearSelection, selectRange, sidebarMain, history, contentFocus } = deps;

  // ---------- spotlight picker ---------------------------------------------
  // Self-contained UI primitive — see src/tabs/picker.ts. We pass two
  // callbacks: focus restoration (back to the vim panel after dismiss)
  // and modelineMsg for action-failure messages. modelineMsg is a function
  // declaration so its hoisted binding is in scope here even though its
  // body appears below.

  const picker = makePicker({
    restoreFocus: () => state.panel?.focus(),
    modelineMsg: (text, durationMs) => modelineMsg(text, durationMs),
  });

  // ---------- private state -------------------------------------------------

  // Chord buffers — track multi-key sequences with a TTL.
  let chord: string | null = null;
  let chordTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let pendingCtrlW = false;
  let pendingSpace: boolean | string = false; // false | true | "w"

  // Cursor-handoff flag: newTabBelow / cloneAsSibling set it; onTabOpen consumes
  // it to put the cursor on the freshly created row.
  let pendingCursorMove = false;

  // Track which tree is expanded in horizontal popout mode.
  let hzExpandedRoot: Row | null = null;

  // Modeline DOM. Created once (createModeline) before any read.
  let modeline: HTMLElement = null as unknown as HTMLElement;
  let modelineTimer: ReturnType<typeof setTimeout> | 0 = 0;

  // Panel-focus flag — toggled by focusPanel/blurPanel. Used as a key-gate so
  // vim only intercepts keys while the panel actually owns focus.
  let panelActive = false;

  // Refile source — when set, search/Enter completes a refile-into-target.
  let refileSource: Row | null = null;

  // Selection anchor — set on the first Shift+J/K and used as the range start
  // for subsequent Shift+J/K presses. Reset whenever a non-extending key fires.
  let selectionAnchor: Row | null = null;

  // Search/filter state.
  let searchInput: HTMLInputElement | null = null;
  let searchActive = false;
  let searchMatches: Row[] = [];
  let searchIdx = -1;

  // ---------- Cursor / navigation ------------------------------------------

  function setCursor(row: Row | null): void {
    if (state.cursor) state.cursor.removeAttribute("pfx-cursor");
    state.cursor = row;
    if (row) {
      row.setAttribute("pfx-cursor", "true");
      row.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (isHorizontal()) updateHorizontalExpansion();
    }
  }

  /** Find the level-0 ancestor of a row. */
  function treeRoot(row: Row): Row {
    const allR = allRows();
    const idx = allR.indexOf(row);
    for (let i = idx; i >= 0; i--) {
      if (levelOfRow(allR[i]!) === 0) return allR[i]!;
    }
    return row;
  }

  /** Auto-collapse a horizontal-mode tree. On collapse, the root shows the
   *  last selected tab's visuals. */
  function collapseHzTree(root: Row): void {
    const d = dataOf(root);
    if (!d || !hasChildren(root)) return;

    if (state.cursor && state.cursor._tab && state.cursor !== root) {
      const curRoot = treeRoot(state.cursor);
      if (curRoot === root) {
        hzDisplay.set(root, state.cursor._tab);
      }
    }
    d.collapsed = true;
    rows.syncAnyRow(root);
    if (isHorizontal()) layout.setUrlbarTopLayer(true);
  }

  function expandHzTree(root: Row): void {
    const d = dataOf(root);
    if (!d || !hasChildren(root)) return;
    hzDisplay.delete(root);
    d.collapsed = false;
    rows.syncAnyRow(root);
    if (isHorizontal()) layout.setUrlbarTopLayer(false);
  }

  function updateHorizontalExpansion(): void {
    if (!state.cursor) return;
    const root = treeRoot(state.cursor);
    if (root === hzExpandedRoot) return;
    if (hzExpandedRoot) collapseHzTree(hzExpandedRoot);
    expandHzTree(root);
    hzExpandedRoot = root;
    rows.updateVisibility();
  }

  /** Move to next/previous level-0 tab (column navigation). */
  function moveToLevel0(delta: number): boolean {
    if (!state.cursor) return false;
    const allR = allRows();
    const curIdx = allR.indexOf(state.cursor);
    if (curIdx < 0) return false;
    const step = delta > 0 ? 1 : -1;
    for (let i = curIdx + step; i >= 0 && i < allR.length; i += step) {
      const candidate = allR[i]!;
      if (levelOfRow(candidate) === 0) {
        setCursor(candidate);
        if (candidate._tab) gBrowser.selectedTab = candidate._tab;
        return true;
      }
    }
    return false;
  }

  function activateVim(row: Row | null): void {
    focusPanel();
    setCursor(row);
  }

  /** Move cursor by delta (+1 down, -1 up). Skips hidden rows. Selects the
   *  underlying tab if the cursor lands on a tab row.
   *
   *  Walks the flat allRows() array (which returns pinned + panel rows as one
   *  contiguous list) rather than DOM siblings — that's what lets the cursor
   *  cross the boundary between the pinned container and the tree panel
   *  in either direction without falling off the edge. */
  function moveCursor(delta: number): boolean {
    if (!state.cursor) {
      log("moveCursor:noCursor", { delta });
      return false;
    }
    const all = allRows();
    const idx = all.indexOf(state.cursor);
    if (idx < 0) {
      log("moveCursor:cursorNotInAllRows", { delta, allLen: all.length });
      return false;
    }
    const step = delta > 0 ? 1 : -1;
    const skipped: any[] = [];
    for (let i = idx + step; i >= 0 && i < all.length; i += step) {
      const row = all[i]!;
      if (row.hidden) {
        skipped.push({
          i, kind: row._tab ? "tab" : row._group ? "group" : "?",
          label: row._tab?.label || row._group?.name,
          parentId: row._tab ? treeData(row._tab).parentId : row._group?.id,
          domParent: row.parentNode === state.pinnedContainer ? "pinned"
            : row.parentNode === state.panel ? "panel" : "other",
        });
        continue;
      }
      log("moveCursor:landed", {
        delta,
        fromIdx: idx,
        toIdx: i,
        skippedHidden: skipped,
        landedOn: {
          kind: row._tab ? "tab" : row._group ? "group" : "?",
          label: row._tab?.label || row._group?.name,
          parentId: row._tab ? treeData(row._tab).parentId : row._group?.id,
          domParent: row.parentNode === state.pinnedContainer ? "pinned"
            : row.parentNode === state.panel ? "panel" : "other",
        },
      });
      setCursor(row);
      if (row._tab) gBrowser.selectedTab = row._tab;
      return true;
    }
    log("moveCursor:noTarget", {
      delta, fromIdx: idx, allLen: all.length, skippedHidden: skipped,
    });
    return false;
  }

  // ---------- Tree operations -----------------------------------------------

  /** Find a tab's previous sibling (nearest preceding tab at same level with
   *  the same parent). Used for indent. */
  function prevSiblingTab(row: Row): Tab | null {
    if (!row?._tab) return null;
    const myTd = treeData(row._tab);
    const myLevel = levelOf(row._tab);
    let r = row.previousElementSibling;
    while (r) {
      if (r._tab) {
        const lv = levelOf(r._tab);
        if (lv < myLevel) return null;
        if (lv === myLevel && treeData(r._tab).parentId === myTd.parentId) {
          return r._tab;
        }
      }
      r = r.previousElementSibling;
    }
    return null;
  }

  /** Indent: reparent to the previous row. Whole subtree implicitly shifts
   *  because depth derives from parentId chain. Three cases:
   *    - row above is a group → set parentId to the group's id (tab nests
   *      inside the group at level group.level + 1)
   *    - row above is a tab sibling at same level → become its child
   *    - neither → no-op (nothing to indent into) */
  function indentRow(row: Row): void {
    if (row._group) {
      const allR = allRows();
      const i = allR.indexOf(row);
      if (i <= 0) return;
      const d = row._group;
      const prevLv = levelOfRow(allR[i - 1]!);
      if (d.level > prevLv) return;
      d.level++;
      rows.syncAnyRow(row);
    } else if (row._tab) {
      // Walk back: first row encountered determines the indent target.
      const prev = row.previousElementSibling;
      if (prev?._group) {
        treeData(row._tab).parentId = prev._group.id;
        for (const r of subtreeRows(row)) rows.syncAnyRow(r);
      } else {
        const sibling = prevSiblingTab(row);
        if (!sibling) return;
        treeData(row._tab).parentId = treeData(sibling).id;
        for (const r of subtreeRows(row)) rows.syncAnyRow(r);
      }
    }
    rows.updateVisibility();
    scheduleSave();
  }

  /** Outdent: reparent to grandparent. Subtree follows. Handles tab parents
   *  (walk one level up) and group parents (walk to group's container if it
   *  has one, else fall back to root). */
  function outdentRow(row: Row): void {
    if (row._group) {
      const d = row._group;
      if ((d.level || 0) <= 0) return;
      d.level = Math.max(0, d.level - 1);
      rows.syncAnyRow(row);
    } else if (row._tab) {
      const td = treeData(row._tab);
      if (td.parentId == null) return;
      if (typeof td.parentId === "string") {
        // Currently parented to a group — outdent leaves the group entirely.
        td.parentId = null;
      } else {
        const parent = tabById(td.parentId);
        td.parentId = parent ? treeData(parent).parentId : null;
      }
      for (const r of subtreeRows(row)) rows.syncAnyRow(r);
    }
    rows.updateVisibility();
    scheduleSave();
  }

  function moveToRoot(row: Row): void {
    if (!row?._tab) return;
    const td = treeData(row._tab);
    if (!td.parentId) return;
    td.parentId = null;
    for (const r of subtreeRows(row)) rows.syncAnyRow(r);
    rows.updateVisibility();
    scheduleSave();
  }

  function makeChildOfAbove(row: Row): void {
    if (!row?._tab) return;
    const prev = row.previousElementSibling;
    if (!prev) return;
    if (prev._group) {
      // Make a child of the group above.
      treeData(row._tab).parentId = prev._group.id;
    } else if (prev._tab) {
      treeData(row._tab).parentId = treeData(prev._tab).id;
    } else {
      return;
    }
    for (const r of subtreeRows(row)) rows.syncAnyRow(r);
    rows.updateVisibility();
    scheduleSave();
  }

  /** Alt+j — swap with next sibling at same level. */
  function swapDown(row: Row): void {
    if (!dataOf(row)) return;
    const myLevel = levelOfRow(row);
    const sub = subtreeRows(row);
    const lastRow = sub[sub.length - 1]!;
    const nextRow = lastRow.nextElementSibling;
    if (!nextRow || nextRow === state.spacer) return;
    if (levelOfRow(nextRow) !== myLevel) return;
    subtreeRows(nextRow).at(-1)!.after(...sub);
    rows.updateVisibility();
    scheduleSave();
  }

  /** Alt+k — swap with previous sibling at same level. */
  function swapUp(row: Row): void {
    if (!dataOf(row)) return;
    const myLevel = levelOfRow(row);
    let prev = row.previousElementSibling;
    while (prev && levelOfRow(prev) > myLevel) {
      prev = prev.previousElementSibling;
    }
    if (!prev || levelOfRow(prev) !== myLevel) return;
    prev.before(...subtreeRows(row));
    rows.updateVisibility();
    scheduleSave();
  }

  // ---------- Modeline ------------------------------------------------------

  function createModeline(): void {
    modeline = document.createXULElement("hbox") as HTMLElement;
    modeline.id = "pfx-modeline";
    modeline.setAttribute("align", "center");

    const modeLabel = document.createXULElement("label") as HTMLElement;
    modeLabel.id = "pfx-modeline-mode";
    modeLabel.setAttribute("value", "-- INSERT --");

    const chordLabel = document.createXULElement("label") as HTMLElement;
    chordLabel.id = "pfx-modeline-chord";
    chordLabel.setAttribute("value", "");
    chordLabel.setAttribute("flex", "1");

    const msgLabel = document.createXULElement("label") as HTMLElement;
    msgLabel.id = "pfx-modeline-msg";
    msgLabel.setAttribute("value", "");
    msgLabel.setAttribute("crop", "end");

    modeline.append(modeLabel, chordLabel, msgLabel);
    document.documentElement.appendChild(modeline);
  }

  function updateModeline(): void {
    if (!modeline) return;
    const modeLabel = document.getElementById("pfx-modeline-mode");
    const chordLabel = document.getElementById("pfx-modeline-chord");
    const msgLabel = document.getElementById("pfx-modeline-msg");

    let pending = "";
    if (pendingSpace === true) pending = "SPC-";
    else if (pendingSpace === "w") pending = "SPC w-";
    else if (pendingCtrlW) pending = "C-w-";
    else if (chord === "g") pending = "g-";

    if (modeLabel) modeLabel.setAttribute("value", "");
    if (chordLabel) chordLabel.setAttribute("value", pending);

    const hasContent = pending
      || (msgLabel && msgLabel.getAttribute("value"))
      || searchActive
      || modeline.querySelector(".pfx-search-input");
    modeline.toggleAttribute("pfx-visible", !!hasContent);
  }

  function modelineMsg(text: string, duration: number = 3000): void {
    if (!modeline) return;
    const msg = document.getElementById("pfx-modeline-msg");
    if (msg) {
      msg.setAttribute("value", text);
      modeline.setAttribute("pfx-visible", "true");
      clearTimeout(modelineTimer);
      modelineTimer = setTimeout(() => {
        msg.setAttribute("value", "");
        updateModeline();
      }, duration);
    }
  }

  // ---------- Panel focus ---------------------------------------------------

  function focusPanel(): void {
    panelActive = true;
    state.panel.focus();
    if (!state.cursor) {
      const row = rowOf.get(gBrowser.selectedTab);
      if (row) setCursor(row);
    }
    updateModeline();
  }

  function blurPanel(): void {
    panelActive = false;
    chord = null;
    pendingCtrlW = false;
    pendingSpace = false;
    clearTimeout(chordTimer);

    if (isHorizontal() && hzExpandedRoot) {
      collapseHzTree(hzExpandedRoot);
      hzExpandedRoot = null;
      rows.updateVisibility();
    }
    updateModeline();
  }

  // ---------- Keys ----------------------------------------------------------

  // ---------- Global keys ---------------------------------------------------
  //
  // Chrome-scope keyboard interface. Fires whenever palefox is loaded
  // (sidebar focused or not), as long as focus isn't in a text input.
  // Content-area keys (when a webpage has focus) DON'T reach this listener
  // because content lives in a separate process — that's Phase 2 work
  // (frame script + messaging). For now: chrome-area only.
  //
  // The keymap (per the user's vimium-replacement plan):
  //
  //   t           open spotlight tabs picker
  //   :           open spotlight ex-input
  //   `           toggle to last selected tab
  //   o           floating urlbar, current-tab intent (drawer/urlbar.ts)
  //   O           floating urlbar, new-tab intent — Enter spawns in new tab
  //   x           close current tab
  //   /           NOT intercepted — Firefox's native find owns it
  //   b / B       (Phase 1b — bookmarks picker, separate push)
  //
  // Composability (CSS-layers inspired): every binding is gated on a pref
  // `pfx.keys.<key>.enabled` (default true). Users can disable any palefox
  // binding to let vimium/tridactyl/Firefox-native take it. Set the pref
  // to false in about:config to opt out per-key without uninstalling.
  //
  // Originally also had Alt+X (Meta-X alias for `:`) but on Windows it's
  // Firefox's File→Exit accesskey; dispatching it crashes the chrome
  // window. Cross-platform safe binding TBD.

  /** Tracks the previously-selected tab so backtick can toggle. */
  let lastTab: Tab | null = null;
  let currentSelectedTab: Tab | null = null;

  /** Build picker items from the live tab tree. Used by :tabs and the
   *  global `t` shortcut. Tree-preserving — depth + parentId set so the
   *  picker filter shows ancestors as context. */
  function openTabsPicker(): void {
    const items: PickerItem[] = [];
    for (const tab of gBrowser.tabs as Iterable<Tab>) {
      const td = treeOf.get(tab);
      if (!td) continue;
      const url = tab.linkedBrowser?.currentURI?.spec || "";
      const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
      let icon: string | undefined;
      try { icon = gBrowser.getIcon(tab) || undefined; } catch {}
      items.push({
        display: td.name || tab.label || "(untitled)",
        secondary: host || url || "",
        icon,
        id: td.id,
        parentId: typeof td.parentId === "number" ? td.parentId : null,
        depth: levelOf(tab),
        data: tab,
      });
    }
    if (!items.length) {
      modelineMsg("No tabs", 3000);
      return;
    }
    picker.show({
      prompt: "tabs ›",
      items,
      preserveTree: true,
      onSelect: (item) => {
        const tab = item.data as Tab;
        try { gBrowser.selectedTab = tab; } catch {}
      },
      actions: [
        { label: "Close", key: "x", run: (item) => { try { gBrowser.removeTab(item.data as Tab); } catch {} } },
        { label: "Duplicate", key: "d", run: (item) => { try { gBrowser.duplicateTab(item.data as Tab); } catch {} } },
        { label: "Pin / Unpin", key: "p", run: (item) => {
          const t = item.data as Tab;
          try {
            if (t.pinned) gBrowser.unpinTab(t);
            else gBrowser.pinTab(t);
          } catch {}
        }},
        { label: "Reload", key: "r", run: (item) => { try { gBrowser.reloadTab(item.data as Tab); } catch {} } },
      ],
    });
  }

  // Both o/O route through src/drawer/urlbar.ts via the pfx-urlbar-activate
  // CustomEvent. The drawer owns the floating decoration + focus; tabs just
  // declares intent. New-tab spawning happens on Enter (drawer intercepts
  // and re-dispatches with altKey=true, hitting Firefox's open-in-new-tab
  // path). Empty Esc means no tab spawned — the user just dismissed.
  function activateUrlbar(intent: "current" | "newTab"): void {
    document.dispatchEvent(new CustomEvent("pfx-urlbar-activate", {
      detail: { intent },
    }));
  }

  function toggleLastTab(): void {
    const target = lastTab;
    if (!target) return;
    try {
      // tab.isOpen check — `isOpen` is in our Tab type and palefox uses it.
      if (target.isOpen) gBrowser.selectedTab = target;
    } catch (e) {
      console.error("palefox-tabs: toggleLastTab failed", e);
    }
  }

  /** Pref-gate per-binding. Users opt out of any palefox key by setting
   *  `pfx.keys.<name>.enabled` to false in about:config — letting
   *  vimium / tridactyl / native Firefox take it instead. Defaults true. */
  function keyEnabled(name: string): boolean {
    return Services.prefs.getBoolPref(`pfx.keys.${name}.enabled`, true);
  }

  /** Per-site escape hatch. Pref `pfx.keys.blacklist` is a comma-separated
   *  list of hostnames; entries match the current tab's hostname exactly OR
   *  as a parent suffix (e.g. `google.com` matches `docs.google.com`).
   *  Empty pref = blacklist disabled. Managed via `:blacklist` ex-commands. */
  function blacklistedHosts(): string[] {
    const raw = Services.prefs.getStringPref("pfx.keys.blacklist", "");
    return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }

  function currentHost(): string {
    try {
      const uri = (gBrowser.selectedBrowser as { currentURI?: { spec?: string } })?.currentURI?.spec;
      if (!uri) return "";
      return new URL(uri).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  function currentHostBlacklisted(): boolean {
    const host = currentHost();
    if (!host) return false;
    for (const entry of blacklistedHosts()) {
      if (host === entry) return true;
      if (host.endsWith("." + entry)) return true;
    }
    return false;
  }

  function blacklistAdd(host: string): void {
    const list = blacklistedHosts();
    const h = host.trim().toLowerCase();
    if (!h || list.includes(h)) return;
    list.push(h);
    Services.prefs.setStringPref("pfx.keys.blacklist", list.join(","));
  }

  function blacklistRemove(host: string): boolean {
    const list = blacklistedHosts();
    const h = host.trim().toLowerCase();
    const next = list.filter((x) => x !== h);
    if (next.length === list.length) return false;
    Services.prefs.setStringPref("pfx.keys.blacklist", next.join(","));
    return true;
  }

  /** Wire the global keydown listener + tab-toggle tracking. Called once
   *  from the orchestrator's init. */
  function setupGlobalKeys(): void {
    // Track tab switches for backtick toggle.
    currentSelectedTab = gBrowser.selectedTab as Tab;
    gBrowser.tabContainer.addEventListener("TabSelect", (e: Event) => {
      const newTab = e.target as Tab;
      if (newTab !== currentSelectedTab) {
        lastTab = currentSelectedTab;
        currentSelectedTab = newTab;
      }
    });

    document.addEventListener("keydown", (e) => {
      // Picker has its own input, don't compete.
      if (picker.isActive()) return;
      // Content's focused element is editable (input / textarea /
      // contentEditable / role=textbox|application). Bail. State comes
      // from the content_focus.ts frame script — same isEditable logic
      // Vimium uses (lib/dom_utils.js), bridged across the e10s boundary
      // via the message manager. Without this, plain `o` typed into a
      // page chat box would close-tab-and-open-urlbar instead of typing.
      if (contentFocus.contentInputFocused()) return;
      // Per-site escape hatch — let the page own its keys without uninstalling
      // palefox. Toggle via `:blacklist` / `:unblacklist`.
      if (currentHostBlacklisted()) return;
      // Bail when typing in any chrome input field — those keys are real input.
      const a = document.activeElement as HTMLElement | null;
      if (a && a !== state.panel && (
        a.tagName === "INPUT" || a.tagName === "input" ||
        a.tagName === "TEXTAREA" || a.tagName === "textarea" ||
        a.isContentEditable
      )) return;
      if (a && (a.closest?.("#urlbar") || a.closest?.("findbar") || a.closest?.(".pfx-search-input") || a.closest?.(".pfx-picker"))) return;

      // No-modifier global hotkeys (per-binding pref-gated).
      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        switch (e.key) {
          case "t":
            if (!keyEnabled("t")) break;
            e.preventDefault();
            e.stopImmediatePropagation();
            openTabsPicker();
            return;
          case ":":
            if (!keyEnabled("colon")) break;
            e.preventDefault();
            e.stopImmediatePropagation();
            startExMode();
            return;
          case "x":
            if (!keyEnabled("x")) break;
            e.preventDefault();
            e.stopImmediatePropagation();
            try { gBrowser.removeTab(gBrowser.selectedTab); } catch {}
            return;
          case "o":
            if (!keyEnabled("o")) break;
            e.preventDefault();
            e.stopImmediatePropagation();
            activateUrlbar("current");
            return;
          case "O":
            if (!keyEnabled("O")) break;
            e.preventDefault();
            e.stopImmediatePropagation();
            activateUrlbar("newTab");
            return;
          case "`":
            if (!keyEnabled("backtick")) break;
            e.preventDefault();
            e.stopImmediatePropagation();
            toggleLastTab();
            return;
          // / intentionally NOT bound — Firefox's find-as-you-type owns it.
        }
      }
    }, true);
  }

  function setupVimKeys(): void {
    state.panel.setAttribute("tabindex", "0");

    document.addEventListener("keydown", (e) => {
      // Picker takes precedence over everything else when it's up.
      // The picker (src/tabs/picker.ts) has its own keydown listener in
      // capture phase, so by the time we get here the picker has already
      // consumed anything it cares about. Just bail.
      if (picker.isActive()) return;

      if (!panelActive) return;

      // Auto-deactivate if focus moved to an input (urlbar, findbar, etc.)
      const active = document.activeElement;
      if (active && active !== state.panel
        && (active.tagName === "INPUT" || active.tagName === "input"
          || active.tagName === "TEXTAREA" || active.tagName === "textarea"
          || active.isContentEditable
          || active.closest?.("#urlbar") || active.closest?.("findbar"))) {
        blurPanel();
        return;
      }

      if (e.key === "Escape") {
        if (searchActive) {
          endSearch(false);
          e.preventDefault();
          e.stopImmediatePropagation();
        } else if (modeline?.querySelector(".pfx-search-input")) {
          endExMode(null);
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }

      if (handleNormalKey(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        updateModeline();
      } else if (e.key.length === 1) {
        // Unbound key — deactivate panel.
        blurPanel();
        // Plain key (no modifier): focus content for vimium etc.
        // Modifier combo (Ctrl+L, Ctrl+T): let Firefox handle natively.
        if (!e.ctrlKey && !e.altKey && !e.metaKey) {
          gBrowser.selectedBrowser.focus();
        }
      }
    }, true);

    // Clicking content area deactivates panel.
    gBrowser.tabpanels.addEventListener("mousedown", () => {
      if (panelActive) blurPanel();
    });
  }


  function focusContent(): void {
    gBrowser.selectedBrowser.focus();
  }

  /** Shared pane-switch logic (used by Ctrl+W and SPC+w chords). */
  function paneSwitch(key: string): void {
    switch (key) {
      case "h": case "H":
        state.panel.focus();
        if (!state.cursor) {
          const r = rowOf.get(gBrowser.selectedTab);
          if (r) setCursor(r);
        }
        return;
      case "l": case "L":
        focusContent();
        return;
      case "w":
        if (document.activeElement === state.panel) {
          focusContent();
        } else {
          state.panel.focus();
          if (!state.cursor) {
            const r = rowOf.get(gBrowser.selectedTab);
            if (r) setCursor(r);
          }
        }
        return;
    }
  }

  /** Returns true if the key was consumed; false to pass through. */
  function handleNormalKey(e: KeyboardEvent): boolean {
    // Selection anchor lives only across consecutive Shift+J/K presses.
    // Any other key (including unshifted j/k) drops it.
    if (e.key !== "J" && e.key !== "K") selectionAnchor = null;

    // --- Ctrl+W pane chords ---
    if (pendingCtrlW) {
      pendingCtrlW = false;
      clearTimeout(chordTimer);
      paneSwitch(e.key);
      return true;
    }
    if (e.ctrlKey && (e.key === "w" || e.code === "KeyW")) {
      pendingCtrlW = true;
      chordTimer = setTimeout(() => { pendingCtrlW = false; }, CHORD_TIMEOUT);
      return true;
    }

    // --- SPC+w pane chords (SPC → w → h/l/w) ---
    if (pendingSpace === "w") {
      pendingSpace = false;
      clearTimeout(chordTimer);
      paneSwitch(e.key);
      return true;
    }
    if (pendingSpace === true) {
      pendingSpace = false;
      clearTimeout(chordTimer);
      if (e.key === "w") {
        pendingSpace = "w";
        chordTimer = setTimeout(() => { pendingSpace = false; }, CHORD_TIMEOUT);
        return true;
      }
      return true; // unknown SPC chord, discard
    }
    if (e.key === " ") {
      pendingSpace = true;
      chordTimer = setTimeout(() => { pendingSpace = false; }, CHORD_TIMEOUT);
      return true;
    }

    // --- Regular chords (gg, gC) ---
    if (chord) {
      const combo = chord + e.key;
      chord = null;
      clearTimeout(chordTimer);
      if (combo === "gg") { goToTop(); return true; }
      if (combo === "gC") {
        if (state.cursor?._tab) cloneAsSibling(state.cursor._tab);
        return true;
      }
      return true;
    }
    if (e.key === "g" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      chord = e.key;
      chordTimer = setTimeout(() => { chord = null; }, CHORD_TIMEOUT);
      return true;
    }

    // --- i → focus content, deactivate panel ---
    if (e.key === "i") { blurPanel(); gBrowser.selectedBrowser.focus(); return true; }

    // --- Alt combos: same in both modes ---
    // Alt+h/Left = move to root, Alt+l/Right = make child of above
    // Alt+j/Down = swap down, Alt+k/Up = swap up
    if (e.altKey && (e.key === "h" || e.code === "KeyH" || e.key === "ArrowLeft")) {
      if (state.cursor) moveToRoot(state.cursor);
      return true;
    }
    if (e.altKey && (e.key === "l" || e.code === "KeyL" || e.key === "ArrowRight")) {
      if (state.cursor) makeChildOfAbove(state.cursor);
      return true;
    }
    if (e.altKey && (e.key === "j" || e.code === "KeyJ" || e.key === "ArrowDown")) {
      if (state.cursor) swapDown(state.cursor);
      return true;
    }
    if (e.altKey && (e.key === "k" || e.code === "KeyK" || e.key === "ArrowUp")) {
      if (state.cursor) swapUp(state.cursor);
      return true;
    }

    // --- Plain keys (need cursor) ---
    if (!state.cursor) {
      if ("jklhG/rnNx".includes(e.key)) {
        const row = rowOf.get(gBrowser.selectedTab);
        if (row) setCursor(row);
      }
      if (!state.cursor) return false;
    }

    // Navigation keys (only without Ctrl/Meta modifiers).
    // Vertical: j/k = move cursor, h/l = outdent/indent
    // Horizontal: h/l = move between columns, j/k = move within tree
    if (!e.ctrlKey && !e.metaKey) {
      if (isHorizontal()) {
        switch (e.key) {
          case "h": case "ArrowLeft": moveToLevel0(-1); return true;
          case "l": case "ArrowRight": moveToLevel0(1); return true;
          case "j": case "ArrowDown": moveCursor(1); return true;
          case "k": case "ArrowUp": moveCursor(-1); return true;
        }
      } else {
        switch (e.key) {
          case "j": case "ArrowDown": moveCursor(1); return true;
          case "k": case "ArrowUp": moveCursor(-1); return true;
          case "h": case "ArrowLeft": outdentRow(state.cursor); return true;
          case "l": case "ArrowRight": indentRow(state.cursor); return true;
        }
      }
    }

    switch (e.key) {
      case "Enter":
        if (refileSource) {
          if (state.cursor) executeRefile(state.cursor);
          return true;
        }
        if (state.cursor._tab) {
          gBrowser.selectedTab = state.cursor._tab;
          blurPanel();
          gBrowser.selectedBrowser.focus();
        } else {
          rows.toggleCollapse(state.cursor);
        }
        return true;
      case "Tab": rows.toggleCollapse(state.cursor); return true;
      case "Escape":
        if (refileSource) { cancelRefile(); return true; }
        return true;
      case "r": startRename(state.cursor); return true;
      case "G": goToBottom(); return true;
      // /, n, N removed in favor of global keys + spotlight :tabs (the
      // "all search lives in spotlight" rule). Page-content search lives
      // with Firefox's native find-as-you-type. Refile still uses
      // startSearch internally — that flow is invoked from :refile and
      // doesn't need the / keybinding.
      case "x": closeFocused(); return true;
      case ":": startExMode(); return true;
      case "J": {
        // Extend selection one row down. First press stamps the anchor.
        if (!selectionAnchor) selectionAnchor = state.cursor;
        if (moveCursor(1) && selectionAnchor) selectRange(selectionAnchor);
        return true;
      }
      case "K": {
        if (!selectionAnchor) selectionAnchor = state.cursor;
        if (moveCursor(-1) && selectionAnchor) selectRange(selectionAnchor);
        return true;
      }
    }

    return false;
  }

  // ---------- Goto ----------------------------------------------------------

  function goToTop(): void {
    const visible = allRows().filter(r => !r.hidden);
    if (!visible.length) return;
    const first = visible[0]!;
    setCursor(first);
    if (first._tab) gBrowser.selectedTab = first._tab;
  }

  function goToBottom(): void {
    const visible = allRows().filter(r => !r.hidden);
    if (!visible.length) return;
    const last = visible[visible.length - 1]!;
    setCursor(last);
    if (last._tab) gBrowser.selectedTab = last._tab;
  }

  // ---------- Actions -------------------------------------------------------

  function nextMatch(dir: number): void {
    if (!searchMatches.length) {
      modelineMsg("No previous search");
      return;
    }
    searchIdx = (searchIdx + dir + searchMatches.length) % searchMatches.length;
    const row = searchMatches[searchIdx]!;
    setCursor(row);
    if (row._tab) gBrowser.selectedTab = row._tab;
    const hint = refileSource ? "  Enter=refile" : "";
    modelineMsg(`[${searchIdx + 1}/${searchMatches.length}]${hint}`);
  }

  function closeFocused(): void {
    // Multi-select: close all selected.
    if (selection.size > 1) {
      const sel = [...selection];
      clearSelection();
      const last = sel[sel.length - 1]!;
      let next = last.nextElementSibling;
      while (next && (next.hidden || next === state.spacer || sel.includes(next as Row))) {
        next = next.nextElementSibling;
      }
      if (next && next !== state.spacer) setCursor(next as Row);
      for (let i = sel.length - 1; i >= 0; i--) {
        const row = sel[i]!;
        if (row._tab) gBrowser.removeTab(row._tab);
        else if (row._group) row.remove();
      }
      rows.updateVisibility();
      scheduleSave();
      return;
    }

    if (!state.cursor) return;
    if (state.cursor._tab) {
      gBrowser.removeTab(state.cursor._tab);
    } else if (state.cursor._group) {
      const d = state.cursor._group;
      const myLevel = d.level || 0;
      const groupId = d.id;
      // Reparent any tab whose parentId points at this group → null. Without
      // this, levelOf() would silently fail the lookup; doing it explicitly
      // keeps the saved tree consistent with what's on screen.
      for (const tab of gBrowser.tabs) {
        const td = treeData(tab);
        if (td.parentId === groupId) td.parentId = null;
      }
      // Decrement nested groups in the subtree by one level.
      let next = state.cursor.nextElementSibling;
      while (next && next !== state.spacer) {
        const lv = levelOfRow(next);
        if (lv <= myLevel) break;
        if (next._group) {
          next._group.level = Math.max(0, (next._group.level || 0) - 1);
          rows.syncGroupRow(next as Row);
        }
        next = next.nextElementSibling;
      }
      const dying = state.cursor;
      moveCursor(1) || moveCursor(-1);
      dying.remove();
      rows.updateVisibility();
      scheduleSave();
    }
  }

  /** Duplicate a tab and place the clone as a sibling at the same hierarchy
   *  level (shares parentId with the source tab). */
  function cloneAsSibling(tab: Tab): void {
    const sourceRow = rowOf.get(tab);
    if (!sourceRow) return;
    const siblingParentId = treeData(tab).parentId;

    pendingCursorMove = true;
    const clone = gBrowser.duplicateTab(tab);

    const obs = new MutationObserver(() => {
      const cloneRow = rowOf.get(clone);
      if (!cloneRow) return;
      obs.disconnect();
      treeData(clone).parentId = siblingParentId;
      // Insert after the source's full subtree so the clone lands as the
      // next sibling, not in the middle of children.
      const st = subtreeRows(sourceRow);
      st[st.length - 1]!.after(cloneRow);
      rows.syncTabRow(clone);
      rows.updateVisibility();
      scheduleSave();
    });
    obs.observe(state.panel, { childList: true });
  }

  function newTabBelow(): void {
    pendingCursorMove = true;
    gBrowser.selectedTab = gBrowser.addTab("about:newtab", {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  }

  function newGroupAbove(): void {
    if (!state.cursor) return;
    const row = rows.createGroupRow("New Group", levelOfRow(state.cursor));
    state.cursor.before(row);
    setCursor(row);
    rows.updateVisibility();
    scheduleSave();
    startRename(row);
  }

  // ---------- Ex mode (:commands) -------------------------------------------

  function startExMode(): void {
    if (searchActive || !modeline) return;

    for (const child of modeline.children) (child as HTMLElement).hidden = true;
    modeline.setAttribute("pfx-visible", "true");

    const prefix = document.createXULElement("label") as HTMLElement;
    prefix.className = "pfx-search-prefix";
    prefix.setAttribute("value", ":");

    const input = document.createElement("input");
    input.className = "pfx-search-input";

    modeline.append(prefix, input);
    input.focus();

    input.addEventListener("keydown", (e) => {
      e.stopImmediatePropagation();
      e.stopPropagation();
      if (e.key === "Escape") { endExMode(null); focusPanel(); return; }
      if (e.key === "Enter") { endExMode(input.value.trim()); focusPanel(); return; }
      if (e.key === "Backspace" && !input.value) { endExMode(null); focusPanel(); return; }
    });
  }

  function endExMode(cmd: string | null): void {
    modeline.querySelector(".pfx-search-prefix")?.remove();
    modeline.querySelector(".pfx-search-input")?.remove();
    for (const child of modeline.children) (child as HTMLElement).hidden = false;
    updateModeline();

    if (!cmd) return;

    const args = cmd.split(/\s+/);
    const name = (args[0] || "").toLowerCase();

    switch (name) {
      case "group":
      case "grp":
      case "folder": {
        const label = args.slice(1).join(" ") || "New Group";
        const row = rows.createGroupRow(label, state.cursor ? levelOfRow(state.cursor) : 0);
        if (state.cursor) {
          const st = subtreeRows(state.cursor);
          st[st.length - 1]!.after(row);
        } else {
          state.panel.insertBefore(row, state.spacer);
        }
        setCursor(row);
        rows.updateVisibility();
        scheduleSave();
        modelineMsg(`:group ${label}`);
        break;
      }
      case "re":
      case "refile":
      case "rf": {
        if (!state.cursor) {
          modelineMsg("No cursor — place cursor on tab to refile", 3000);
          break;
        }
        refileSource = state.cursor;
        const srcLabel = dataOf(state.cursor)?.name || state.cursor._tab?.label || "tab";
        log("refile:start", {
          srcLabel,
          srcKind: refileSource._tab ? "tab" : refileSource._group ? "group" : "?",
          srcLevel: levelOfRow(refileSource),
          srcSubtreeSize: subtreeRows(refileSource).length,
        });
        modelineMsg(`Refile: "${srcLabel}" → search for target...`);
        setTimeout(() => startSearch(), 0);
        break;
      }
      case "pin": {
        const t = state.cursor?._tab;
        if (!t) { modelineMsg("No tab at cursor", 3000); break; }
        if (t.pinned) modelineMsg(`Already pinned: ${t.label}`, 2000);
        else { gBrowser.pinTab(t); modelineMsg(`:pin ${t.label}`); }
        break;
      }
      case "unpin": {
        const t = state.cursor?._tab;
        if (!t) { modelineMsg("No tab at cursor", 3000); break; }
        if (!t.pinned) modelineMsg(`Not pinned: ${t.label}`, 2000);
        else { gBrowser.unpinTab(t); modelineMsg(`:unpin ${t.label}`); }
        break;
      }
      case "checkpoint":
      case "cp": {
        // :checkpoint <label> — tag the most recent history event.
        const label = args.slice(1).join(" ").trim();
        if (!label) {
          modelineMsg("Usage: :checkpoint <label>", 3000);
          break;
        }
        // Force a save first so the latest tree state is captured before
        // we tag. Then tag.
        scheduleSave();
        // scheduleSave is async; give the dedupe + INSERT a moment.
        setTimeout(async () => {
          try {
            const id = await history.tagLatest("checkpoint", label);
            modelineMsg(id ? `:checkpoint "${label}"` : "Nothing to tag (no events yet)", 3000);
          } catch (e) {
            modelineMsg(`:checkpoint failed: ${(e as Error).message}`, 4000);
          }
        }, 100);
        break;
      }
      case "restore": {
        // :restore [<label-substring>] — restore a tagged session.
        // No arg: open the picker over tagged points; user picks one.
        // With arg: substring-match against tag labels; restore most recent match.
        const arg = args.slice(1).join(" ").trim();
        (async () => {
          try {
            const tagged = await history.getTagged(100);
            if (!tagged.length) {
              modelineMsg("No tagged sessions yet — :checkpoint or quit Firefox to create one", 4000);
              return;
            }
            if (!arg) {
              picker.show({
                prompt: "restore ›",
                items: tagged.map((e) => ({ display: summarizeEvent(e), data: e })),
                onSelect: async (item) => {
                  const ev = item.data as import("./history.ts").HistoryEvent;
                  try {
                    await restoreEvent(ev);
                    modelineMsg(`Restored: ${labelOf(ev.tag)}`, 4000);
                  } catch (e) {
                    modelineMsg(`:restore failed: ${(e as Error).message}`, 4000);
                  }
                },
              });
              return;
            }
            const needle = arg.toLowerCase();
            const matches = tagged.filter((e) => (labelOf(e.tag) ?? "").toLowerCase().includes(needle));
            if (matches.length === 0) {
              modelineMsg(`No sessions match "${arg}"`, 3000);
              return;
            }
            const target = matches[0]!;
            await restoreEvent(target);
            modelineMsg(`Restored: ${labelOf(target.tag)}`, 4000);
          } catch (e) {
            modelineMsg(`:restore failed: ${(e as Error).message}`, 4000);
          }
        })();
        break;
      }
      case "sessions": {
        // :sessions [<query>] — picker over tagged points (with optional FTS pre-filter).
        const q = args.slice(1).join(" ").trim();
        (async () => {
          try {
            const evs = q
              ? await history.search(q, { taggedOnly: true, limit: 100 })
              : await history.getTagged(100);
            if (!evs.length) {
              modelineMsg(q ? `No sessions match "${q}"` : "No sessions yet", 3000);
              return;
            }
            picker.show({
              prompt: "sessions ›",
              items: evs.map((e) => ({ display: summarizeEvent(e), data: e })),
              onSelect: async (item) => {
                const ev = item.data as import("./history.ts").HistoryEvent;
                try {
                  await restoreEvent(ev);
                  modelineMsg(`Restored: ${labelOf(ev.tag)}`, 4000);
                } catch (e) {
                  modelineMsg(`:sessions restore failed: ${(e as Error).message}`, 4000);
                }
              },
            });
          } catch (e) {
            modelineMsg(`:sessions failed: ${(e as Error).message}`, 4000);
          }
        })();
        break;
      }
      case "tabs":
        openTabsPicker();
        break;
      case "blacklist":
      case "bl": {
        // :blacklist                 — add current site to blacklist
        // :blacklist <host>          — add an explicit host
        // :blacklist list            — show current blacklist
        // :blacklist remove [<host>] — remove (default: current site)
        const sub = (args[1] || "").toLowerCase();
        if (sub === "list" || sub === "ls") {
          const list = blacklistedHosts();
          modelineMsg(list.length ? `Blacklist: ${list.join(", ")}` : "Blacklist is empty", 5000);
        } else if (sub === "remove" || sub === "rm" || sub === "del") {
          const host = args[2]?.trim() || currentHost();
          if (!host) { modelineMsg("No host to remove", 3000); break; }
          modelineMsg(blacklistRemove(host) ? `Removed: ${host}` : `Not in blacklist: ${host}`, 3000);
        } else {
          const host = args[1]?.trim() || currentHost();
          if (!host) { modelineMsg("No host to blacklist", 3000); break; }
          blacklistAdd(host);
          modelineMsg(`Blacklisted: ${host}`, 3000);
        }
        break;
      }
      case "unblacklist":
      case "ubl": {
        const host = args[1]?.trim() || currentHost();
        if (!host) { modelineMsg("No host to remove", 3000); break; }
        modelineMsg(blacklistRemove(host) ? `Removed: ${host}` : `Not in blacklist: ${host}`, 3000);
        break;
      }
      case "history": {
        // :history [<query>] — picker over ALL events, tagged or not.
        const q = args.slice(1).join(" ").trim();
        (async () => {
          try {
            const evs = q
              ? await history.search(q, { taggedOnly: false, limit: 100 })
              : await history.getRecent(100);
            if (!evs.length) {
              modelineMsg(q ? `No events match "${q}"` : "No history yet", 3000);
              return;
            }
            picker.show({
              prompt: "history ›",
              items: evs.map((e) => ({ display: summarizeEvent(e), data: e })),
              onSelect: async (item) => {
                const ev = item.data as import("./history.ts").HistoryEvent;
                try {
                  await restoreEvent(ev);
                  const label = labelOf(ev.tag);
                  modelineMsg(`Restored: ${label ?? new Date(ev.timestamp).toLocaleString()}`, 4000);
                } catch (e) {
                  modelineMsg(`:history restore failed: ${(e as Error).message}`, 4000);
                }
              },
            });
          } catch (e) {
            modelineMsg(`:history failed: ${(e as Error).message}`, 4000);
          }
        })();
        break;
      }
      default:
        modelineMsg(`Unknown command: ${name}`, 3000);
    }
  }

  // ---------- History helpers ----------------------------------------------

  /** Strip the "session:" / "checkpoint:" prefix off an event's tag. */
  function labelOf(tag: string | null): string | null {
    if (!tag) return null;
    const i = tag.indexOf(":");
    return i >= 0 ? tag.slice(i + 1) : tag;
  }

  /** Compact one-event summary for modeline display. Format:
   *    [tag-label-or-time]  Nt  hostname-or-name
   *  Tagged:    "[checkpoint:research] 12t github.com"
   *  Untagged:  "10:42 4t example.com"
   *  Empty:     "10:42 0t" */
  function summarizeEvent(e: import("./history.ts").HistoryEvent): string {
    const t = labelOf(e.tag);
    const head = t ? `[${t}]` : new Date(e.timestamp).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit",
    });
    const tabs = (e.snapshot.nodes ?? []).filter((n) => n.type !== "group");
    const sample = pickSample(tabs);
    return sample ? `${head} ${tabs.length}t ${sample}` : `${head} ${tabs.length}t`;
  }

  /** Pick a representative URL/name to differentiate similar events.
   *  Prefer the most recent tab's user-given name if set; otherwise the
   *  hostname of its URL; otherwise the first tab's hostname. Truncated. */
  function pickSample(tabs: ReadonlyArray<import("./types.ts").SavedNode>): string {
    const tail = tabs[tabs.length - 1];
    const head = tabs[0];
    const tryNode = (n: import("./types.ts").SavedNode | undefined): string => {
      if (!n) return "";
      if (n.name) return n.name;
      const url = n.url || "";
      try {
        const host = new URL(url).hostname;
        if (host) return host;
      } catch {}
      // about: URLs and others without a hostname — show a short suffix.
      return url.slice(0, 24);
    };
    const out = tryNode(tail) || tryNode(head);
    return out.length > 24 ? out.slice(0, 22) + "…" : out;
  }

  /** Restore a saved event into the live workspace as a subtree under a
   *  synthetic group node. Re-keys all pfx-ids past state.nextTabId so
   *  there's no collision with currently-live tabs. Live tabs are NOT
   *  affected — restored content is added alongside.
   *
   *  Walks the saved nodes:
   *    1. Compute a re-key offset = state.nextTabId; bump nextTabId past max.
   *    2. Build a synthetic Group entry with the event's label + level 0.
   *    3. Each saved node's id and parentId (when numeric) are shifted by
   *       offset. Saved nodes whose parentId was null become children of
   *       the synthetic group.
   *    4. Push everything onto state.savedTabQueue, then open new tabs at
   *       the saved URLs — palefox's onTabOpen → popSavedForTab pipeline
   *       wires each newly-arriving tab to its pre-translated parentId.
   */
  async function restoreEvent(event: import("./history.ts").HistoryEvent): Promise<void> {
    const env = event.snapshot;
    const tabNodes = env.nodes.filter((n) => n.type !== "group");
    if (!tabNodes.length) {
      modelineMsg("Restore: no tabs in event", 3000);
      return;
    }

    // Re-key offset: shift saved ids out of the live id space.
    const maxSavedId = Math.max(0, ...tabNodes.map((n) => n.id || 0));
    const offset = state.nextTabId;
    state.nextTabId = state.nextTabId + maxSavedId + 1;

    // Build synthetic group row + insert at top of panel.
    const groupName = labelOf(event.tag) ?? `Restored ${new Date(event.timestamp).toLocaleString()}`;
    const groupRow = rows.createGroupRow(groupName, 0);
    state.panel.insertBefore(groupRow, state.spacer);
    rows.syncAnyRow(groupRow);

    // Push re-keyed saved nodes into the savedTabQueue. onTabOpen will
    // consume them as new tabs arrive (matched by URL or FIFO).
    for (const n of tabNodes) {
      const newId = (n.id || 0) + offset;
      const newParentId = typeof n.parentId === "number"
        ? n.parentId + offset
        : groupRow._group!.id;
      const cloned: import("./types.ts").SavedNode = {
        ...n,
        id: newId,
        parentId: newParentId,
        _origIdx: savedTabQueue.length,
      };
      savedTabQueue.push(cloned);
    }

    // Now actually open tabs at the saved URLs. The TabOpen handler
    // (events.ts onTabOpen) calls popSavedForTab which pulls our queued
    // entries off and applies them via applySavedToTab.
    for (const n of tabNodes) {
      const url = n.url || "about:blank";
      try {
        gBrowser.addTab(url, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
      } catch (e) {
        log("restore:addTab-failed", { url, err: String(e) });
      }
    }

    // Trigger a save so the restored state is captured.
    scheduleSave();
  }

  // ---------- Refile --------------------------------------------------------

  function executeRefile(target: Row): void {
    if (!refileSource) {
      log("refile:abort", { reason: "no-refileSource" });
      return;
    }
    if (!target) {
      log("refile:abort", { reason: "no-target" });
      return;
    }
    if (target === refileSource) {
      log("refile:abort", { reason: "target-is-source" });
      return;
    }
    const srcRows = subtreeRows(refileSource);
    if (srcRows.includes(target)) {
      log("refile:abort", { reason: "target-in-source-subtree", srcRowsCount: srcRows.length });
      modelineMsg("Can't refile under own subtree", 3000);
      return;
    }
    const srcData = dataOf(refileSource);
    const tgtData = dataOf(target);
    if (!srcData || !tgtData) {
      log("refile:abort", { reason: "no-data", hasSrcData: !!srcData, hasTgtData: !!tgtData });
      return;
    }

    const srcKind = refileSource._tab ? "tab" : "group";
    const tgtKind = target._tab ? "tab" : "group";
    const groupCountInSubtree = srcRows.filter(r => r._group).length;
    log("refile:enter", {
      srcLabel: srcData.name || refileSource._tab?.label,
      tgtLabel: tgtData.name || target._tab?.label,
      srcKind, tgtKind,
      srcLevel: levelOfRow(refileSource),
      tgtLevel: levelOfRow(target),
      srcSubtreeSize: srcRows.length,
      groupCountInSubtree,
      srcParentIdBefore: refileSource._tab ? treeData(refileSource._tab).parentId : null,
    });

    if (refileSource._tab && target._tab) {
      // Tab → Tab: update source's parentId. Descendants follow via parentId chain.
      // BUG CANDIDATE: groups nested inside source's subtree have a STORED level
      // that isn't derived from parentId. Their stored level was set relative to
      // the OLD parent depth and doesn't get updated here.
      const oldParentId = treeData(refileSource._tab).parentId;
      treeData(refileSource._tab).parentId = treeData(target._tab).id;
      log("refile:tab-to-tab", {
        oldParentId,
        newParentId: treeData(target._tab).id,
        groupsAffected: groupCountInSubtree,
      });
    } else {
      const tgtLevel = levelOfRow(target);
      const srcLevel = levelOfRow(refileSource);
      const delta = (tgtLevel + 1) - srcLevel;
      log("refile:level-delta", { srcLevel, tgtLevel, delta });
      for (const r of srcRows) {
        if (r._group) r._group.level = Math.max(0, (r._group.level || 0) + delta);
      }
    }

    const tgtSub = subtreeRows(target);
    log("refile:placing", { tgtSubtreeSize: tgtSub.length });
    tgtSub[tgtSub.length - 1]!.after(...srcRows);

    for (const r of srcRows) rows.syncAnyRow(r);
    rows.updateVisibility();
    scheduleSave();

    log("refile:done", {
      srcLevelAfter: levelOfRow(refileSource),
      groupLevelsAfter: srcRows.filter(r => r._group).map(r => r._group!.level),
    });

    const label = srcData.name || (refileSource._tab?.label) || "tab";
    const tgtLabel = tgtData.name || (target._tab?.label) || "tab";
    modelineMsg(`Refiled "${label}" → "${tgtLabel}"`);
    refileSource = null;
    searchMatches = [];
    searchIdx = -1;
  }

  function cancelRefile(): void {
    if (refileSource) {
      log("refile:cancel", {});
      refileSource = null;
      searchMatches = [];
      searchIdx = -1;
      modelineMsg("Refile cancelled");
    }
  }

  // ---------- Search / filter (renders in modeline) -------------------------

  function startSearch(): void {
    if (searchActive || !modeline) return;
    searchActive = true;

    for (const child of modeline.children) (child as HTMLElement).hidden = true;
    modeline.setAttribute("pfx-visible", "true");

    const input = document.createElement("input");
    searchInput = input;
    input.className = "pfx-search-input";
    input.placeholder = "";
    modeline.appendChild(input);
    input.focus();

    const prefix = document.createXULElement("label") as HTMLElement;
    prefix.className = "pfx-search-prefix";
    prefix.setAttribute("value", "/");
    modeline.insertBefore(prefix, input);

    input.addEventListener("input", () => applyFilter(input.value));

    input.addEventListener("keydown", (e) => {
      e.stopImmediatePropagation();
      e.stopPropagation();
      // endSearch handles its own focus restoration internally — don't
      // double-focus here.
      if (e.key === "Escape") { endSearch(false); return; }
      if (e.key === "Enter") { endSearch(true); return; }
      if (e.key === "Backspace" && !input.value) { endSearch(false); return; }
    });
  }

  function endSearch(accept: boolean): void {
    searchActive = false;

    if (accept) {
      const q = searchInput?.value?.trim().toLowerCase() || "";
      searchMatches = [];
      searchIdx = -1;
      const excluded = refileSource ? new Set(subtreeRows(refileSource)) : null;
      if (q) {
        for (const row of allRows()) {
          if (excluded?.has(row)) continue;
          const d = dataOf(row);
          if (!d) continue;
          const label = (d.name || (row._tab ? row._tab.label : "") || "").toLowerCase();
          const url = (row._tab?.linkedBrowser?.currentURI?.spec || "").toLowerCase();
          if (label.includes(q) || url.includes(q)) searchMatches.push(row);
        }
      }
      // Did we pass focus to content (single-match dismiss)? Tracks whether
      // we should re-focus the panel below or leave focus where we put it.
      let dismissedToContent = false;

      if (searchMatches.length === 1) {
        const match = searchMatches[0]!;
        setCursor(match);
        if (match._tab) gBrowser.selectedTab = match._tab;
        if (refileSource) {
          // Auto-commit refile when there's exactly one target. The user
          // already disambiguated with their query — don't make them confirm.
          executeRefile(match);
        } else {
          // Normal search single-match: dismiss sidebar, focus content.
          panelActive = false;
          searchMatches = [];
          searchIdx = -1;
          sidebarMain.dispatchEvent(new Event("pfx-dismiss"));
          dismissedToContent = true;
        }
      } else if (searchMatches.length) {
        searchIdx = 0;
        const first = searchMatches[0]!;
        setCursor(first);
        if (first._tab) gBrowser.selectedTab = first._tab;
        const hint = refileSource ? "  Enter=refile, n/N=cycle" : "";
        modelineMsg(`/${q}  [1/${searchMatches.length}]${hint}`);
      } else if (refileSource) {
        modelineMsg("No refile targets found");
      }
      clearFilter();

      // Tear down the search input + prefix from the modeline.
      if (searchInput) searchInput.remove();
      searchInput = null;
      const prefix = modeline?.querySelector(".pfx-search-prefix");
      if (prefix) prefix.remove();
      for (const child of modeline.children) (child as HTMLElement).hidden = false;
      updateModeline();

      // Re-focus the panel UNLESS we just dismissed to content. Search input
      // had stolen focus (panelActive was set false by the doc keydown's
      // input-focus auto-deactivate) — without this, a follow-up Enter / n /
      // N would go to <body> and never reach the vim handler.
      if (!dismissedToContent) focusPanel();
    } else {
      searchMatches = [];
      searchIdx = -1;
      clearFilter();
      if (refileSource) cancelRefile();

      if (searchInput) searchInput.remove();
      searchInput = null;
      const prefix = modeline?.querySelector(".pfx-search-prefix");
      if (prefix) prefix.remove();
      for (const child of modeline.children) (child as HTMLElement).hidden = false;
      updateModeline();
      focusPanel();
    }
  }

  function applyFilter(query: string): void {
    const q = query.trim().toLowerCase();
    if (!q) { clearFilter(); return; }

    const allR = allRows();
    const matched = new Set<Row>();

    for (const row of allR) {
      const d = dataOf(row);
      if (!d) continue;
      const label = (d.name || (row._tab ? row._tab.label : "") || "").toLowerCase();
      const url = (row._tab?.linkedBrowser?.currentURI?.spec || "").toLowerCase();
      if (label.includes(q) || url.includes(q)) {
        matched.add(row);
      }
    }

    // Mark ancestors of matched rows (preserve tree context).
    for (const row of [...matched]) {
      let lv = levelOfRow(row);
      let prev = row.previousElementSibling;
      while (prev) {
        const plv = levelOfRow(prev);
        if (plv < lv) {
          matched.add(prev as Row);
          lv = plv;
        }
        if (plv === 0) break;
        prev = prev.previousElementSibling;
      }
    }

    for (const row of allR) {
      row.hidden = !matched.has(row);
    }
  }

  function clearFilter(): void {
    for (const row of allRows()) row.hidden = false;
    rows.updateVisibility();
  }

  // ---------- Inline rename -------------------------------------------------

  function startRename(row: Row): void {
    if (!row) return;
    const label = row.querySelector<HTMLElement>(".pfx-tab-label");
    if (!label) return;
    const d = dataOf(row);
    if (!d) return;

    const input = document.createElement("input");
    input.className = "pfx-rename-input";
    input.value = d.name || (row._tab ? row._tab.label : "") || "";

    label.hidden = true;
    row.insertBefore(input, label.nextSibling);
    input.focus();
    input.select();

    let done = false;
    function finish(commit: boolean): void {
      if (done) return;
      done = true;
      if (commit) {
        const v = input.value.trim();
        if (row._group) {
          d!.name = v || "New Group";
        } else {
          d!.name = (v && v !== row._tab!.label) ? v : null;
        }
        scheduleSave();
      }
      input.remove();
      label!.hidden = false;
      if (row._tab) rows.syncTabRow(row._tab);
      else rows.syncAnyRow(row);
      state.panel.focus();
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); focusPanel(); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); focusPanel(); }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
  }

  // ---------- pendingCursorMove handoff -------------------------------------

  function consumePendingCursorMove(): boolean {
    if (!pendingCursorMove) return false;
    pendingCursorMove = false;
    return true;
  }

  // ---------- Public API ----------------------------------------------------

  return {
    setCursor, activateVim, moveCursor, focusPanel,
    createModeline, setupVimKeys, setupGlobalKeys,
    cloneAsSibling, startRename,
    consumePendingCursorMove,
  };
}
