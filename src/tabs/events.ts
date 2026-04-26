// Firefox tab event handlers — onTabOpen, onTabClose, onTabPinned/Unpinned,
// onTabMove, onTabSelect, onTabAttrModified, onTabRestoring — plus the
// sessionstore observers (windows-restored and manual-restore).
//
// This is the reactive layer: Firefox tells us a tab changed, palefox
// updates the panel + persist state in response. No internal mutable state;
// every handler reads from state.ts and dispatches into the rows / vim /
// persist APIs.
//
// Public API (factory-returned): installEventHandlers() — wires all listeners
// + observers on init. Returns a teardown closure for window unload.

import { CLOSED_MEMORY } from "./constants.ts";
import {
  allRows,
  dataOf,
  isHorizontal,
  levelOf,
  levelOfRow,
  parentOfTab,
  pinTabId,
  readPinnedId,
  subtreeRows,
  tabById,
  tabUrl,
  treeData,
} from "./helpers.ts";
import { createLogger } from "./log.ts";
import {
  popSavedByUrl as popQueueByUrl,
  popSavedForTab as popQueueForTab,
} from "./snapshot.ts";
import {
  closedTabs,
  movingTabs,
  rowOf,
  savedTabQueue,
  state,
  treeOf,
} from "./state.ts";
import type { Row, SavedNode, Tab } from "./types.ts";
import type { RowsAPI } from "./rows.ts";
import type { VimAPI } from "./vim.ts";

declare const window: Window;

const log = createLogger("tabs");

// =============================================================================
// INTERFACE
// =============================================================================

export type EventsDeps = {
  /** Row-rendering API. Most handlers call updateVisibility / scheduleTreeResync /
   *  syncTabRow / syncGroupRow after mutating tree state. */
  readonly rows: RowsAPI;
  /** Vim API — onTabClose hands off the cursor; onTabOpen consumes the
   *  pending-cursor-move flag. */
  readonly vim: VimAPI;
  /** Persist tree state to disk after every mutation. */
  readonly scheduleSave: () => void;
};

