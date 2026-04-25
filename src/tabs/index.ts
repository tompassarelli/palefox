// Orchestrator for src/tabs/* — wires the typed slice modules together and
// runs init at delayed-startup-finished. All real work lives in:
//   log.ts, types.ts, constants.ts          — primitives
//   state.ts                                — shared mutable state
//   helpers.ts                              — tree walks + tab metadata
//   persist.ts                              — file I/O for the tree
//   drag.ts                                 — drag/drop
//   rows.ts                                 — row creation + sync
//   layout.ts                               — panel positioning
//   menu.ts                                 — context menu
//   vim.ts                                  — vim mode + row-action commands
//   events.ts                               — Firefox tab event handlers
//
// What stays here:
//   - sidebarMain lookup + IIFE early-out
//   - clearSelection / selectRange (small selection helpers)
//   - buildPanel / buildFromSaved (one-shot DOM scaffolding at init)
//   - loadFromDisk (orchestrates persist.readTreeFromDisk + applies)
//   - the factory wiring (drag↔rows↔vim cycle handled with let-bindings)
//   - init() bootstrap

import { buildContextMenu, buildGroupContextMenu } from "./menu.ts";
import { makeDrag } from "./drag.ts";
import { makeEvents } from "./events.ts";
import { makeLayout } from "./layout.ts";
import { makeRows } from "./rows.ts";
import { makeVim } from "./vim.ts";
import {
  allRows, allTabs, pinTabId, tabUrl, treeData, tryRegisterPinAttr,
} from "./helpers.ts";
import { createLogger } from "./log.ts";
import { makeHistory, type HistoryAPI } from "./history.ts";
import { makeSaver } from "./snapshot.ts";
import {
  closedTabs, rowOf, savedTabQueue, selection, state, treeOf,
} from "./state.ts";
import type { Row, SavedNode, Tab } from "./types.ts";

declare const document: Document;
declare const gBrowser: any;
declare const gBrowserInit: any;
declare const Services: any;
declare const window: Window;

