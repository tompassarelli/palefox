// Legacy port from chrome/JS/palefox-tabs.uc.js — being incrementally split
// into modules in src/tabs/*.ts. Not @ts-nocheck'd: we lean on tsc to catch
// unbound references after each refactor pass.
// split into modules incrementally. The build wraps the file in IIFE; the
// existing init() bootstrap at the bottom handles delayed startup. Module
// scope is fine because top-level code below has no `return`s outside of
// nested functions.

import { createLogger } from "./log.ts";
import { INDENT, SAVE_FILE, CHORD_TIMEOUT, CLOSED_MEMORY, PIN_ATTR } from "./constants.ts";
import type { Row, SavedNode, Tab, TreeData } from "./types.ts";
import {
  state,
  treeOf, rowOf, hzDisplay, savedTabQueue, closedTabs,
  selection, movingTabs,
} from "./state.ts";
import {
  makeSaver,
  readTreeFromDisk,
  popSavedByUrl as popQueueByUrl,
  popSavedForTab as popQueueForTab,
  type Snapshot,
} from "./persist.ts";
import { makeDrag } from "./drag.ts";
import { buildContextMenu } from "./menu.ts";
import { makeRows } from "./rows.ts";
import { makeLayout } from "./layout.ts";
import { makeVim } from "./vim.ts";
import {
  SS, tryRegisterPinAttr, pinTabId, readPinnedId,
  treeData, tabById, parentOfTab, levelOf, levelOfRow, dataOf,
  allTabs, allRows, hasChildren, subtreeRows, isHorizontal,
  tabUrl,
} from "./helpers.ts";

