// Legacy port from chrome/JS/palefox-tabs.uc.js — being incrementally split
// into modules in src/tabs/*.ts. Not @ts-nocheck'd: we lean on tsc to catch
// unbound references after each refactor pass.
// split into modules incrementally. The build wraps the file in IIFE; the
// existing init() bootstrap at the bottom handles delayed startup. Module
// scope is fine because top-level code below has no `return`s outside of
// nested functions.

import { createLogger } from "./log.ts";
import { INDENT, SAVE_FILE, CHORD_TIMEOUT, CLOSED_MEMORY, PIN_ATTR } from "./constants.ts";
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
import {
  SS, tryRegisterPinAttr, pinTabId, readPinnedId,
  treeData, tabById, parentOfTab, levelOf, levelOfRow, dataOf,
  allTabs, allRows, hasChildren, subtreeRows, isHorizontal,
  tabUrl,
} from "./helpers.ts";

const pfxLog = createLogger("tabs");

  // (constants moved to ./constants.ts)

  // --- DOM references ---

  const sidebarMain = document.getElementById("sidebar-main");
  if (!sidebarMain) return;

  // (debug log moved to ./log.ts; pfxLog imported above)

  // --- State ---
  // (treeOf, rowOf, hzDisplay imported from ./state.ts)
  // (state.panel, state.spacer, state.pinnedContainer, state.contextTab,
  //  state.cursor, state.nextTabId all live in the imported `state` object)
  let groupCounter = 0;

  // Vim mode
  let chord = null;                 // pending chord key ("d", "g")
  let chordTimer = 0;
  let pendingCursorMove = false;    // move state.cursor to next new tab row

  // (selection and movingTabs imported from ./state.ts)

  // (closedTabs imported from ./state.ts; capped by CLOSED_MEMORY constant)

  // (savedTabQueue imported from ./state.ts — ordered queue of saved-tab nodes
  // left over from last session's tree file. Session-restore tabs arriving later
  // via onTabOpen consume entries from this queue.)
  let _lastLoadedNodes = [];   // snapshot of last load's tabNodes; consumed by onManualRestore
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
    if (!state.panel) return;
    while (state.panel.firstChild !== state.spacer) state.panel.firstChild.remove();
    if (state.pinnedContainer) {
      while (state.pinnedContainer.firstChild) state.pinnedContainer.firstChild.remove();
    }
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
      if (pendingCursorMove) { pendingCursorMove = false; setCursor(row); }
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

    if (pendingCursorMove) {
      pendingCursorMove = false;
      setCursor(row);
    }
    Rows.scheduleTreeResync();
    scheduleSave();
  }

  function onTabClose(e) {
    const tab = e.target;
    const row = rowOf.get(tab);

    if (row) {
      const td = dataOf(row);

      // Snapshot identity + parent before we mutate the state.panel, so we can restore on reopen.
      rememberClosedTab(tab, td);

      // Reparent direct children to the closing tab's parent (promote one level).
      // Groups in our subtree keep their stored level decremented (transitional).
      const closingId = td?.id;
      const newParentId = td?.parentId ?? null;
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
          Rows.syncGroupRow(next);
        }
        next = next.nextElementSibling;
      }

      if (state.cursor === row) moveCursor(1) || moveCursor(-1);
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
    for (const r of allRows()) syncAnyRow(r);
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
    td.name = entry.name;
    td.state = entry.state;
    td.collapsed = entry.collapsed;
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
    let prevSiblingId = null;
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
    const descendantIds = [];
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

  // --- Vim state.cursor ---

  // Track which tree is expanded in horizontal mode
  let hzExpandedRoot = null;

  function setCursor(row) {
    if (state.cursor) state.cursor.removeAttribute("pfx-cursor");
    state.cursor = row;
    if (row) {
      row.setAttribute("pfx-cursor", "true");
      row.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (isHorizontal()) updateHorizontalExpansion();
    }
  }

  // Find the level-0 ancestor of a row
  function treeRoot(row) {
    const rows = allRows();
    const idx = rows.indexOf(row);
    for (let i = idx; i >= 0; i--) {
      if (levelOfRow(rows[i]) === 0) return rows[i];
    }
    return row;
  }


  // Auto-expand the state.cursor's tree, collapse the previous one.
  // On collapse, the root shows the last selected tab's visuals.
  function collapseHzTree(root) {
    const d = dataOf(root);
    if (!d || !hasChildren(root)) return;

    // Set display override: show the selected tab's visuals on the root
    if (state.cursor && state.cursor._tab && state.cursor !== root) {
      const curRoot = treeRoot(state.cursor);
      if (curRoot === root) {
        hzDisplay.set(root, state.cursor._tab);
      }
    }

    d.collapsed = true;
    syncAnyRow(root);
    if (isHorizontal()) layout.setUrlbarTopLayer(true);
  }

  function expandHzTree(root) {
    const d = dataOf(root);
    if (!d || !hasChildren(root)) return;

    // Clear display override — show the real root tab
    hzDisplay.delete(root);

    d.collapsed = false;
    syncAnyRow(root);
    if (isHorizontal()) layout.setUrlbarTopLayer(false);
  }

  function updateHorizontalExpansion() {
    if (!state.cursor) return;
    const root = treeRoot(state.cursor);
    if (root === hzExpandedRoot) return;

    // Collapse previous tree
    if (hzExpandedRoot) collapseHzTree(hzExpandedRoot);

    // Expand new tree
    expandHzTree(root);

    hzExpandedRoot = root;
    Rows.updateVisibility();
  }

  // Move to next/previous level-0 tab (column navigation)
  function moveToLevel0(delta) {
    if (!state.cursor) return false;
    const rows = allRows();
    const curIdx = rows.indexOf(state.cursor);
    if (curIdx < 0) return false;
    const step = delta > 0 ? 1 : -1;
    for (let i = curIdx + step; i >= 0 && i < rows.length; i += step) {
      if (levelOfRow(rows[i]) === 0) {
        setCursor(rows[i]);
        if (rows[i]._tab) gBrowser.selectedTab = rows[i]._tab;
        return true;
      }
    }
    return false;
  }

  function activateVim(row) {
    focusPanel();
    setCursor(row);
  }

  // Move state.cursor by delta (+1 = down, -1 = up). Skips hidden rows.
  // Also selects the tab if the state.cursor lands on a tab row.
  // Returns true if moved.
  function moveCursor(delta) {
    if (!state.cursor) return false;
    let row = delta > 0 ? state.cursor.nextElementSibling : state.cursor.previousElementSibling;
    while (row && (row.hidden || row === state.spacer)) {
      row = delta > 0 ? row.nextElementSibling : row.previousElementSibling;
    }
    if (row && row !== state.spacer) {
      setCursor(row);
      if (row._tab) gBrowser.selectedTab = row._tab;
      return true;
    }
    return false;
  }

  // --- Tree operations (pure DOM) ---

  function syncAnyRow(row) {
    if (row._tab) Rows.syncTabRow(row._tab);
    else Rows.syncGroupRow(row);
  }

  // Find a tab's previous sibling (nearest preceding tab at same level with
  // the same parent). Used for indent operations.
  function prevSiblingTab(row) {
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

  // Indent: reparent to the previous sibling. Under parentId model, indenting
  // a row implicitly shifts its whole subtree (level is derived). We re-sync
  // the subtree rows so indentation padding updates visually.
  function indentRow(row) {
    if (row._group) {
      // Groups still use stored level (step 6 will parentId-ify groups).
      const rows = allRows();
      const i = rows.indexOf(row);
      if (i <= 0) return;
      const d = row._group;
      const prevLv = levelOfRow(rows[i - 1]);
      if (d.level > prevLv) return;
      d.level++;
      syncAnyRow(row);
    } else if (row._tab) {
      const prev = prevSiblingTab(row);
      if (!prev) return;
      treeData(row._tab).parentId = treeData(prev).id;
      for (const r of subtreeRows(row)) syncAnyRow(r);
    }
    Rows.updateVisibility();
    scheduleSave();
  }
  // Subtree variant is the same under parentId (descendants follow).
  const indentSubtree = indentRow;

  // Outdent: reparent to grandparent. Subtree follows.
  function outdentRow(row) {
    if (row._group) {
      const d = row._group;
      if ((d.level || 0) <= 0) return;
      d.level = Math.max(0, d.level - 1);
      syncAnyRow(row);
    } else if (row._tab) {
      const td = treeData(row._tab);
      if (!td.parentId) return;
      const parent = tabById(td.parentId);
      td.parentId = parent ? treeData(parent).parentId : null;
      for (const r of subtreeRows(row)) syncAnyRow(r);
    }
    Rows.updateVisibility();
    scheduleSave();
  }
  const outdentSubtree = outdentRow;

  function moveToRoot(row) {
    if (!row?._tab) return;
    const td = treeData(row._tab);
    if (!td.parentId) return;
    td.parentId = null;
    for (const r of subtreeRows(row)) syncAnyRow(r);
    Rows.updateVisibility();
    scheduleSave();
  }

  function makeChildOfAbove(row) {
    if (!row?._tab || row._tab.pinned) return;
    const prev = row.previousElementSibling;
    if (!prev?._tab) return;
    treeData(row._tab).parentId = treeData(prev._tab).id;
    for (const r of subtreeRows(row)) syncAnyRow(r);
    Rows.updateVisibility();
    scheduleSave();
  }

  // Alt+j — swap with next sibling at same level
  function swapDown(row) {
    if (!dataOf(row)) return;
    const myLevel = levelOfRow(row);
    const rows = subtreeRows(row);
    const lastRow = rows[rows.length - 1];
    const nextRow = lastRow.nextElementSibling;
    if (!nextRow || nextRow === state.spacer) return;
    if (levelOfRow(nextRow) !== myLevel) return;

    subtreeRows(nextRow).at(-1).after(...rows);
    Rows.updateVisibility();
    scheduleSave();
  }

  // Alt+k — swap with previous sibling at same level
  function swapUp(row) {
    if (!dataOf(row)) return;
    const myLevel = levelOfRow(row);
    let prev = row.previousElementSibling;
    while (prev && levelOfRow(prev) > myLevel) {
      prev = prev.previousElementSibling;
    }
    if (!prev || levelOfRow(prev) !== myLevel) return;

    prev.before(...subtreeRows(row));
    Rows.updateVisibility();
    scheduleSave();
  }


  // --- Key gate ---
  //
  // Keys are only intercepted when the tab state.panel has focus.
  // Everything else (content, urlbar, chrome inputs) is untouched.

  let pendingCtrlW = false;
  let pendingSpace = false;        // Space chord (SPC, w, h/l/w)
  let modeline = null;
  let modelineTimer = 0;

  function createModeline() {
    modeline = document.createXULElement("hbox");
    modeline.id = "pfx-modeline";
    modeline.setAttribute("align", "center");

    const modeLabel = document.createXULElement("label");
    modeLabel.id = "pfx-modeline-mode";
    modeLabel.setAttribute("value", "-- INSERT --");

    const chordLabel = document.createXULElement("label");
    chordLabel.id = "pfx-modeline-chord";
    chordLabel.setAttribute("value", "");
    chordLabel.setAttribute("flex", "1");

    const msgLabel = document.createXULElement("label");
    msgLabel.id = "pfx-modeline-msg";
    msgLabel.setAttribute("value", "");
    msgLabel.setAttribute("crop", "end");

    modeline.append(modeLabel, chordLabel, msgLabel);

    // Overlay at the very bottom of the window
    document.documentElement.appendChild(modeline);
  }

  function updateModeline() {
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

    // Show modeline only for chords, messages, or active /: input
    const hasContent = pending ||
      (msgLabel && msgLabel.getAttribute("value")) ||
      searchActive ||
      modeline.querySelector(".pfx-search-input");
    modeline.toggleAttribute("pfx-visible", !!hasContent);
  }

  function modelineMsg(text, duration = 3000) {
    if (!modeline) return;
    const msg = document.getElementById("pfx-modeline-msg");
    if (msg) {
      msg.setAttribute("value", text);
      modeline.setAttribute("pfx-visible", "true");
      clearTimeout(modelineTimer);
      modelineTimer = setTimeout(() => {
        msg.setAttribute("value", "");
        updateModeline(); // re-evaluate visibility
      }, duration);
    }
  }

  let panelActive = false;

  function focusPanel() {
    panelActive = true;
    state.panel.focus();
    if (!state.cursor) {
      const row = rowOf.get(gBrowser.selectedTab);
      if (row) setCursor(row);
    }
    updateModeline();
  }

  function blurPanel() {
    panelActive = false;
    chord = null;
    pendingCtrlW = false;
    pendingSpace = false;
    clearTimeout(chordTimer);

    // Collapse horizontal popout when leaving tab state.panel
    if (isHorizontal() && hzExpandedRoot) {
      collapseHzTree(hzExpandedRoot);
      hzExpandedRoot = null;
      Rows.updateVisibility();
    }

    updateModeline();
  }

  function setupVimKeys() {
    state.panel.setAttribute("tabindex", "0");

    // Capture-phase on document. Uses a boolean flag instead of
    // document.activeElement because Firefox steals focus to the
    // content browser after selectedTab changes.
    document.addEventListener("keydown", (e) => {
      if (!panelActive) return;

      // Auto-deactivate if focus moved to an input (urlbar, findbar, etc.)
      const active = document.activeElement;
      if (active && active !== state.panel &&
          (active.tagName === "INPUT" || active.tagName === "input" ||
           active.tagName === "TEXTAREA" || active.tagName === "textarea" ||
           active.isContentEditable ||
           active.closest?.("#urlbar") || active.closest?.("findbar"))) {
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
        // Unbound key — deactivate state.panel
        blurPanel();
        // Plain key (no modifier): focus content for vimium etc.
        // Modifier combo (Ctrl+L, Ctrl+T): let Firefox handle natively
        if (!e.ctrlKey && !e.altKey && !e.metaKey) {
          gBrowser.selectedBrowser.focus();
        }
      }
    }, true);

    // Clicking content area deactivates state.panel
    gBrowser.tabpanels.addEventListener("mousedown", () => {
      if (panelActive) blurPanel();
    });
  }



  // Simpler fallback: use the designMode / inputContext signals.
  // Firefox sets the browser's "isRemoteBrowser" and tracks editability
  // via the "IMEState" on the tab. We can check docShell.editor or
  // the simpler approach: just enter insert mode when focusing content.
  // The user pressed Ctrl+W,l — they WANT to interact with content.
  function focusContent() {
    gBrowser.selectedBrowser.focus();
  }

  // Shared pane-switch logic (used by Ctrl+W and SPC+w chords)
  function paneSwitch(key) {
    switch (key) {
      case "h": case "H": // focus sidebar
        state.panel.focus();
        if (!state.cursor) {
          const r = rowOf.get(gBrowser.selectedTab);
          if (r) setCursor(r);
        }
        return;
      case "l": case "L": // focus content + insert mode
        focusContent();
        return;
      case "w": // toggle
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

  // Returns true if the key was consumed, false to pass through.
  function handleNormalKey(e) {
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

    // Ctrl+L, Ctrl+T etc. — pass through to Firefox natively

    // --- Regular chords (gg) ---
    if (chord) {
      const combo = chord + e.key;
      chord = null;
      clearTimeout(chordTimer);
      // if (combo === "dd") { closeFocused(); return true; }
      if (combo === "gg") { goToTop(); return true; }
      return true; // unknown chord, discard
    }
    if (e.key === "g" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      chord = e.key;
      chordTimer = setTimeout(() => { chord = null; }, CHORD_TIMEOUT);
      return true;
    }

    // --- i → focus content, deactivate state.panel ---
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

    // --- Plain keys (need state.cursor) ---
    if (!state.cursor) {
      if ("jklhG/rnNx".includes(e.key)) {
        const row = rowOf.get(gBrowser.selectedTab);
        if (row) setCursor(row);
      }
      if (!state.cursor) return false;
    }

    // Navigation keys (only without Ctrl/Meta modifiers)
    // Vertical: j/k = move state.cursor, h/l = outdent/indent
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
          executeRefile(state.cursor);
          return true;
        }
        if (state.cursor._tab) {
          gBrowser.selectedTab = state.cursor._tab;
          blurPanel();
          gBrowser.selectedBrowser.focus();
        } else {
          Rows.toggleCollapse(state.cursor);
        }
        return true;
      case "Tab": Rows.toggleCollapse(state.cursor); return true;
      case "Escape":
        if (refileSource) { cancelRefile(); return true; }
        return true;
      // case "o": newTabBelow(); return true;
      // case "O": newGroupAbove(); return true;
      case "r": startRename(state.cursor); return true;
      case "G": goToBottom(); return true;
      case "/": startSearch(); return true;
      case "n": nextMatch(1); return true;
      case "N": nextMatch(-1); return true;
      case "x": closeFocused(); return true;
      case ":": startExMode(); return true;
    }

    return false; // unbound key — pass through to Firefox
  }

  // n / N — jump to next/previous search match (wraps around)
  function nextMatch(dir) {
    if (!searchMatches.length) {
      modelineMsg("No previous search");
      return;
    }
    searchIdx = (searchIdx + dir + searchMatches.length) % searchMatches.length;
    const row = searchMatches[searchIdx];
    setCursor(row);
    if (row._tab) gBrowser.selectedTab = row._tab;
    const hint = refileSource ? "  Enter=refile" : "";
    modelineMsg(`[${searchIdx + 1}/${searchMatches.length}]${hint}`);
  }

  // --- Vim actions ---

  function closeFocused() {
    // Multi-select: close all selected
    if (selection.size > 1) {
      const rows = [...selection];
      clearSelection();
      // Move state.cursor off the selection first
      const last = rows[rows.length - 1];
      let next = last.nextElementSibling;
      while (next && (next.hidden || next === state.spacer || rows.includes(next))) {
        next = next.nextElementSibling;
      }
      if (next && next !== state.spacer) setCursor(next);
      // Close in reverse to avoid index shifting
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]._tab) gBrowser.removeTab(rows[i]._tab);
        else if (rows[i]._group) rows[i].remove();
      }
      Rows.updateVisibility();
      scheduleSave();
      return;
    }

    if (!state.cursor) return;
    if (state.cursor._tab) {
      gBrowser.removeTab(state.cursor._tab);
    } else if (state.cursor._group) {
      // Close group: remove group row. Descendants' displayed levels are
      // derived from their parentId chain, so tabs don't need adjustment.
      // Nested groups in the subtree (which still use stored level) do.
      const d = state.cursor._group;
      const myLevel = d.level || 0;
      let next = state.cursor.nextElementSibling;
      while (next && next !== state.spacer) {
        const lv = levelOfRow(next);
        if (lv <= myLevel) break;
        if (next._group) {
          next._group.level = Math.max(0, (next._group.level || 0) - 1);
          Rows.syncGroupRow(next);
        }
        next = next.nextElementSibling;
      }
      const dying = state.cursor;
      moveCursor(1) || moveCursor(-1);
      dying.remove();
      Rows.updateVisibility();
      scheduleSave();
    }
  }

  // --- Ex mode (:commands) ---

  function startExMode() {
    if (searchActive || !modeline) return;

    for (const child of modeline.children) child.hidden = true;
    modeline.setAttribute("pfx-visible", "true");

    const prefix = document.createXULElement("label");
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

  function endExMode(cmd) {
    // Clean up modeline
    modeline.querySelector(".pfx-search-prefix")?.remove();
    modeline.querySelector(".pfx-search-input")?.remove();
    for (const child of modeline.children) child.hidden = false;
    updateModeline();

    if (!cmd) return;

    // Parse and execute commands
    const args = cmd.split(/\s+/);
    const name = args[0].toLowerCase();

    switch (name) {
      case "group":
      case "grp":
      case "folder": {
        const label = args.slice(1).join(" ") || "New Group";
        const row = Rows.createGroupRow(label, state.cursor ? levelOfRow(state.cursor) : 0);
        if (state.cursor) {
          // Insert after state.cursor's subtree
          const st = subtreeRows(state.cursor);
          st[st.length - 1].after(row);
        } else {
          state.panel.insertBefore(row, state.spacer);
        }
        setCursor(row);
        Rows.updateVisibility();
        scheduleSave();
        modelineMsg(`:group ${label}`);
        break;
      }
      case "refile":
      case "rf": {
        if (!state.cursor) {
          modelineMsg("No state.cursor — place state.cursor on tab to refile", 3000);
          break;
        }
        refileSource = state.cursor;
        const srcLabel = dataOf(state.cursor)?.name || state.cursor._tab?.label || "tab";
        modelineMsg(`Refile: "${srcLabel}" → search for target...`);
        // Kick off search after a tick so modeline message shows briefly
        setTimeout(() => startSearch(), 0);
        break;
      }
      default:
        modelineMsg(`Unknown command: ${name}`, 3000);
    }
  }

  function goToTop() {
    const rows = allRows().filter(r => !r.hidden);
    if (!rows.length) return;
    setCursor(rows[0]);
    if (rows[0]._tab) gBrowser.selectedTab = rows[0]._tab;
  }

  function goToBottom() {
    const rows = allRows().filter(r => !r.hidden);
    if (!rows.length) return;
    const last = rows[rows.length - 1];
    setCursor(last);
    if (last._tab) gBrowser.selectedTab = last._tab;
  }


  function cloneAsChild(tab) {
    const parentRow = rowOf.get(tab);
    if (!parentRow) return;
    const parentId = treeData(tab).id;

    pendingCursorMove = true;
    const clone = gBrowser.duplicateTab(tab);

    // Position the clone as a child once its row is created
    const obs = new MutationObserver(() => {
      const cloneRow = rowOf.get(clone);
      if (!cloneRow) return;
      obs.disconnect();
      treeData(clone).parentId = parentId;

      // Insert after parent's subtree
      const st = subtreeRows(parentRow);
      st[st.length - 1].after(cloneRow);

      Rows.syncTabRow(clone);
      Rows.updateVisibility();
      scheduleSave();
    });
    obs.observe(state.panel, { childList: true });
  }

  function newTabBelow() {
    pendingCursorMove = true;
    gBrowser.selectedTab = gBrowser.addTab("about:newtab", {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  }

  function newGroupAbove() {
    if (!state.cursor) return;
    const row = Rows.createGroupRow("New Group", levelOfRow(state.cursor));
    state.cursor.before(row);
    setCursor(row);
    Rows.updateVisibility();
    scheduleSave();
    // Auto-start rename
    startRename(row);
  }

  // --- Refile ---

  let refileSource = null;          // row being refiled (set by :refile)

  function executeRefile(target) {
    if (!refileSource || !target || target === refileSource) return;
    const srcRows = subtreeRows(refileSource);
    if (srcRows.includes(target)) return; // can't refile under own subtree
    const srcData = dataOf(refileSource);
    const tgtData = dataOf(target);
    if (!srcData || !tgtData) return;

    // Source becomes child of target.
    if (refileSource._tab && target._tab) {
      treeData(refileSource._tab).parentId = treeData(target._tab).id;
    } else {
      // Mixed (group involved): fall back to level delta on rows in subtree.
      const tgtLevel = levelOfRow(target);
      const srcLevel = levelOfRow(refileSource);
      const delta = (tgtLevel + 1) - srcLevel;
      for (const r of srcRows) {
        if (r._group) r._group.level = Math.max(0, (r._group.level || 0) + delta);
      }
    }

    // Move after target's subtree
    const tgtSub = subtreeRows(target);
    tgtSub[tgtSub.length - 1].after(...srcRows);

    for (const r of srcRows) syncAnyRow(r);
    Rows.updateVisibility();
    scheduleSave();

    const label = srcData.name || (refileSource._tab?.label) || "tab";
    const tgtLabel = tgtData.name || (target._tab?.label) || "tab";
    modelineMsg(`Refiled "${label}" → "${tgtLabel}"`);
    refileSource = null;
    searchMatches = [];
    searchIdx = -1;
  }

  function cancelRefile() {
    if (refileSource) {
      refileSource = null;
      searchMatches = [];
      searchIdx = -1;
      modelineMsg("Refile cancelled");
    }
  }

  // --- Search / filter (renders in modeline) ---

  let searchInput = null;
  let searchActive = false;
  let searchMatches = [];           // rows that matched last accepted search
  let searchIdx = -1;               // current position in searchMatches

  function startSearch() {
    if (searchActive || !modeline) return;
    searchActive = true;

    // Hide normal modeline content, show search input
    for (const child of modeline.children) child.hidden = true;
    modeline.setAttribute("pfx-visible", "true");

    searchInput = document.createElement("input");
    searchInput.className = "pfx-search-input";
    searchInput.placeholder = "";
    modeline.appendChild(searchInput);
    searchInput.focus();

    // Show "/" prefix
    const prefix = document.createXULElement("label");
    prefix.className = "pfx-search-prefix";
    prefix.setAttribute("value", "/");
    modeline.insertBefore(prefix, searchInput);

    searchInput.addEventListener("input", () => applyFilter(searchInput.value));

    searchInput.addEventListener("keydown", (e) => {
      e.stopImmediatePropagation();
      e.stopPropagation();
      if (e.key === "Escape") {
        endSearch(false);
        focusPanel();
        return;
      }
      if (e.key === "Enter") {
        endSearch(true);
        if (panelActive) focusPanel();
        return;
      }
      if (e.key === "Backspace" && !searchInput.value) {
        endSearch(false);
        focusPanel();
        return;
      }
    });
  }

  function endSearch(accept) {
    searchActive = false;

    if (accept) {
      // Store direct matches (not ancestors) for n/N navigation
      const q = searchInput?.value?.trim().toLowerCase() || "";
      searchMatches = [];
      searchIdx = -1;
      // Exclude refile source subtree from matches
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
      // Jump to first match
      if (searchMatches.length === 1 && !refileSource) {
        // Single result — select tab, dismiss sidebar, focus content
        const match = searchMatches[0];
        setCursor(match);
        if (match._tab) gBrowser.selectedTab = match._tab;
        panelActive = false;
        searchMatches = [];
        searchIdx = -1;
        sidebarMain.dispatchEvent(new Event("pfx-dismiss"));
      } else if (searchMatches.length) {
        searchIdx = 0;
        setCursor(searchMatches[0]);
        if (searchMatches[0]._tab) gBrowser.selectedTab = searchMatches[0]._tab;
        const hint = refileSource ? "  Enter=refile, n/N=cycle" : "";
        modelineMsg(`/${q}  [1/${searchMatches.length}]${hint}`);
      } else if (refileSource) {
        modelineMsg("No refile targets found");
      }
      clearFilter(); // restore all rows visible — n/N navigates the matches
    } else {
      searchMatches = [];
      searchIdx = -1;
      clearFilter();
      if (refileSource) cancelRefile();
    }

    // Restore modeline
    if (searchInput) searchInput.remove();
    searchInput = null;
    const prefix = modeline?.querySelector(".pfx-search-prefix");
    if (prefix) prefix.remove();
    for (const child of modeline.children) child.hidden = false;
    updateModeline();
  }

  function applyFilter(query) {
    const q = query.trim().toLowerCase();
    if (!q) { clearFilter(); return; }

    const rows = allRows();
    const matched = new Set();

    // Mark rows whose label OR url matches
    for (const row of rows) {
      const d = dataOf(row);
      if (!d) continue;
      const label = (d.name || (row._tab ? row._tab.label : "") || "").toLowerCase();
      const url = (row._tab?.linkedBrowser?.currentURI?.spec || "").toLowerCase();
      if (label.includes(q) || url.includes(q)) {
        matched.add(row);
      }
    }

    // Also mark ancestors of matched rows (preserve tree context)
    for (const row of [...matched]) {
      let lv = levelOfRow(row);
      let prev = row.previousElementSibling;
      while (prev) {
        const plv = levelOfRow(prev);
        if (plv < lv) {
          matched.add(prev);
          lv = plv;
        }
        if (plv === 0) break;
        prev = prev.previousElementSibling;
      }
    }

    // Show matched, hide rest
    for (const row of rows) {
      row.hidden = !matched.has(row);
    }
  }

  function clearFilter() {
    for (const row of allRows()) row.hidden = false;
    Rows.updateVisibility();
  }

  // --- Inline rename (works on tab rows AND group rows) ---

  function startRename(row) {
    if (!row) return;
    const label = row.querySelector(".pfx-tab-label");
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
    function finish(commit) {
      if (done) return;
      done = true;
      if (commit) {
        const v = input.value.trim();
        if (row._group) {
          d.name = v || "New Group";
        } else {
          d.name = (v && v !== row._tab.label) ? v : null;
        }
        scheduleSave();
      }
      input.remove();
      label.hidden = false;
      if (row._tab) Rows.syncTabRow(row._tab);
      else Rows.syncGroupRow(row);
      state.panel.focus();
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); focusPanel(); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); focusPanel(); }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
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

  // Drag and rows are mutually dependent at the typed level — rows needs
  // drag.setupDrag to wire DnD on every row it creates; drag needs
  // Rows.scheduleTreeResync to fire after a drop settles. We break the cycle
  // with a late-bound `rows` reference: drag's scheduleTreeResync is a thunk
  // that resolves rows after construction. The thunk is never called during
  // makeDrag itself, only later at drop-completion time.
  let Rows: import("./rows.ts").RowsAPI;
  const drag = makeDrag({
    clearSelection,
    scheduleTreeResync: () => Rows.scheduleTreeResync(),
    scheduleSave,
  });
  Rows = makeRows({
    setupDrag: drag.setupDrag,
    activateVim, selectRange, clearSelection,
    cloneAsChild, startRename, scheduleSave,
  });
  const layout = makeLayout({
    sidebarMain,
    rows: Rows,
    syncAnyRow,
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

  let loadedNodes = null;

  // Build the state.panel from gBrowser.tabs (canonical order). Interleave groups
  // at their saved afterTabId anchors. Unanchored groups go to the top.
  function buildFromSaved() {
    if (!loadedNodes || !state.panel) return false;

    const groupNodes = loadedNodes.filter(n => n.type === "group");

    // Bucket groups by their anchor tab id. `null` = "top of state.panel."
    const leadingGroups = [];
    const groupsAfter = new Map();
    for (const g of groupNodes) {
      if (g.afterTabId == null) leadingGroups.push(g);
      else {
        const arr = groupsAfter.get(g.afterTabId) || [];
        arr.push(g);
        groupsAfter.set(g.afterTabId, arr);
      }
    }

    const mkGroup = (g) => {
      const row = Rows.createGroupRow(g.name, g.level || 0);
      row._group.state = g.state || null;
      row._group.collapsed = !!g.collapsed;
      Rows.syncGroupRow(row);
      return row;
    };

    while (state.panel.firstChild !== state.spacer) state.panel.firstChild.remove();
    if (state.pinnedContainer) {
      while (state.pinnedContainer.firstChild) state.pinnedContainer.firstChild.remove();
    }

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
      startRename,
      toggleCollapse: Rows.toggleCollapse,
      createGroupRow: Rows.createGroupRow,
      setCursor,
      updateVisibility: Rows.updateVisibility,
      scheduleSave,
    });
    createModeline();
    setupVimKeys();
    focusPanel();

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
      if (rows.length) activateVim(rows[rows.length - 1]);
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
        if (aliveUrls.has(s.url)) return;
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