export type EventsAPI = {
  /** One-time setup: attach all gBrowser.tabContainer listeners + the
   *  sessionstore observers. Returns a teardown closure that unsubscribes
   *  the observers (the listeners die with the window). */
  readonly install: () => () => void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makeEvents(deps: EventsDeps): EventsAPI {
  const { rows, vim, scheduleSave } = deps;

  // ---------- pop-queue shims (inline binding of state.savedTabQueue) -------

  function popSavedByUrl(url: string | null | undefined): SavedNode | null {
    return popQueueByUrl(savedTabQueue, url);
  }

  function popSavedForTab(tab: Tab): SavedNode | null {
    return popQueueForTab(savedTabQueue, {
      currentIdx: [...gBrowser.tabs].indexOf(tab),
      pinnedId: readPinnedId(tab),
      url: tabUrl(tab),
      inSessionRestore: state.inSessionRestore,
      log,
    });
  }

  // ---------- helpers used by event handlers --------------------------------

  /** Pop the most-recent closed-tab entry matching this URL (LIFO). */
  function popClosedEntry(url: string | null): SavedNode | null {
    if (!url) return null;
    for (let i = closedTabs.length - 1; i >= 0; i--) {
      const entry = closedTabs[i]!;
      if (entry.url === url) return closedTabs.splice(i, 1)[0]!;
    }
    return null;
  }

  /** Apply a saved-state entry to a tab's treeData and re-sync every row.
   *  Idempotent — once applied, later spurious calls (e.g. SSTabRestoring on
   *  activation when a stale queue entry happened to URL-match) are no-ops. */
  function applySavedToTab(tab: Tab, prior: SavedNode): void {
    const td = treeData(tab);
    if (td.appliedSavedState) return;
    td.appliedSavedState = true;
    td.id = prior.id || td.id;
    td.parentId = prior.parentId ?? null;
    td.name = prior.name || null;
    td.state = prior.state || null;
    td.collapsed = !!prior.collapsed;
    pinTabId(tab, td.id);
    log("applySavedToTab", {
      id: td.id, parentId: td.parentId,
      priorId: prior.id, priorParentId: prior.parentId,
    });
    rows.scheduleTreeResync();
  }

  /** Snapshot a closing tab's identity, position, and descendants so
   *  onTabRestoring can put it back in the same slot with children re-nested. */
  function rememberClosedTab(tab: Tab, td: { id: number; name: string | null; state: string | null; collapsed: boolean } | null): void {
    const url = tabUrl(tab);
    if (!url || url === "about:blank") return;
    const row = rowOf.get(tab);
    if (!row) return;

    const parent = parentOfTab(tab);
    const myLevel = levelOf(tab);

    let prevSiblingId: number | null = null;
    let r = row.previousElementSibling;
    while (r) {
      if (r._tab) {
        const lvl = levelOf(r._tab);
        if (lvl < myLevel) break;
        if (lvl === myLevel) { prevSiblingId = treeData(r._tab).id; break; }
      }
      r = r.previousElementSibling;
    }

    const descendantIds: number[] = [];
    let n = row.nextElementSibling;
    while (n && n !== state.spacer) {
      if (n._tab) {
        const lvl = levelOf(n._tab);
        if (lvl <= myLevel) break;
        descendantIds.push(treeData(n._tab).id);
      }
      n = n.nextElementSibling;
    }

    closedTabs.push({
      url,
      id: td?.id || 0,
      parentId: parent ? treeData(parent).id : null,
      prevSiblingId,
      descendantIds,
      name: td?.name || null,
      state: td?.state || null,
      collapsed: !!td?.collapsed,
    });
    if (closedTabs.length > CLOSED_MEMORY) closedTabs.shift();
  }

  /** True iff Firefox considers this tab pinned right now. During pinTab(),
   *  the tab is moved into pinnedTabsContainer BEFORE the `pinned` attribute
   *  is set (and TabMove fires inside that window) — tab.pinned alone isn't
   *  enough to classify it during the transition. */
  function isFxPinned(tab: Tab): boolean {
    if (tab.pinned) return true;
    const ptc = gBrowser.tabContainer?.pinnedTabsContainer
      || gBrowser.pinnedTabsContainer;
    return !!ptc && tab.parentNode === ptc;
  }

  /** Move a row to the DOM position matching the tab's index in gBrowser.tabs.
   *  Pinned and unpinned tabs live in separate containers, so we anchor only
   *  against same-pinned-state siblings. Returns true if the row was moved. */
  function placeRowInFirefoxOrder(tab: Tab, row: Row): boolean {
    if (!row || !state.panel) return false;
    const tabsArr = [...gBrowser.tabs] as Tab[];
    const myIdx = tabsArr.indexOf(tab);
    if (myIdx < 0) return false;

    if (isFxPinned(tab)) {
      let prevTab: Tab | null = null;
      for (let i = myIdx - 1; i >= 0; i--) {
        if (isFxPinned(tabsArr[i]!)) { prevTab = tabsArr[i]!; break; }
      }
      if (prevTab) {
        const prevRow = rowOf.get(prevTab);
        if (!prevRow || prevRow === row) return false;
        if (prevRow.nextElementSibling !== row) { prevRow.after(row); return true; }
      } else if (state.pinnedContainer.firstChild !== row) {
        state.pinnedContainer.insertBefore(row, state.pinnedContainer.firstChild);
        return true;
      }
      return false;
    }

    let prevTab: Tab | null = null;
    for (let i = myIdx - 1; i >= 0; i--) {
      if (!isFxPinned(tabsArr[i]!)) { prevTab = tabsArr[i]!; break; }
    }
    if (prevTab) {
      const prevRow = rowOf.get(prevTab);
      if (!prevRow || prevRow === row) return false;
      const prevSubtree = subtreeRows(prevRow);
      const anchor = prevSubtree[prevSubtree.length - 1]!;
      if (anchor.nextElementSibling !== row) { anchor.after(row); return true; }
    } else if (state.panel.firstChild !== row) {
      state.panel.insertBefore(row, state.panel.firstChild);
      return true;
    }
    return false;
  }

  /** Position a restored row: after its original prev sibling (if that sibling
   *  still exists under the same parent), else as first child of the parent /
   *  top of root, else at end of the parent's subtree / end of the panel. */
  function placeRestoredRow(row: Row, parent: Tab | null, prevSiblingId: number | null | undefined): void {
    const parentRow = parent ? rowOf.get(parent) : null;

    if (prevSiblingId) {
      const sib = tabById(prevSiblingId);
      const sibRow = sib ? rowOf.get(sib) : null;
      const sibParent = sib ? parentOfTab(sib) : null;
      const sameParent =
        (!parent && !sibParent)
        || (!!parent && !!sibParent && treeData(parent).id === treeData(sibParent).id);
      if (sibRow && sameParent) {
        const st = subtreeRows(sibRow);
        st[st.length - 1]!.after(row);
        return;
      }
      // prev sibling gone — fall through to subtree-end fallback
    } else {
      if (parentRow) { parentRow.after(row); return; }
      state.panel.insertBefore(row, state.panel.firstChild);
      return;
    }

    if (parentRow) {
      const st = subtreeRows(parentRow);
      st[st.length - 1]!.after(row);
    } else {
      state.panel.insertBefore(row, state.spacer);
    }
  }

  // ---------- event handlers ------------------------------------------------

  function onTabOpen(e: Event): void {
    const tab = (e.target as Tab);
    const td = treeData(tab);

    // Session-restore path: match this tab to a leftover saved node.
    const prior = popSavedForTab(tab);
    if (prior) {
      const idx = [...gBrowser.tabs].indexOf(tab);
      console.log(`palefox-tabs: onTabOpen matched — tab[${idx}] url="${tabUrl(tab)}" → saved id=${prior.id} parentId=${prior.parentId} origIdx=${prior._origIdx}`);
      applySavedToTab(tab, prior);
      const row = rows.createTabRow(tab);
      if (tab.pinned) {
        state.pinnedContainer.appendChild(row);
        state.pinnedContainer.hidden = false;
      } else {
        state.panel.insertBefore(row, state.spacer);
      }
      if (vim.consumePendingCursorMove()) vim.setCursor(row);
      rows.updateVisibility();
      scheduleSave();
      return;
    }

    // "root" (default) → parentId null
    // "child"  → parentId = opener / selected
    // "sibling"→ parentId = parent of opener / selected
    const position = Services.prefs.getCharPref("pfx.tabs.newTabPosition", "root");
    const anchor = tab.owner || (gBrowser.selectedTab !== tab ? gBrowser.selectedTab : null);

    if (position === "child" && anchor) {
      td.parentId = treeData(anchor).id;
    } else if (position === "sibling" && anchor) {
      td.parentId = treeData(anchor).parentId;
    }

    const row = rows.createTabRow(tab);
    if (tab.pinned) {
      state.pinnedContainer.appendChild(row);
      state.pinnedContainer.hidden = false;
    } else {
      state.panel.insertBefore(row, state.spacer);
      placeRowInFirefoxOrder(tab, row);
    }

    if (position === "root") {
      const tabsArr = [...gBrowser.tabs];
      const lastIdx = tabsArr.length - 1;
      if (tabsArr.indexOf(tab) !== lastIdx) {
        try { gBrowser.moveTabTo(tab, { tabIndex: lastIdx }); } catch {}
      }
    }

    // Cursor-follow on Ctrl+T / click-+ is handled by onTabSelect, which
    // fires AFTER TabOpen (gBrowser.selectedTab is stale during TabOpen).
    if (vim.consumePendingCursorMove()) vim.setCursor(row);
    rows.scheduleTreeResync();
    scheduleSave();
  }

  function onTabClose(e: Event): void {
    const tab = (e.target as Tab);
    const row = rowOf.get(tab);

    if (row) {
      const td = treeData(tab);
      rememberClosedTab(tab, td);

      // Reparent direct children to the closing tab's parent (promote one level).
      // Groups in our subtree keep their stored level decremented (transitional).
      const closingId = td.id;
      const newParentId = td.parentId ?? null;
      const myLevel = levelOf(tab);
      let next = row.nextElementSibling;
      while (next && next !== state.spacer) {
        if (next._tab) {
          const ntd = treeData(next._tab);
          if (levelOf(next._tab) <= myLevel) break;
          if (ntd.parentId === closingId) {
            ntd.parentId = newParentId;
            rows.syncTabRow(next._tab);
          }
        } else if (next._group) {
          const gLv = next._group.level || 0;
          if (gLv <= myLevel) break;
          next._group.level = Math.max(0, gLv - 1);
          rows.syncGroupRow(next as Row);
        }
        next = next.nextElementSibling;
      }

      if (state.cursor === row) vim.moveCursor(1) || vim.moveCursor(-1);
      row.remove();
    }
    rowOf.delete(tab);
    if (!state.pinnedContainer.querySelector(".pfx-tab-row")) {
      state.pinnedContainer.hidden = true;
    }
    rows.updateVisibility();
    scheduleSave();
  }

  function onTabPinned(e: Event): void {
    const tab = (e.target as Tab);
    const row = rowOf.get(tab);
    if (!row) return;
    const td = treeData(tab);
    // Drop parentId only if the parent isn't (or can't be) pinned — otherwise
    // we'd visually orphan ourselves across the divider. Groups can't be pinned.
    if (td.parentId != null) {
      if (typeof td.parentId === "string") {
        td.parentId = null;
      } else {
        const parent = tabById(td.parentId);
        if (!parent || !parent.pinned) td.parentId = null;
      }
    }
    // Cascade-pin direct children so the subtree follows. Each child's own
    // TabPinned event recurses into its grandkids.
    const kids: Tab[] = [];
    for (const t of gBrowser.tabs as Iterable<Tab>) {
      if (!t.pinned && treeData(t).parentId === td.id) kids.push(t);
    }
    for (const kid of kids) gBrowser.pinTab(kid);

    row.removeAttribute("style");
    if (row.parentNode !== state.pinnedContainer) {
      state.pinnedContainer.appendChild(row);
      placeRowInFirefoxOrder(tab, row);
    }
    state.pinnedContainer.hidden = false;
    rows.syncTabRow(tab);
    for (const r of allRows()) rows.syncAnyRow(r);
    rows.updateVisibility();
    scheduleSave();
  }

  function onTabUnpinned(e: Event): void {
    const tab = (e.target as Tab);
    const row = rowOf.get(tab);
    if (!row) return;
    const td = treeData(tab);
    // Symmetric: if our parent stayed pinned, drop the link so we don't
    // visually orphan across the divider.
    if (td.parentId != null && typeof td.parentId === "number") {
      const parent = tabById(td.parentId);
      if (parent && parent.pinned) td.parentId = null;
    }
    // Cascade-unpin direct children so the subtree comes with us.
    const kids: Tab[] = [];
    for (const t of gBrowser.tabs as Iterable<Tab>) {
      if (t.pinned && treeData(t).parentId === td.id) kids.push(t);
    }
    for (const kid of kids) gBrowser.unpinTab(kid);

    row.draggable = true;
    if (row.parentNode !== state.panel) {
      state.panel.insertBefore(row, state.spacer);
      placeRowInFirefoxOrder(tab, row);
    }
    rows.syncTabRow(tab);
    if (!state.pinnedContainer.querySelector(".pfx-tab-row")) {
      state.pinnedContainer.hidden = true;
    }
    rows.updateVisibility();
    scheduleSave();
  }

  /** Fires when SessionStore restores a tab. Two jobs:
   *    1. closedTabs path — full restore with hierarchy if URL matches.
   *    2. Correction path — fix wrong saved state assigned by onTabOpen's
   *       index-blindspot when arrival order differed from saved order. */
  function onTabRestoring(e: Event): void {
    const tab = (e.target as Tab);
    const url = tabUrl(tab);
    const idx = [...gBrowser.tabs].indexOf(tab);
    log("onTabRestoring", {
      idx, url,
      currentId: treeOf.get(tab)?.id,
      currentParentId: treeOf.get(tab)?.parentId,
      queueLen: savedTabQueue.length,
    });

    const entry = popClosedEntry(url);
    if (!entry) {
      // Correction path — only for tabs that didn't get FIFO-assigned data.
      const td = treeData(tab);
      if (td.appliedSavedState) return;
      const correction = popSavedByUrl(url);
      if (correction) {
        log("onTabRestoring:correction", {
          idx, url,
          savedId: correction.id, savedParentId: correction.parentId,
          parentResolvesTo: tabById(correction.parentId)?.label,
        });
        td.id = correction.id || td.id;
        td.parentId = correction.parentId ?? null;
        td.name = correction.name || null;
        td.state = correction.state || null;
        td.collapsed = !!correction.collapsed;
        td.appliedSavedState = true;
        pinTabId(tab, td.id);
        rows.scheduleTreeResync();
        scheduleSave();
      }
      return;
    }

    const td = treeData(tab);
    td.id = entry.id;
    td.name = entry.name ?? null;
    td.state = entry.state ?? null;
    td.collapsed = entry.collapsed ?? false;
    pinTabId(tab, td.id);
    td.parentId = entry.parentId ?? null;
    const parent = tabById(entry.parentId);

    const row = rowOf.get(tab);
    if (row) {
      placeRestoredRow(row, parent, entry.prevSiblingId);
      // Re-nest any ex-direct-children that onTabClose had promoted.
      if (entry.descendantIds?.length) {
        const expected = new Set(entry.descendantIds);
        const oldParentId = entry.parentId ?? null;
        let n = row.nextElementSibling;
        while (n && n !== state.spacer) {
          if (!n._tab) break;
          const ntd = treeData(n._tab);
          if (!expected.has(ntd.id)) break;
          if (ntd.parentId === oldParentId) {
            ntd.parentId = td.id;
          }
          n = n.nextElementSibling;
        }
      }
      rows.scheduleTreeResync();
    }
    rows.updateVisibility();
    scheduleSave();
  }

  function onTabSelect(): void {
    for (const tab of gBrowser.tabs as Iterable<Tab>) {
      const row = rowOf.get(tab);
      if (row) row.toggleAttribute("selected", tab.selected);
    }
    const row = rowOf.get(gBrowser.selectedTab);
    if (row && !state.cursor) {
      row.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    // Vim cursor follows selection. Without this, opening a new tab
    // (Ctrl+T) or clicking a different tab leaves the [pfx-cursor]
    // outline on the previously-cursor'd row while [selected] moves to
    // the new row — two visual indicators on different tabs. Note vim
    // panel-mode `j`/`k` does NOT fire TabSelect (cursor moves without
    // selecting), so this rule doesn't override that intentional decoupling.
    if (row && state.cursor !== row) {
      vim.setCursor(row);
    }
    if (isHorizontal()) rows.updateHorizontalGrid();
  }

  function onTabAttrModified(e: Event): void {
    rows.syncTabRow(e.target as Tab);
  }

  function onTabMove(e: Event): void {
    const tab = (e.target as Tab);
    const row = rowOf.get(tab);
    if (!row) return;
    const moved = placeRowInFirefoxOrder(tab, row);
    if (moved && !movingTabs.has(tab)) {
      rows.scheduleTreeResync();
      scheduleSave();
    }
  }

  // ---------- install / teardown -------------------------------------------

  function install(): () => void {
    const tc = gBrowser.tabContainer;
    tc.addEventListener("TabOpen", onTabOpen);
    tc.addEventListener("TabClose", onTabClose);
    tc.addEventListener("TabSelect", onTabSelect);
    tc.addEventListener("TabAttrModified", onTabAttrModified);
    tc.addEventListener("TabMove", onTabMove);
    tc.addEventListener("SSTabRestoring", onTabRestoring);
    tc.addEventListener("TabPinned", onTabPinned);
    tc.addEventListener("TabUnpinned", onTabUnpinned);

    // Session-restore signals at the window level. After any session restore
    // (startup auto-restore or Ctrl+Shift+T window restore), fire a final
    // tree resync — Firefox creates session tabs asynchronously, so a
    // resync here guarantees a clean pass once everything is in gBrowser.tabs.
    const onSessionRestored = (): void => {
      console.log("palefox-tabs: sessionstore-windows-restored — final tree resync");
      log("sessionstore-windows-restored", {
        queueLen: savedTabQueue.length,
        inSessionRestore: state.inSessionRestore,
      });
      savedTabQueue.length = 0;
      state.inSessionRestore = false;
      rows.scheduleTreeResync();
    };
    Services.obs.addObserver(onSessionRestored, "sessionstore-windows-restored");

    const onManualRestore = (): void => {
      const aliveUrls = new Set(
        [...gBrowser.tabs].map((t: Tab) => tabUrl(t)).filter((u: string) => u && u !== "about:blank"),
      );
      savedTabQueue.length = 0;
      state.lastLoadedNodes.forEach((s, i) => {
        if (s.url && aliveUrls.has(s.url)) return;
        savedTabQueue.push({ ...s, _origIdx: i });
      });
      state.inSessionRestore = true;
      log("manualRestoreArmed", {
        queueLen: savedTabQueue.length,
        queueIds: savedTabQueue.map(s => s.id),
      });
    };
    Services.obs.addObserver(onManualRestore, "sessionstore-initiating-manual-restore");

    return () => {
      try { Services.obs.removeObserver(onSessionRestored, "sessionstore-windows-restored"); } catch {}
      try { Services.obs.removeObserver(onManualRestore, "sessionstore-initiating-manual-restore"); } catch {}
    };
  }

  return { install };
}