const pfxLog = createLogger("tabs");

  // Cast non-null; the early return below validates at runtime. Keeping the
  // type as HTMLElement (instead of HTMLElement | null) means inner functions
  // don't all need their own null checks across closure boundaries.
  const sidebarMain = document.getElementById("sidebar-main") as HTMLElement;
  // The build wraps this file in an IIFE, so this top-level `return` is
  // actually inside the function. TS doesn't see the wrapper.
  // @ts-expect-error TS1108 — intentional early-out from the IIFE.
  if (!sidebarMain) return;

  // --- Selection (small enough to stay here; vim + drag both consume) ---

  function clearSelection() {
    for (const r of selection) r.removeAttribute("pfx-multi");
    selection.clear();
  }

  function selectRange(toRow) {
    const fromRow = state.cursor || rowOf.get(gBrowser.selectedTab);
    if (!fromRow) return;
    const rows = allRows().filter(r => !r.hidden);
    const fromIdx = rows.indexOf(fromRow);
    const toIdx = rows.indexOf(toRow);
    if (fromIdx < 0 || toIdx < 0) return;

    clearSelection();
    const start = Math.min(fromIdx, toIdx);
    const end = Math.max(fromIdx, toIdx);
    for (let i = start; i <= end; i++) {
      selection.add(rows[i]);
      rows[i].setAttribute("pfx-multi", "true");
    }
  }

  function buildPanel() {
    while (state.panel.firstChild !== state.spacer) state.panel.firstChild!.remove();
    while (state.pinnedContainer.firstChild) state.pinnedContainer.firstChild.remove();
    for (const tab of gBrowser.tabs) {
      const row = Rows.createTabRow(tab);
      if (tab.pinned && state.pinnedContainer) {
        state.pinnedContainer.appendChild(row);
      } else {
        state.panel.insertBefore(row, state.spacer);
      }
    }
    if (state.pinnedContainer) {
      state.pinnedContainer.hidden = !state.pinnedContainer.querySelector(".pfx-tab-row");
    }
    Rows.updateVisibility();
  }


  // --- Persistence ---

  // Single source of truth: SQLite-backed temporal substrate at
  // <profile>/palefox-history.sqlite. Hash-deduped append-only event log
  // with FTS5 for search and tagged points for sessions/checkpoints.
  // See docs/dev/multi-session-architecture.md for the full design.
  const history: HistoryAPI = makeHistory();

  // Write-on-every-change: pulls a fresh snapshot for every flush, coalesces
  // overlapping schedules, hands off to history (which dedupes by content
  // hash so no-op snapshots cost zero DB writes).
  const scheduleSave = makeSaver(() => ({
    tabs: [...gBrowser.tabs],
    rows: () => allRows(),
    savedTabQueue,
    closedTabs,
    nextTabId: state.nextTabId,
    tabUrl,
    treeData,
  }), history);

  // drag ↔ Rows ↔ vim form a small cycle of mutual deps:
  //   - rows needs drag.setupDrag (each row gets DnD wired) AND vim's row-
  //     action handlers (activateVim, cloneAsSibling, startRename, selectRange)
  //   - drag needs Rows.scheduleTreeResync after a drop settles
  //   - vim needs the rows API (createGroupRow, sync*, toggleCollapse, …)
  //     AND the layout API (setUrlbarTopLayer)
  // We break the cycle with `let` declarations + thunks. Each thunk is only
  // invoked later at runtime, by which point all factories have been wired.
  let Rows: import("./rows.ts").RowsAPI;
  let vim: import("./vim.ts").VimAPI;
  const drag = makeDrag({
    clearSelection,
    scheduleTreeResync: () => Rows.scheduleTreeResync(),
    scheduleSave,
  });
  Rows = makeRows({
    setupDrag: drag.setupDrag,
    activateVim:    (row) => vim.activateVim(row),
    selectRange,
    clearSelection,
    cloneAsSibling:   (tab) => vim.cloneAsSibling(tab),
    startRename:    (row) => vim.startRename(row),
    scheduleSave,
  });
  const layout = makeLayout({
    sidebarMain,
    rows: Rows,
  });
  vim = makeVim({
    rows: Rows,
    layout,
    scheduleSave,
    clearSelection,
    selectRange,
    sidebarMain,
    history,
  });
  const events = makeEvents({
    rows: Rows,
    vim,
    scheduleSave,
  });

  async function loadFromHistory() {
    const recent = await history.getRecent(1);
    if (!recent.length) return;
    const env = recent[0]!.snapshot;
    try {
      if (env.nextTabId != null) state.nextTabId = env.nextTabId;
      closedTabs.length = 0;
      closedTabs.push(...env.closedTabs);

      const tabs = allTabs();
      // tabNodes = the tab entries (groups have type === "group").
      const tabNodes = env.nodes
        .filter((n) => n.type !== "group")
        .map((s) => ({ ...s }));
      state.lastLoadedNodes = tabNodes.map(s => ({ ...s }));

      // Belt-and-suspenders: advance state.nextTabId past every saved node ID before
      // any tab calls treeData(). saved.nextTabId covers this normally, but if
      // it was missing/stale, fresh startup tabs (localhost, etc.) would get an
      // ID that collides with a restored session tab's pfx-id attribute, causing
      // the wrong tab to resolve as parent in the tree.
      for (const s of tabNodes) {
        if (s.id && s.id >= state.nextTabId) state.nextTabId = s.id + 1;
      }
      pfxLog("loadFromHistory", { nextTabId: state.nextTabId, savedNextTabId: env.nextTabId, tabNodes: tabNodes.length, liveTabs: tabs.length, tabNodeIds: tabNodes.map(s => s.id), liveTabPfxIds: tabs.map(t => t.getAttribute?.("pfx-id") || 0) });

      const applied = new Set();
      const apply = (tab, s, i) => {
        const id = s.id || state.nextTabId++;
        treeOf.set(tab, {
          id,
          parentId: s.parentId ?? null,
          name: s.name || null,
          state: s.state || null,
          collapsed: !!s.collapsed,
        });
        pinTabId(tab, id);
        applied.add(i);
      };

      // Sidebery-style positional blindspot match. Walk live tabs and saved
      // nodes pairwise. For each pair: accept if URLs agree OR live tab is
      // pending (about:blank, hasn't loaded yet). Pending tabs always match
      // by position — Firefox restores in saved order, so positions agree
      // even when URLs haven't resolved yet. On URL mismatch with a live
      // URL present, scan ±5 live tabs for a URL match (user opened extras).
      let li = 0;
      for (let ni = 0; ni < tabNodes.length; ni++) {
        if (li >= tabs.length) break;
        const s = tabNodes[ni];
        const live = tabs[li];
        const liveUrl = live.linkedBrowser?.currentURI?.spec || "";
        const pending = liveUrl === "about:blank";
        if (liveUrl === s.url || pending) {
          apply(live, s, ni);
          li++;
          continue;
        }
        // ±5 lookahead for a direct URL match
        let off = 0;
        for (let j = 1; j <= 5 && li + j < tabs.length; j++) {
          const u = tabs[li + j].linkedBrowser?.currentURI?.spec || "";
          if (u === s.url) { off = j; break; }
        }
        if (off) { apply(tabs[li + off], s, ni); li += off + 1; }
        // else: saved node has no live counterpart yet — falls into savedTabState
      }

      console.log(
        `palefox-tabs: loaded ${tabNodes.length} saved tab nodes, ` +
        `matched ${applied.size} to live tabs (of ${tabs.length}).`
      );

      // Leftover nodes (no live match at init). Stash each node's original
      // index in gBrowser.tabs (= its position in the saved tabNodes list,
      // since we serialize in gBrowser.tabs order). Later-arriving session-
      // restore tabs match by their current gBrowser.tabs index.
      savedTabQueue.length = 0;
      tabNodes.forEach((s, i) => {
        if (applied.has(i)) return;
        s._origIdx = i;
        savedTabQueue.push(s);
      });

      // Full node list drives buildFromSaved for groups + order.
      loadedNodes = env.nodes;
    } catch (e) {
      console.error("palefox-tabs: loadFromHistory apply error", e);
    }
  }

  let loadedNodes: readonly SavedNode[] | null = null;

  // Build the state.panel from gBrowser.tabs (canonical order). Interleave groups
  // at their saved afterTabId anchors. Unanchored groups go to the top.
  function buildFromSaved() {
    if (!loadedNodes || !state.panel) return false;

    const groupNodes = loadedNodes.filter(n => n.type === "group");

    // Bucket groups by their anchor tab id. `null` = "top of state.panel."
    const leadingGroups: SavedNode[] = [];
    const groupsAfter = new Map<number, SavedNode[]>();
    for (const g of groupNodes) {
      if (g.afterTabId == null) leadingGroups.push(g);
      else {
        const arr = groupsAfter.get(g.afterTabId) || [];
        arr.push(g);
        groupsAfter.set(g.afterTabId, arr);
      }
    }

    const mkGroup = (g: SavedNode): Row => {
      const row = Rows.createGroupRow(g.name || "", g.level || 0);
      row._group!.state = g.state || null;
      row._group!.collapsed = !!g.collapsed;
      Rows.syncGroupRow(row);
      return row;
    };

    while (state.panel.firstChild !== state.spacer) state.panel.firstChild!.remove();
    while (state.pinnedContainer.firstChild) state.pinnedContainer.firstChild.remove();

    for (const g of leadingGroups) state.panel.insertBefore(mkGroup(g), state.spacer);

    for (const tab of gBrowser.tabs) {
      const row = Rows.createTabRow(tab);
      if (tab.pinned && state.pinnedContainer) {
        state.pinnedContainer.appendChild(row);
      } else {
        state.panel.insertBefore(row, state.spacer);
        const tid = treeData(tab).id;
        const groups = groupsAfter.get(tid);
        if (groups) for (const g of groups) state.panel.insertBefore(mkGroup(g), state.spacer);
      }
    }
    if (state.pinnedContainer) {
      state.pinnedContainer.hidden = !state.pinnedContainer.querySelector(".pfx-tab-row");
    }

    loadedNodes = null;
    Rows.scheduleTreeResync();
    Rows.updateVisibility();
    return true;
  }



  // --- Init ---

  async function init() {
    tryRegisterPinAttr();
    try {
      await loadFromHistory();
    } catch (e) {
      console.error("palefox-tabs: loadFromHistory threw — init proceeds with empty state", e);
    }
    await new Promise((r) => requestAnimationFrame(r));

    state.pinnedContainer = document.createXULElement("vbox");
    state.pinnedContainer.id = "pfx-pinned-container";
    state.pinnedContainer.hidden = true;
    drag.setupPinnedContainerDrop(state.pinnedContainer);

    state.panel = document.createXULElement("vbox");
    state.panel.id = "pfx-tab-panel";

    state.spacer = document.createXULElement("box");
    state.spacer.id = "pfx-tab-spacer";
    state.spacer.setAttribute("flex", "1");
    state.panel.appendChild(state.spacer);
    drag.setupPanelDrop(state.panel);

    layout.positionPanel();

    // Re-position when toolbox moves in/out of sidebar, or expand/collapse
    new MutationObserver(() => layout.positionPanel()).observe(sidebarMain, {
      childList: true,
      attributes: true,
      attributeFilter: ["sidebar-launcher-expanded"],
    });

    // Switch between horizontal/vertical layout
    Services.prefs.addObserver("sidebar.verticalTabs", {
      observe() { layout.positionPanel(); },
    });

    // Build from saved data (preserves groups + order) or fresh
    if (!buildFromSaved()) buildPanel();

    buildContextMenu({
      startRename: vim.startRename,
      toggleCollapse: Rows.toggleCollapse,
      createGroupRow: Rows.createGroupRow,
      setCursor: vim.setCursor,
      updateVisibility: Rows.updateVisibility,
      scheduleSave,
    });
    buildGroupContextMenu({
      startRename: vim.startRename,
      toggleCollapse: Rows.toggleCollapse,
      syncGroupRow: Rows.syncGroupRow,
      updateVisibility: Rows.updateVisibility,
      scheduleSave,
    });
    vim.createModeline();
    vim.setupVimKeys();
    vim.setupGlobalKeys();
    vim.focusPanel();

    // events.ts wires all gBrowser.tabContainer listeners + the sessionstore
    // observers. The returned closure removes the observers on window unload
    // (the listeners die with the window).
    const teardownEvents = events.install();

    // Click on state.spacer activates vim with last row.
    state.spacer.addEventListener("click", () => {
      const visible = allRows().filter(r => !r.hidden);
      if (visible.length) vim.activateVim(visible[visible.length - 1]!);
    });

    window.addEventListener("unload", teardownEvents, { once: true });

    // Quit-application observer: tag the most recent event as a session.
    // Fires before SessionStore writes its own state, so the latest event
    // captured by scheduleSave (which is hash-deduped, so it represents
    // the actual final state) becomes the session entry. If somehow no
    // events exist (brand-new profile), tagLatest is a no-op.
    const sessionTagger = {
      observe(_subject: unknown, topic: string) {
        if (topic === "quit-application") {
          history.tagLatest("session").catch((e) => {
            console.error("palefox-tabs: tagLatest on quit failed", e);
          });
        }
      },
    };
    Services.obs.addObserver(sessionTagger, "quit-application");
    window.addEventListener("unload", () => {
      Services.obs.removeObserver(sessionTagger, "quit-application");
    }, { once: true });

    // Retention pass: prune untagged events older than retainDays / past
    // maxRows. Fires once at startup (after delayed-startup-finished, so
    // it doesn't compete with chrome-window setup) and then every 10
    // minutes during long sessions. Cheap when there's nothing to delete.
    setTimeout(() => {
      history.runRetention().catch((e) => {
        console.error("palefox-tabs: initial retention pass failed", e);
      });
    }, 30_000);
    const retentionTimer = setInterval(() => {
      history.runRetention().catch(() => {}); // best-effort
    }, 10 * 60 * 1000);
    window.addEventListener("unload", () => {
      clearInterval(retentionTimer);
      history.close().catch(() => {});
    }, { once: true });

    // Test-only debug API. Gated on `pfx.test.exposeAPI` so production
    // builds (where the pref is absent / false) don't expose internals.
    // Tests in tests/integration/* set this pref via the ephemeral
    // profile's user.js; see tools/test-driver/profile.ts.
    if (Services.prefs.getBoolPref("pfx.test.exposeAPI", false)) {
      window.pfxTest = {
        // Live state references (NOT snapshots — readers see future writes)
        state,
        treeOf,
        rowOf,
        // Cursor inspection — returns the pfx-id (TreeData.id) at the cursor
        // or null if no cursor / cursor on a non-tab row.
        cursorId() {
          const r = state.cursor;
          if (!r?._tab) return null;
          return treeOf.get(r._tab)?.id ?? null;
        },
        // Snapshot of all live tabs with their TreeData. Useful for asserting
        // tree structure post-event without DOM probing.
        snapshotTree(): Array<Record<string, unknown>> {
          const out: Array<Record<string, unknown>> = [];
          for (const t of gBrowser.tabs as Iterable<Tab>) {
            const td = treeOf.get(t);
            if (!td) continue;
            out.push({
              id: td.id,
              parentId: td.parentId,
              name: td.name,
              collapsed: td.collapsed,
              pinned: !!t.pinned,
              url: t.linkedBrowser?.currentURI?.spec ?? "",
              label: t.label,
            });
          }
          return out;
        },
        // Direct API access — use sparingly.
        vim,
        rows: Rows,
        scheduleSave,
        history,
      };
      console.log("palefox-tabs: pfxTest debug API exposed");
    }

    console.log("palefox-tabs: initialized");
  }

  if (gBrowserInit.delayedStartupFinished) {
    init();
  } else {
    const obs = (subject, topic) => {
      if (topic === "browser-delayed-startup-finished" && subject === window) {
        Services.obs.removeObserver(obs, topic);
        init();
      }
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