const pfxLog = createLogger("tabs");

  // (constants moved to ./constants.ts)

  // --- DOM references ---

  // Cast non-null; the early return below validates at runtime. Keeping the
  // type as HTMLElement (instead of HTMLElement | null) means inner functions
  // don't all need their own null checks across closure boundaries.
  const sidebarMain = document.getElementById("sidebar-main") as HTMLElement;
  // The build wraps this file in an IIFE, so this top-level `return` is
  // actually inside the function. TS doesn't see the wrapper.
  // @ts-expect-error TS1108 — intentional early-out from the IIFE.
  if (!sidebarMain) return;

  // (debug log moved to ./log.ts; pfxLog imported above)

  // --- State ---
  // (treeOf, rowOf, hzDisplay imported from ./state.ts)
  // (state.panel, state.spacer, state.pinnedContainer, state.contextTab,
  //  state.cursor, state.nextTabId all live in the imported `state` object)
  // (vim chord state, modeline, search/refile, cursor handoff — all in ./vim.ts)

  // (selection and movingTabs imported from ./state.ts)

  // (closedTabs imported from ./state.ts; capped by CLOSED_MEMORY constant)

  // (savedTabQueue imported from ./state.ts — ordered queue of saved-tab nodes
  // left over from last session's tree file. Session-restore tabs arriving later
  // via onTabOpen consume entries from this queue.)
  let _lastLoadedNodes: SavedNode[] = [];   // snapshot of last load's tabNodes; consumed by onManualRestore
  let _inSessionRestore = true;

  // Pin a tab's palefox id via SessionStore so it survives browser restart /
  // undoCloseTab / undoCloseWindow. Lets us match live tabs → saved state
  // exactly by id, bypassing URL-comparison fragility for pending tabs.
  // SessionStore.setTabValue/getTabValue aren't exposed on the SessionStore
  // object we can reach from chrome scripts in this Firefox build. Pin via
  // a DOM attribute instead — Firefox's SessionStore tracks a small set of
  // tab attributes via persistTabAttribute. If we can register ours there we
  // get free cross-session persistence; otherwise this is a no-op and we
  // rely on URL matching. (PIN_ATTR in ./constants.ts)
  // --- Selection ---

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


  // Pop the most-recent closed-tab entry matching this URL (LIFO).
  function popClosedEntry(url) {
    if (!url) return null;
    for (let i = closedTabs.length - 1; i >= 0; i--) {
      if (closedTabs[i].url === url) return closedTabs.splice(i, 1)[0];
    }
    return null;
  }

  // Apply a saved-state entry to a tab's treeData and re-sync every row.
  // Full sweep is needed because `levelOf(tab)` derives depth from the
  // parentId chain; when this tab's id becomes canonical (or its parentId
  // updates), descendants' displayed levels may change.
  //
  // Idempotent: once a tab has received its saved state, later calls (e.g.
  // via a spurious SSTabRestoring on activation when a stale queue entry
  // happens to match the tab's URL) are no-ops. Prevents the focus-flatten
  // regression where a leftover queue entry with a matching URL was
  // applying wrong parentId over the correct one.
  function applySavedToTab(tab, prior) {
    const td = treeData(tab);
    if (td.appliedSavedState) return;
    td.appliedSavedState = true;
    td.id = prior.id || td.id;
    td.parentId = prior.parentId ?? null;
    td.name = prior.name || null;
    td.state = prior.state || null;
    td.collapsed = !!prior.collapsed;
    pinTabId(tab, td.id);
    pfxLog("applySavedToTab", { id: td.id, parentId: td.parentId, priorId: prior.id, priorParentId: prior.parentId });
    Rows.scheduleTreeResync();
  }


  function onTabOpen(e) {
    const tab = e.target;
    const td = treeData(tab);

    // Session-restore path: match this tab to a leftover saved node. Exact
    // URL when resolvable; positional blindspot (queue-head) for pending
    // session-restored tabs whose URL hasn't materialized yet.
    const prior = popSavedForTab(tab);
    if (prior) {
      const idx = [...gBrowser.tabs].indexOf(tab);
      console.log(`palefox-tabs: onTabOpen matched — tab[${idx}] url="${tabUrl(tab)}" → saved id=${prior.id} parentId=${prior.parentId} origIdx=${prior._origIdx}`);
      applySavedToTab(tab, prior);
      const row = Rows.createTabRow(tab);
      if (tab.pinned && state.pinnedContainer) {
        state.pinnedContainer.appendChild(row);
        state.pinnedContainer.hidden = false;
      } else {
        state.panel.insertBefore(row, state.spacer);
      }
      if (vim.consumePendingCursorMove()) vim.setCursor(row);
      Rows.updateVisibility();
      scheduleSave();
      return;
    }

    // "root" (default) → parentId null (top-level)
    // "child"  → parentId = opener / selected (becomes child)
    // "sibling"→ parentId = parent of (opener / selected)
    const position = Services.prefs.getCharPref("pfx.tabs.newTabPosition", "root");
    const anchor = tab.owner || (gBrowser.selectedTab !== tab ? gBrowser.selectedTab : null);

    if (position === "child" && anchor) {
      td.parentId = treeData(anchor).id;
    } else if (position === "sibling" && anchor) {
      td.parentId = treeData(anchor).parentId;
    }
    // "root" leaves parentId at null

    // Create the row and align its DOM position with Firefox's tab index.
    // For the "root" pref, also ask Firefox to put the tab at the end of the
    // strip; the TabMove it fires re-aligns us there.
    const row = Rows.createTabRow(tab);
    if (tab.pinned && state.pinnedContainer) {
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

    if (vim.consumePendingCursorMove()) vim.setCursor(row);
    Rows.scheduleTreeResync();
    scheduleSave();
  }

  function onTabClose(e) {
    const tab = e.target;
    const row = rowOf.get(tab);

    if (row) {
      const td = treeData(tab);

      // Snapshot identity + parent before we mutate the state.panel, so we can restore on reopen.
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
            Rows.syncTabRow(next._tab);
          }
        } else if (next._group) {
          const gLv = next._group.level || 0;
          if (gLv <= myLevel) break;
          next._group.level = Math.max(0, gLv - 1);
          Rows.syncGroupRow(next as Row);
        }
        next = next.nextElementSibling;
      }

      if (state.cursor === row) vim.moveCursor(1) || vim.moveCursor(-1);
      row.remove();
    }
    rowOf.delete(tab);
    Rows.updateVisibility();
    scheduleSave();
  }

  function onTabPinned(e) {
    const tab = e.target;
    const row = rowOf.get(tab);
    if (!row || !state.pinnedContainer) return;
    const td = treeData(tab);
    const pinnedId = td.id;
    td.parentId = null;
    // Promote any direct children of this tab to root (pinned tabs can't have children).
    for (const t of gBrowser.tabs) {
      if (treeData(t).parentId === pinnedId) treeData(t).parentId = null;
    }
    row.removeAttribute("style");
    // TabMove fires before TabPinned (during pinTab) and may have already
    // routed the row to state.pinnedContainer at the right position. Only fix up
    // if needed.
    if (row.parentNode !== state.pinnedContainer) {
      state.pinnedContainer.appendChild(row);
      placeRowInFirefoxOrder(tab, row);
    }
    state.pinnedContainer.hidden = false;
    Rows.syncTabRow(tab);
    for (const r of allRows()) Rows.syncAnyRow(r);
    Rows.updateVisibility();
    scheduleSave();
  }

  function onTabUnpinned(e) {
    const tab = e.target;
    const row = rowOf.get(tab);
    if (!row) return;
    row.draggable = true;
    // TabMove fires before TabUnpinned and (with the pinned-aware
    // placeRowInFirefoxOrder) already placed the row in state.panel. Catch the
    // case where the row is somehow still in state.pinnedContainer.
    if (row.parentNode !== state.panel) {
      state.panel.insertBefore(row, state.spacer);
      placeRowInFirefoxOrder(tab, row);
    }
    Rows.syncTabRow(tab);
    if (!state.pinnedContainer.querySelector(".pfx-tab-row")) {
      state.pinnedContainer.hidden = true;
    }
    Rows.updateVisibility();
    scheduleSave();
  }

  // Thin shims over ./persist.ts so call sites stay terse. Persist's
  // popSaved* fns take the queue + a context object; we pre-bind here.
  function popSavedByUrl(url) { return popQueueByUrl(savedTabQueue, url); }
  function popSavedForTab(tab) {
    return popQueueForTab(savedTabQueue, {
      currentIdx: [...gBrowser.tabs].indexOf(tab),
      pinnedId: readPinnedId(tab),
      url: tabUrl(tab),
      inSessionRestore: _inSessionRestore,
      log: pfxLog,
    });
  }

  // Fires when SessionStore restores a tab (activation of a lazy tab, or
  // mid-session undoCloseTab). Two jobs here:
  //
  // 1. closedTabs path: if URL matches a mid-session-closed entry, full
  //    restore with hierarchy (position + re-nest descendants).
  //
  // 2. Correction path: the tab's URL is now known. If savedTabQueue still
  //    has an entry with THIS URL, that means onTabOpen's index-based
  //    blindspot gave this tab the WRONG saved state (e.g. session-restore
  //    arrival order differed from saved order, or an intermediate tab
  //    shifted indices). The still-in-queue entry is the right one — swap.
  function onTabRestoring(e) {
    const tab = e.target;
    const url = tabUrl(tab);
    const idx = [...gBrowser.tabs].indexOf(tab);
    pfxLog("onTabRestoring", { idx, url, currentId: treeOf.get(tab)?.id, currentParentId: treeOf.get(tab)?.parentId, queueLen: savedTabQueue.length });

    const entry = popClosedEntry(url);
    if (!entry) {
      // Correction path — only for tabs that didn't get FIFO-assigned data.
      // FIFO sets appliedSavedState; if set, the assignment is authoritative
      // and stale queue entries must not overwrite it.
      const td = treeData(tab);
      if (td.appliedSavedState) return;
      const correction = popSavedByUrl(url);
      if (correction) {
        pfxLog("onTabRestoring:correction", { idx, url, savedId: correction.id, savedParentId: correction.parentId, parentResolvesTo: tabById(correction.parentId)?.label });
        td.id = correction.id || td.id;
        td.parentId = correction.parentId ?? null;
        td.name = correction.name || null;
        td.state = correction.state || null;
        td.collapsed = !!correction.collapsed;
        td.appliedSavedState = true;
        pinTabId(tab, td.id);
        Rows.scheduleTreeResync();
        scheduleSave();
      }
      return;
    }

    const td = treeData(tab);
    td.id = entry.id;              // carry id forward so descendants can still find this tab
    td.name = entry.name ?? null;
    td.state = entry.state ?? null;
    td.collapsed = entry.collapsed ?? false;
    pinTabId(tab, td.id);

    // Restore parentId directly. parentOfTab() will resolve it via tabById at
    // read time; if the original parent is gone the tab sits at root.
    td.parentId = entry.parentId ?? null;
    const parent = tabById(entry.parentId);

    // Move this tab's row to its restored position.
    const row = rowOf.get(tab);
    if (row) {
      placeRestoredRow(row, parent, entry.prevSiblingId);
      // Re-nest any ex-direct-children that onTabClose had reparented to the
      // grandparent. Only re-nest those currently pointing at our old parent.
      // Anything moved elsewhere by the user is left alone.
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
      Rows.scheduleTreeResync();
    }
    Rows.updateVisibility();
    scheduleSave();
  }

  // Position a restored row: after its original prev sibling (if that sibling
  // still exists under the same parent), else as first child of the parent /
  // top of the root, else at end of the parent's subtree / end of the state.panel.
  function placeRestoredRow(row, parent, prevSiblingId) {
    const parentRow = parent ? rowOf.get(parent) : null;

    if (prevSiblingId) {
      const sib = tabById(prevSiblingId);
      const sibRow = sib ? rowOf.get(sib) : null;
      const sibParent = sib ? parentOfTab(sib) : null;
      const sameParent =
        (!parent && !sibParent) ||
        (parent && sibParent && treeData(parent).id === treeData(sibParent).id);
      if (sibRow && sameParent) {
        const st = subtreeRows(sibRow);
        st[st.length - 1].after(row);
        return;
      }
      // prev sibling gone — fall through to subtree-end fallback
    } else {
      // Was the first child / first root: insert at the top of its level
      if (parentRow) { parentRow.after(row); return; }
      state.panel.insertBefore(row, state.panel.firstChild);
      return;
    }

    // Fallback: append to end of parent's subtree, or end of state.panel
    if (parentRow) {
      const st = subtreeRows(parentRow);
      st[st.length - 1].after(row);
    } else {
      state.panel.insertBefore(row, state.spacer);
    }
  }

  // Snapshot a closing tab's identity, position, and descendants so
  // onTabRestoring can put it back in the same slot with children re-nested.
  function rememberClosedTab(tab, td) {
    const url = tabUrl(tab);
    if (!url || url === "about:blank") return;
    const row = rowOf.get(tab);
    if (!row) return;

    const parent = parentOfTab(tab);
    const myLevel = levelOf(tab);

    // Walk backwards for previous sibling.
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

    // Walk forwards for descendants (anything below us with a higher level).
    // onTabClose promotes these one level up; we'll re-demote on restore.
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

  function onTabSelect() {
    for (const tab of gBrowser.tabs) {
      const row = rowOf.get(tab);
      if (row) row.toggleAttribute("selected", tab.selected);
    }
    const row = rowOf.get(gBrowser.selectedTab);
    if (row && !state.cursor) row.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (isHorizontal()) Rows.updateHorizontalGrid();
  }

  function onTabAttrModified(e) { Rows.syncTabRow(e.target); }

  // True iff Firefox considers this tab pinned right now. During pinTab(),
  // the tab is moved into pinnedTabsContainer BEFORE the `pinned` attribute
  // is set (and TabMove fires inside that window) — so tab.pinned alone
  // isn't enough to classify it.
  function isFxPinned(tab) {
    if (tab.pinned) return true;
    const ptc = gBrowser.tabContainer?.pinnedTabsContainer
              || gBrowser.pinnedTabsContainer;
    return !!ptc && tab.parentNode === ptc;
  }

  // Move a row to the DOM position matching the tab's index in gBrowser.tabs.
  // Pinned and unpinned tabs live in separate containers (state.pinnedContainer
  // vs state.panel), so we anchor only against same-pinned-state siblings.
  // Returns true if the row was moved; false if already in place.
  function placeRowInFirefoxOrder(tab, row) {
    if (!row || !state.panel) return false;
    const tabsArr = [...gBrowser.tabs];
    const myIdx = tabsArr.indexOf(tab);
    if (myIdx < 0) return false;

    // Pinned tabs: reorder within state.pinnedContainer.
    if (isFxPinned(tab)) {
      if (!state.pinnedContainer) return false;
      let prevTab = null;
      for (let i = myIdx - 1; i >= 0; i--) {
        if (isFxPinned(tabsArr[i])) { prevTab = tabsArr[i]; break; }
      }
      if (prevTab) {
        const prevRow = rowOf.get(prevTab);
        if (!prevRow || prevRow === row) return false;
        if (prevRow.nextElementSibling !== row) { prevRow.after(row); return true; }
      } else if (state.pinnedContainer.firstChild !== row) {
        state.pinnedContainer.insertBefore(row, state.pinnedContainer.firstChild); return true;
      }
      return false;
    }

    // Unpinned tabs: place in state.panel, skipping pinned tabs as anchors.
    let prevTab = null;
    for (let i = myIdx - 1; i >= 0; i--) {
      if (!isFxPinned(tabsArr[i])) { prevTab = tabsArr[i]; break; }
    }
    if (prevTab) {
      const prevRow = rowOf.get(prevTab);
      if (!prevRow || prevRow === row) return false;
      const prevSubtree = subtreeRows(prevRow);
      const anchor = prevSubtree[prevSubtree.length - 1];
      if (anchor.nextElementSibling !== row) { anchor.after(row); return true; }
    } else if (state.panel.firstChild !== row) {
      state.panel.insertBefore(row, state.panel.firstChild); return true;
    }
    return false;
  }

  // Whenever Firefox reorders a tab, keep the palefox state.panel in sync.
  // If palefox itself initiated the move (tab is in `movingTabs`), we still
  // align the DOM row, but defer resync + save to the end-of-batch cleanup
  // in executeDrop so we don't re-render during Firefox's busy animation.
  function onTabMove(e) {
    const tab = e.target;
    const moved = placeRowInFirefoxOrder(tab, rowOf.get(tab));
    if (moved && !movingTabs.has(tab)) {
      Rows.scheduleTreeResync();
      scheduleSave();
    }
  }

  // --- Persistence ---

  // Write-on-every-change: pulls a fresh snapshot for every flush, coalesces
  // overlapping schedules. Implementation in ./persist.ts; the closure here
  // just supplies live state.
  const scheduleSave = makeSaver(() => ({
    tabs: [...gBrowser.tabs],
    rows: () => allRows(),
    savedTabQueue,
    closedTabs,
    nextTabId: state.nextTabId,
    tabUrl,
    treeData,
  }));

  // drag ↔ Rows ↔ vim form a small cycle of mutual deps:
  //   - rows needs drag.setupDrag (each row gets DnD wired) AND vim's row-
  //     action handlers (activateVim, cloneAsChild, startRename, selectRange)
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
    cloneAsChild:   (tab) => vim.cloneAsChild(tab),
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
  });

  async function loadFromDisk() {
    const parsed = await readTreeFromDisk();
    if (!parsed) return;
    try {
      if (parsed.nextTabId != null) state.nextTabId = parsed.nextTabId;
      closedTabs.length = 0;
      closedTabs.push(...parsed.closedTabs);

      const tabs = allTabs();
      const tabNodes = parsed.tabNodes.map(s => ({ ...s }));
      _lastLoadedNodes = tabNodes.map(s => ({ ...s }));

      // Belt-and-suspenders: advance state.nextTabId past every saved node ID before
      // any tab calls treeData(). saved.nextTabId covers this normally, but if
      // it was missing/stale, fresh startup tabs (localhost, etc.) would get an
      // ID that collides with a restored session tab's pfx-id attribute, causing
      // the wrong tab to resolve as parent in the tree.
      for (const s of tabNodes) {
        if (s.id && s.id >= state.nextTabId) state.nextTabId = s.id + 1;
      }
      pfxLog("loadFromDisk", { nextTabId: state.nextTabId, savedNextTabId: parsed.nextTabId, tabNodes: tabNodes.length, liveTabs: tabs.length, tabNodeIds: tabNodes.map(s => s.id), liveTabPfxIds: tabs.map(t => t.getAttribute?.("pfx-id") || 0) });

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
      loadedNodes = parsed.nodes;
    } catch (e) {
      console.error("palefox-tabs: loadFromDisk apply error", e);
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
    await loadFromDisk();
    await new Promise((r) => requestAnimationFrame(r));

    state.pinnedContainer = document.createXULElement("hbox");
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
    vim.createModeline();
    vim.setupVimKeys();
    vim.focusPanel();

    const tc = gBrowser.tabContainer;
    tc.addEventListener("TabOpen", onTabOpen);
    tc.addEventListener("TabClose", onTabClose);
    tc.addEventListener("TabSelect", onTabSelect);
    tc.addEventListener("TabAttrModified", onTabAttrModified);
    tc.addEventListener("TabMove", onTabMove);
    tc.addEventListener("SSTabRestoring", onTabRestoring);
    tc.addEventListener("TabPinned", onTabPinned);
    tc.addEventListener("TabUnpinned", onTabUnpinned);

    // Click on state.spacer activates vim with last row
    state.spacer.addEventListener("click", () => {
      const rows = allRows().filter(r => !r.hidden);
      if (rows.length) vim.activateVim(rows[rows.length - 1]!);
    });

    // Clicking content area blurs the state.panel naturally via the blur listener.

    // After any session restore (startup auto-restore or Ctrl+Shift+T manual
    // restore), fire a final tree resync. Rows.scheduleTreeResync() defers via
    // Promise microtask — if Firefox creates session tabs asynchronously across
    // multiple tasks, the per-TabOpen microtask resolves parentId chains before
    // all tabs exist. A resync here guarantees a clean pass once everything
    // is in gBrowser.tabs. One-shot: remove after first fire.
    const onSessionRestored = () => {
      console.log("palefox-tabs: sessionstore-windows-restored — final tree resync");
      pfxLog("sessionstore-windows-restored", { queueLen: savedTabQueue.length, inSessionRestore: _inSessionRestore });
      savedTabQueue.length = 0;
      _inSessionRestore = false;
      Rows.scheduleTreeResync();
    };
    Services.obs.addObserver(onSessionRestored, "sessionstore-windows-restored");

    const onManualRestore = () => {
      const aliveUrls = new Set(
        [...gBrowser.tabs].map(t => tabUrl(t)).filter(u => u && u !== "about:blank")
      );
      savedTabQueue.length = 0;
      _lastLoadedNodes.forEach((s, i) => {
        if (s.url && aliveUrls.has(s.url)) return;
        savedTabQueue.push({ ...s, _origIdx: i });
      });
      _inSessionRestore = true;
      pfxLog("manualRestoreArmed", { queueLen: savedTabQueue.length, queueIds: savedTabQueue.map(s => s.id) });
    };
    Services.obs.addObserver(onManualRestore, "sessionstore-initiating-manual-restore");

    window.addEventListener("unload", () => {
      try { Services.obs.removeObserver(onSessionRestored, "sessionstore-windows-restored"); } catch {}
      try { Services.obs.removeObserver(onManualRestore, "sessionstore-initiating-manual-restore"); } catch {}
    }, { once: true });

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
