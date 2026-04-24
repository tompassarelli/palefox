// @ts-nocheck
// Legacy port from chrome/JS/palefox-tabs.uc.js. Single-file paste — will be
// split into modules incrementally. The build wraps the file in IIFE; the
// existing init() bootstrap at the bottom handles delayed startup. Module
// scope is fine because top-level code below has no `return`s outside of
// nested functions.

import { createLogger } from "./log.ts";
import { INDENT, SAVE_FILE, CHORD_TIMEOUT, CLOSED_MEMORY, PIN_ATTR } from "./constants.ts";

const pfxLog = createLogger("tabs");

  // (constants moved to ./constants.ts)

  // --- DOM references ---

  const sidebarMain = document.getElementById("sidebar-main");
  if (!sidebarMain) return;

  // Explicit import — in some chrome-script contexts SessionStore is not
  // exposed as a global, and try/catch around every call would silently
  // swallow the ReferenceError and turn our id-pinning into a no-op.
  const SS = (() => {
    try {
      if (typeof SessionStore !== "undefined") return SessionStore;
    } catch {}
    try {
      return ChromeUtils.importESModule(
        "resource:///modules/sessionstore/SessionStore.sys.mjs"
      ).SessionStore;
    } catch (e) {
      console.error("palefox-tabs: SessionStore unavailable", e);
      return null;
    }
  })();

  // (debug log moved to ./log.ts; pfxLog imported above)

  // --- State ---

  const treeOf = new WeakMap();     // native tab → { level, name, state, collapsed }
  const rowOf  = new WeakMap();     // native tab → row element
  const hzDisplay = new WeakMap();  // row → tab whose visuals to show (horizontal collapse)
  let panel, spacer, pinnedContainer, contextTab;
  let groupCounter = 0;

  // Vim mode
  let cursor = null;                // row with vim cursor
  let chord = null;                 // pending chord key ("d", "g")
  let chordTimer = 0;
  let pendingCursorMove = false;    // move cursor to next new tab row

  // Multi-select
  const selection = new Set();      // rows in the current selection

  // Tabs currently being moved by palefox via gBrowser.moveTabTo. During a
  // move, Firefox transiently toggles `busy` on the tab (animation state);
  // if syncTabRow observes `busy=true` and mirrors it to the row, CSS fades
  // the row's icon. We skip the busy-sync and tree-resync for tabs in this
  // set for the duration of the move, then do one clean resync after.
  // Pattern cribbed from Sidebery (src/services/tabs.fg.move.ts:335-371).
  const movingTabs = new Set();

  // Recently-closed tab memory, for restoring hierarchy on Ctrl+Shift+T.
  // Matched by URL on reopen; parent is looked up by id. (CLOSED_MEMORY in ./constants.ts)
  const closedTabs = [];            // [{ url, id, parentId, name, state, collapsed }]

  // Ordered queue of saved-tab nodes left over from last session's tree file
  // after the load-time positional match. Session-restore tabs arriving later
  // via onTabOpen consume entries from the head of this queue in order,
  // using URL when resolvable and positional-blindspot when pending.
  const savedTabQueue = [];
  let _lastLoadedNodes = [];
  let _inSessionRestore = true;

  let nextTabId = 1;

  // Pin a tab's palefox id via SessionStore so it survives browser restart /
  // undoCloseTab / undoCloseWindow. Lets us match live tabs → saved state
  // exactly by id, bypassing URL-comparison fragility for pending tabs.
  // SessionStore.setTabValue/getTabValue aren't exposed on the SessionStore
  // object we can reach from chrome scripts in this Firefox build. Pin via
  // a DOM attribute instead — Firefox's SessionStore tracks a small set of
  // tab attributes via persistTabAttribute. If we can register ours there we
  // get free cross-session persistence; otherwise this is a no-op and we
  // rely on URL matching. (PIN_ATTR in ./constants.ts)
  let pinAttrRegistered = false;
  function tryRegisterPinAttr() {
    if (pinAttrRegistered || !SS?.persistTabAttribute) return;
    try { SS.persistTabAttribute(PIN_ATTR); pinAttrRegistered = true; }
    catch (e) { console.error("palefox-tabs: persistTabAttribute failed", e); }
  }
  function pinTabId(tab, id) {
    try { tab.setAttribute(PIN_ATTR, String(id)); } catch {}
  }
  function readPinnedId(tab) {
    try {
      const v = tab.getAttribute?.(PIN_ATTR);
      if (v) { const n = Number(v); if (n) return n; }
    } catch {}
    return 0;
  }

  function treeData(tab) {
    if (!treeOf.has(tab)) {
      let id = readPinnedId(tab);
      if (id) {
        if (id >= nextTabId) nextTabId = id + 1;
        pfxLog("treeData:pfxId", { pfxId: id, label: tab.label, nextTabId });
      } else {
        id = nextTabId++;
        pinTabId(tab, id);
        pfxLog("treeData:fresh", { id, label: tab.label, nextTabId });
      }
      treeOf.set(tab, {
        id, parentId: null, name: null, state: null, collapsed: false,
      });
    }
    return treeOf.get(tab);
  }

  function tabById(id) {
    if (!id) return null;
    for (const t of gBrowser.tabs) {
      if (treeOf.get(t)?.id === id) return t;
    }
    return null;
  }

  // Depth of a tab in the tree = number of parent-chain hops to root.
  // Guards against cycles defensively.
  function levelOf(tab) {
    let lv = 0, t = tab;
    const seen = new Set();
    while (t && !seen.has(t)) {
      seen.add(t);
      const pid = treeData(t).parentId;
      if (!pid) break;
      const p = tabById(pid);
      if (!p) break;
      lv++;
      t = p;
    }
    return lv;
  }

  // Polymorphic level for a row: computed for tab rows, stored for groups.
  function levelOfRow(row) {
    if (!row) return 0;
    if (row._group) return row._group.level || 0;
    if (row._tab) return levelOf(row._tab);
    return 0;
  }

  // Find a tab's current parent — direct parentId lookup.
  function parentOfTab(tab) {
    return tabById(treeData(tab).parentId);
  }

  // Unified data access — works for both tab rows and group rows.
  // Note: for tab rows this returns treeData (which has parentId, not level).
  // Use levelOfRow(row) when you need level for either kind.
  function dataOf(row) {
    if (row._group) return row._group;
    if (row._tab) return treeData(row._tab);
    return null;
  }

  // --- Helpers ---

  function isHorizontal() { return panel?.hasAttribute("pfx-horizontal"); }

  function allTabs() { return [...gBrowser.tabs]; }

  // All rows (tabs + groups) in visual order
  function allRows() {
    const pinned = pinnedContainer
      ? [...pinnedContainer.querySelectorAll(".pfx-tab-row")]
      : [];
    return [...pinned, ...panel.querySelectorAll(".pfx-tab-row, .pfx-group-row")];
  }

  function hasChildren(row) {
    const next = row.nextElementSibling;
    if (!next || next === spacer) return false;
    return levelOfRow(next) > levelOfRow(row);
  }

  // Get row + all deeper rows immediately following it (level-based walk,
  // works for mixed tab+group subtrees because levelOfRow is polymorphic).
  function subtreeRows(row) {
    if (!row) return [];
    const lv = levelOfRow(row);
    const out = [row];
    let next = row.nextElementSibling;
    while (next && next !== spacer) {
      if (levelOfRow(next) <= lv) break;
      out.push(next);
      next = next.nextElementSibling;
    }
    return out;
  }

  // --- Selection ---

  function clearSelection() {
    for (const r of selection) r.removeAttribute("pfx-multi");
    selection.clear();
  }

  function selectRange(toRow) {
    const fromRow = cursor || rowOf.get(gBrowser.selectedTab);
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

  // --- Row creation & sync ---

  function createTabRow(tab) {
    const row = document.createXULElement("hbox");
    row.className = "pfx-tab-row";
    row.setAttribute("align", "center");

    const icon = document.createXULElement("image");
    icon.className = "pfx-tab-icon";

    const label = document.createXULElement("label");
    label.className = "pfx-tab-label";
    label.setAttribute("crop", "end");
    label.setAttribute("flex", "1");

    const close = document.createXULElement("image");
    close.className = "pfx-tab-close";

    row.append(icon, label, close);
    row._tab = tab;
    rowOf.set(tab, row);

    row.addEventListener("click", (e) => {
      if (e.button === 0) {
        if (e.target === close) {
          gBrowser.removeTab(tab);
        } else if (e.shiftKey) {
          selectRange(row);
        } else {
          clearSelection();
          gBrowser.selectedTab = tab;
          activateVim(row);
        }
      } else if (e.button === 1) {
        e.preventDefault();
        gBrowser.removeTab(tab);
      }
    });

    row.addEventListener("dblclick", (e) => {
      if (e.button === 0 && e.target !== close) {
        e.stopPropagation();
        cloneAsChild(tab);
      }
    });

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      contextTab = tab;
      document.getElementById("pfx-tab-menu")
        ?.openPopupAtScreen(e.screenX, e.screenY, true);
    });

    setupDrag(row);
    syncTabRow(tab);
    return row;
  }

  function syncTabRow(tab) {
    const row = rowOf.get(tab);
    if (!row) return;
    const td = treeData(tab);

    // In horizontal mode, collapsed root may show a different tab's visuals
    const showTab = hzDisplay.get(row) || tab;
    const showTd = showTab === tab ? td : treeData(showTab);

    const img = showTab.getAttribute("image");
    const icon = row.querySelector(".pfx-tab-icon");
    icon.setAttribute("src", img || "chrome://global/skin/icons/defaultFavicon.svg");

    row.querySelector(".pfx-tab-label").setAttribute(
      "value", showTd.name || showTab.label || "New Tab"
    );

    row.toggleAttribute("selected", tab.selected);
    // Skip `busy` sync while we're moving this tab — Firefox toggles busy
    // during its move animation and would otherwise fade the row's icon.
    if (!movingTabs.has(tab)) {
      row.toggleAttribute("busy", tab.hasAttribute("busy"));
    }
    row.toggleAttribute("pinned", tab.pinned);
    row.toggleAttribute("pfx-collapsed",
      !!td.collapsed && hasChildren(row));

    row.style.paddingInlineStart = (levelOf(tab) * INDENT + 8) + "px";
  }

  // --- Group rows ---

  function createGroupRow(name, level = 0) {
    const group = {
      id: `g${++groupCounter}`,
      type: "group",
      name: name || "New Group",
      level,
      state: null,
      collapsed: false,
    };

    const row = document.createXULElement("hbox");
    row.className = "pfx-group-row";
    row.setAttribute("align", "center");
    row._group = group;

    const marker = document.createXULElement("label");
    marker.className = "pfx-group-marker";
    marker.setAttribute("value", "●");

    const label = document.createXULElement("label");
    label.className = "pfx-tab-label";
    label.setAttribute("crop", "end");
    label.setAttribute("flex", "1");
    label.setAttribute("value", group.name);

    row.append(marker, label);

    row.addEventListener("click", (e) => {
      if (e.button === 0) activateVim(row);
    });

    row.addEventListener("dblclick", (e) => {
      if (e.button === 0) {
        e.stopPropagation();
        startRename(row);
      }
    });

    setupDrag(row);
    syncGroupRow(row);
    return row;
  }

  function syncGroupRow(row) {
    const g = row._group;
    if (!g) return;

    const label = row.querySelector(".pfx-tab-label");
    const statePrefix = g.state === "todo" ? "[ ] "
      : g.state === "wip" ? "[-] "
      : g.state === "done" ? "[x] "
      : "";
    label.setAttribute("value", statePrefix + g.name);

    row.toggleAttribute("pfx-collapsed",
      !!g.collapsed && hasChildren(row));

    row.style.paddingInlineStart = (g.level * INDENT + 8) + "px";
  }

  // --- Visibility (collapse / expand) ---

  function updateVisibility() {
    let hideBelow = -1;
    for (const row of allRows()) {
      const d = dataOf(row);
      if (!d) continue;
      const lv = levelOfRow(row);
      if (hideBelow >= 0 && lv > hideBelow) {
        row.hidden = true;
        continue;
      }
      row.hidden = false;
      hideBelow = (d.collapsed && hasChildren(row)) ? lv : -1;
    }
    updateHorizontalGrid();
  }

  // Assign grid-column / grid-row so each top-level tree forms a column.
  // Child rows (grid-row > 1) pop out below the tab bar via overflow:visible.
  // Panel height is pinned to row 1 so children overlay content.
  function updateHorizontalGrid() {
    if (!isHorizontal() || !panel) return;
    let col = 0;
    let rowInCol = 0;
    let selectedCol = 0;
    for (const row of allRows()) {
      const d = dataOf(row);
      if (!d) continue;
      if (row.hidden) {
        row.removeAttribute("pfx-popout-child");
        continue;
      }
      if (levelOfRow(row) === 0 || col === 0) {
        col++;
        rowInCol = 0;
      }
      rowInCol++;
      row.style.gridColumn = String(col);
      row.style.gridRow = String(rowInCol);
      row.toggleAttribute("pfx-popout-child", rowInCol > 1);
      if (row.hasAttribute("selected")) selectedCol = col;
    }
    // Give the selected tab's column a 200px floor while other columns
    // continue to shrink as more tabs arrive. grid-auto-columns sizes all
    // columns uniformly, so we build explicit grid-template-columns per
    // column count.
    if (col > 0) {
      const tracks = [];
      for (let i = 1; i <= col; i++) {
        tracks.push(i === selectedCol ? "minmax(200px, 200px)" : "minmax(0, 200px)");
      }
      panel.style.gridTemplateColumns = tracks.join(" ");
    } else {
      panel.style.gridTemplateColumns = "";
    }
    // Pin panel height to first row so children overlay instead of expanding
    requestAnimationFrame(() => {
      if (!isHorizontal() || !panel) return;
      const firstRow = panel.querySelector(".pfx-tab-row:not([hidden]), .pfx-group-row:not([hidden])");
      if (firstRow) {
        panel.style.maxHeight = (firstRow.offsetHeight + 2) + "px";
      }
    });
  }

  function clearHorizontalGrid() {
    if (!panel) return;
    panel.style.maxHeight = "";
    for (const row of allRows()) {
      row.style.gridColumn = "";
      row.style.gridRow = "";
      row.removeAttribute("pfx-popout-child");
    }
  }

  // --- Panel management ---

  function buildPanel() {
    if (!panel) return;
    while (panel.firstChild !== spacer) panel.firstChild.remove();
    if (pinnedContainer) {
      while (pinnedContainer.firstChild) pinnedContainer.firstChild.remove();
    }
    for (const tab of gBrowser.tabs) {
      const row = createTabRow(tab);
      if (tab.pinned && pinnedContainer) {
        pinnedContainer.appendChild(row);
      } else {
        panel.insertBefore(row, spacer);
      }
    }
    if (pinnedContainer) {
      pinnedContainer.hidden = !pinnedContainer.querySelector(".pfx-tab-row");
    }
    updateVisibility();
  }

  // --- Tab events ---

  // Resolve a tab's URL, including pending/lazy-restored tabs whose
  // linkedBrowser.currentURI is still about:blank because Firefox hasn't
  // actually navigated them yet (session restore defers load until activation).
  function tabUrl(tab) {
    if (!tab) return "";
    const spec = tab.linkedBrowser?.currentURI?.spec;
    if (spec && spec !== "about:blank") return spec;
    if (SS) {
      try {
        const raw = SS.getTabState(tab);
        if (raw) {
          const state = JSON.parse(raw);
          const entries = state.entries;
          if (Array.isArray(entries) && entries.length) {
            const idx = Math.max(
              0, Math.min(entries.length - 1, (state.index || 1) - 1)
            );
            const entryUrl = entries[idx]?.url;
            if (entryUrl) return entryUrl;
          }
        }
      } catch (e) {
        console.error("palefox-tabs: getTabState failed", e);
      }
    }
    return spec || "";
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
    scheduleTreeResync();
  }

  // Debounced full-panel sync: coalesces multiple applies in one microtask.
  let resyncPending = false;
  function scheduleTreeResync() {
    if (resyncPending) return;
    resyncPending = true;
    Promise.resolve().then(() => {
      resyncPending = false;
      for (const t of gBrowser.tabs) {
        if (rowOf.get(t)) syncTabRow(t);
      }
      updateVisibility();
    });
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
      const row = createTabRow(tab);
      if (tab.pinned && pinnedContainer) {
        pinnedContainer.appendChild(row);
        pinnedContainer.hidden = false;
      } else {
        panel.insertBefore(row, spacer);
      }
      if (pendingCursorMove) { pendingCursorMove = false; setCursor(row); }
      updateVisibility();
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
    const row = createTabRow(tab);
    if (tab.pinned && pinnedContainer) {
      pinnedContainer.appendChild(row);
      pinnedContainer.hidden = false;
    } else {
      panel.insertBefore(row, spacer);
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
    scheduleTreeResync();
    scheduleSave();
  }

  function onTabClose(e) {
    const tab = e.target;
    const row = rowOf.get(tab);

    if (row) {
      const td = dataOf(row);

      // Snapshot identity + parent before we mutate the panel, so we can restore on reopen.
      rememberClosedTab(tab, td);

      // Reparent direct children to the closing tab's parent (promote one level).
      // Groups in our subtree keep their stored level decremented (transitional).
      const closingId = td?.id;
      const newParentId = td?.parentId ?? null;
      const myLevel = levelOf(tab);
      let next = row.nextElementSibling;
      while (next && next !== spacer) {
        if (next._tab) {
          const ntd = treeData(next._tab);
          if (levelOf(next._tab) <= myLevel) break;
          if (ntd.parentId === closingId) {
            ntd.parentId = newParentId;
            syncTabRow(next._tab);
          }
        } else if (next._group) {
          const gLv = next._group.level || 0;
          if (gLv <= myLevel) break;
          next._group.level = Math.max(0, gLv - 1);
          syncGroupRow(next);
        }
        next = next.nextElementSibling;
      }

      if (cursor === row) moveCursor(1) || moveCursor(-1);
      row.remove();
    }
    rowOf.delete(tab);
    updateVisibility();
    scheduleSave();
  }

  function onTabPinned(e) {
    const tab = e.target;
    const row = rowOf.get(tab);
    if (!row || !pinnedContainer) return;
    const td = treeData(tab);
    const pinnedId = td.id;
    td.parentId = null;
    // Promote any direct children of this tab to root (pinned tabs can't have children).
    for (const t of gBrowser.tabs) {
      if (treeData(t).parentId === pinnedId) treeData(t).parentId = null;
    }
    row.removeAttribute("style");
    // TabMove fires before TabPinned (during pinTab) and may have already
    // routed the row to pinnedContainer at the right position. Only fix up
    // if needed.
    if (row.parentNode !== pinnedContainer) {
      pinnedContainer.appendChild(row);
      placeRowInFirefoxOrder(tab, row);
    }
    pinnedContainer.hidden = false;
    syncTabRow(tab);
    for (const r of allRows()) syncAnyRow(r);
    updateVisibility();
    scheduleSave();
  }

  function onTabUnpinned(e) {
    const tab = e.target;
    const row = rowOf.get(tab);
    if (!row) return;
    row.draggable = true;
    // TabMove fires before TabUnpinned and (with the pinned-aware
    // placeRowInFirefoxOrder) already placed the row in panel. Catch the
    // case where the row is somehow still in pinnedContainer.
    if (row.parentNode !== panel) {
      panel.insertBefore(row, spacer);
      placeRowInFirefoxOrder(tab, row);
    }
    syncTabRow(tab);
    if (!pinnedContainer.querySelector(".pfx-tab-row")) {
      pinnedContainer.hidden = true;
    }
    updateVisibility();
    scheduleSave();
  }

  // Exact URL match (FIFO). Used when a tab's URL is resolvable.
  function popSavedByUrl(url) {
    if (!url) return null;
    const i = savedTabQueue.findIndex(s => s.url === url);
    return i >= 0 ? savedTabQueue.splice(i, 1)[0] : null;
  }

  // Index-based match for pending tabs. Saved nodes carry `_origIdx` — their
  // original position in gBrowser.tabs at save time. Firefox session-restore
  // recreates tabs in saved order, so a tab's current index in gBrowser.tabs
  // equals its _origIdx. Matching by index avoids the FIFO-queue race where
  // tabs arriving out of order would consume wrong saved nodes.
  function popSavedByIndex(idx) {
    if (idx < 0) return null;
    const i = savedTabQueue.findIndex(s => s._origIdx === idx);
    return i >= 0 ? savedTabQueue.splice(i, 1)[0] : null;
  }

  // Combined helper: match a tab to its saved node.
  //
  // Priority order:
  //   1. pfx-id attribute — Firefox persists this via persistTabAttribute, so
  //      restored tabs arrive with their previous-session palefox ID already
  //      set. Reliable regardless of tab index or whether the URL has loaded.
  //   2. Exact URL — for tabs that somehow lack a pfx-id but have a known URL.
  //   3. Index-based blindspot — last resort for pending about:blank tabs.
  //      Only correct when no extra tabs (e.g. localhost) offset the indices.
  function popSavedForTab(tab) {
    const pinnedId = readPinnedId(tab);
    const u = tabUrl(tab);
    const idx = [...gBrowser.tabs].indexOf(tab);

    // 1. pfx-id match — most reliable, survives any tab ordering.
    //    Requires persistTabAttribute to be working; falls through if not.
    if (pinnedId) {
      const i = savedTabQueue.findIndex(s => s.id === pinnedId);
      if (i >= 0) {
        pfxLog("popSavedForTab:pfxId", { idx, pfxId: pinnedId, url: u });
        return savedTabQueue.splice(i, 1)[0];
      }
    }

    // 2. URL match — reliable when the URL has already resolved.
    if (u && u !== "about:blank") {
      const node = popSavedByUrl(u);
      pfxLog("popSavedForTab:url", { idx, url: u, found: !!node });
      return node;
    }

    // 3. FIFO — only during session restore (startup or Ctrl+Shift+T).
    //    Gated by _inSessionRestore so new user tabs don't consume stale entries.
    if (!_inSessionRestore) return null;
    const node = savedTabQueue.length ? savedTabQueue.shift() : null;
    pfxLog("popSavedForTab:fifo", { idx, pfxId: pinnedId, url: u, nodeId: node?.id, nodeOrigIdx: node?._origIdx });
    return node;
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
        scheduleTreeResync();
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
        while (n && n !== spacer) {
          if (!n._tab) break;
          const ntd = treeData(n._tab);
          if (!expected.has(ntd.id)) break;
          if (ntd.parentId === oldParentId) {
            ntd.parentId = td.id;
          }
          n = n.nextElementSibling;
        }
      }
      scheduleTreeResync();
    }
    updateVisibility();
    scheduleSave();
  }

  // Position a restored row: after its original prev sibling (if that sibling
  // still exists under the same parent), else as first child of the parent /
  // top of the root, else at end of the parent's subtree / end of the panel.
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
      panel.insertBefore(row, panel.firstChild);
      return;
    }

    // Fallback: append to end of parent's subtree, or end of panel
    if (parentRow) {
      const st = subtreeRows(parentRow);
      st[st.length - 1].after(row);
    } else {
      panel.insertBefore(row, spacer);
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
    while (n && n !== spacer) {
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
    if (row && !cursor) row.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (isHorizontal()) updateHorizontalGrid();
  }

  function onTabAttrModified(e) { syncTabRow(e.target); }

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
  // Pinned and unpinned tabs live in separate containers (pinnedContainer
  // vs panel), so we anchor only against same-pinned-state siblings.
  // Returns true if the row was moved; false if already in place.
  function placeRowInFirefoxOrder(tab, row) {
    if (!row || !panel) return false;
    const tabsArr = [...gBrowser.tabs];
    const myIdx = tabsArr.indexOf(tab);
    if (myIdx < 0) return false;

    // Pinned tabs: reorder within pinnedContainer.
    if (isFxPinned(tab)) {
      if (!pinnedContainer) return false;
      let prevTab = null;
      for (let i = myIdx - 1; i >= 0; i--) {
        if (isFxPinned(tabsArr[i])) { prevTab = tabsArr[i]; break; }
      }
      if (prevTab) {
        const prevRow = rowOf.get(prevTab);
        if (!prevRow || prevRow === row) return false;
        if (prevRow.nextElementSibling !== row) { prevRow.after(row); return true; }
      } else if (pinnedContainer.firstChild !== row) {
        pinnedContainer.insertBefore(row, pinnedContainer.firstChild); return true;
      }
      return false;
    }

    // Unpinned tabs: place in panel, skipping pinned tabs as anchors.
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
    } else if (panel.firstChild !== row) {
      panel.insertBefore(row, panel.firstChild); return true;
    }
    return false;
  }

  // Whenever Firefox reorders a tab, keep the palefox panel in sync.
  // If palefox itself initiated the move (tab is in `movingTabs`), we still
  // align the DOM row, but defer resync + save to the end-of-batch cleanup
  // in executeDrop so we don't re-render during Firefox's busy animation.
  function onTabMove(e) {
    const tab = e.target;
    const moved = placeRowInFirefoxOrder(tab, rowOf.get(tab));
    if (moved && !movingTabs.has(tab)) {
      scheduleTreeResync();
      scheduleSave();
    }
  }

  // --- Vim cursor ---

  // Track which tree is expanded in horizontal mode
  let hzExpandedRoot = null;

  function setCursor(row) {
    if (cursor) cursor.removeAttribute("pfx-cursor");
    cursor = row;
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

  // Firefox sets popover="manual" on #urlbar so it lives in the CSS top
  // layer. That makes it render above everything in horizontal mode,
  // including tree popouts. We can't beat top layer with z-index — the
  // only fix is to pull the urlbar *out* of top layer while the popout
  // is visible, then restore it on collapse. Tree collapse runs before
  // the user can move to the urlbar, so focus behaviour (breakout-extend
  // positioning) is unaffected in practice.
  function setUrlbarTopLayer(inTopLayer) {
    const urlbar = document.getElementById("urlbar");
    if (!urlbar) return;
    // palefox-drawer owns popover state when compact mode is active
    if (sidebarMain.hasAttribute("data-pfx-compact")) return;
    if (inTopLayer && !urlbar.hasAttribute("popover")) {
      urlbar.setAttribute("popover", "manual");
      try { urlbar.showPopover(); } catch (_) {}
    } else if (!inTopLayer && urlbar.hasAttribute("popover")) {
      urlbar.removeAttribute("popover");
    }
  }

  // Auto-expand the cursor's tree, collapse the previous one.
  // On collapse, the root shows the last selected tab's visuals.
  function collapseHzTree(root) {
    const d = dataOf(root);
    if (!d || !hasChildren(root)) return;

    // Set display override: show the selected tab's visuals on the root
    if (cursor && cursor._tab && cursor !== root) {
      const curRoot = treeRoot(cursor);
      if (curRoot === root) {
        hzDisplay.set(root, cursor._tab);
      }
    }

    d.collapsed = true;
    syncAnyRow(root);
    if (isHorizontal()) setUrlbarTopLayer(true);
  }

  function expandHzTree(root) {
    const d = dataOf(root);
    if (!d || !hasChildren(root)) return;

    // Clear display override — show the real root tab
    hzDisplay.delete(root);

    d.collapsed = false;
    syncAnyRow(root);
    if (isHorizontal()) setUrlbarTopLayer(false);
  }

  function updateHorizontalExpansion() {
    if (!cursor) return;
    const root = treeRoot(cursor);
    if (root === hzExpandedRoot) return;

    // Collapse previous tree
    if (hzExpandedRoot) collapseHzTree(hzExpandedRoot);

    // Expand new tree
    expandHzTree(root);

    hzExpandedRoot = root;
    updateVisibility();
  }

  // Move to next/previous level-0 tab (column navigation)
  function moveToLevel0(delta) {
    if (!cursor) return false;
    const rows = allRows();
    const curIdx = rows.indexOf(cursor);
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

  // Move cursor by delta (+1 = down, -1 = up). Skips hidden rows.
  // Also selects the tab if the cursor lands on a tab row.
  // Returns true if moved.
  function moveCursor(delta) {
    if (!cursor) return false;
    let row = delta > 0 ? cursor.nextElementSibling : cursor.previousElementSibling;
    while (row && (row.hidden || row === spacer)) {
      row = delta > 0 ? row.nextElementSibling : row.previousElementSibling;
    }
    if (row && row !== spacer) {
      setCursor(row);
      if (row._tab) gBrowser.selectedTab = row._tab;
      return true;
    }
    return false;
  }

  // --- Tree operations (pure DOM) ---

  function syncAnyRow(row) {
    if (row._tab) syncTabRow(row._tab);
    else syncGroupRow(row);
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
    updateVisibility();
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
    updateVisibility();
    scheduleSave();
  }
  const outdentSubtree = outdentRow;

  function moveToRoot(row) {
    if (!row?._tab) return;
    const td = treeData(row._tab);
    if (!td.parentId) return;
    td.parentId = null;
    for (const r of subtreeRows(row)) syncAnyRow(r);
    updateVisibility();
    scheduleSave();
  }

  function makeChildOfAbove(row) {
    if (!row?._tab || row._tab.pinned) return;
    const prev = row.previousElementSibling;
    if (!prev?._tab) return;
    treeData(row._tab).parentId = treeData(prev._tab).id;
    for (const r of subtreeRows(row)) syncAnyRow(r);
    updateVisibility();
    scheduleSave();
  }

  // Alt+j — swap with next sibling at same level
  function swapDown(row) {
    if (!dataOf(row)) return;
    const myLevel = levelOfRow(row);
    const rows = subtreeRows(row);
    const lastRow = rows[rows.length - 1];
    const nextRow = lastRow.nextElementSibling;
    if (!nextRow || nextRow === spacer) return;
    if (levelOfRow(nextRow) !== myLevel) return;

    subtreeRows(nextRow).at(-1).after(...rows);
    updateVisibility();
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
    updateVisibility();
    scheduleSave();
  }

  function toggleCollapse(row) {
    const d = dataOf(row);
    if (!d || !hasChildren(row)) return;
    d.collapsed = !d.collapsed;
    if (row._tab) syncTabRow(row._tab);
    else syncGroupRow(row);
    updateVisibility();
    scheduleSave();
  }

  // --- Key gate ---
  //
  // Keys are only intercepted when the tab panel has focus.
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
    panel.focus();
    if (!cursor) {
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

    // Collapse horizontal popout when leaving tab panel
    if (isHorizontal() && hzExpandedRoot) {
      collapseHzTree(hzExpandedRoot);
      hzExpandedRoot = null;
      updateVisibility();
    }

    updateModeline();
  }

  function setupVimKeys() {
    panel.setAttribute("tabindex", "0");

    // Capture-phase on document. Uses a boolean flag instead of
    // document.activeElement because Firefox steals focus to the
    // content browser after selectedTab changes.
    document.addEventListener("keydown", (e) => {
      if (!panelActive) return;

      // Auto-deactivate if focus moved to an input (urlbar, findbar, etc.)
      const active = document.activeElement;
      if (active && active !== panel &&
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
        // Unbound key — deactivate panel
        blurPanel();
        // Plain key (no modifier): focus content for vimium etc.
        // Modifier combo (Ctrl+L, Ctrl+T): let Firefox handle natively
        if (!e.ctrlKey && !e.altKey && !e.metaKey) {
          gBrowser.selectedBrowser.focus();
        }
      }
    }, true);

    // Clicking content area deactivates panel
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
        panel.focus();
        if (!cursor) {
          const r = rowOf.get(gBrowser.selectedTab);
          if (r) setCursor(r);
        }
        return;
      case "l": case "L": // focus content + insert mode
        focusContent();
        return;
      case "w": // toggle
        if (document.activeElement === panel) {
          focusContent();
        } else {
          panel.focus();
          if (!cursor) {
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

    // --- i → focus content, deactivate panel ---
    if (e.key === "i") { blurPanel(); gBrowser.selectedBrowser.focus(); return true; }

    // --- Alt combos: same in both modes ---
    // Alt+h/Left = move to root, Alt+l/Right = make child of above
    // Alt+j/Down = swap down, Alt+k/Up = swap up
    if (e.altKey && (e.key === "h" || e.code === "KeyH" || e.key === "ArrowLeft")) {
      if (cursor) moveToRoot(cursor);
      return true;
    }
    if (e.altKey && (e.key === "l" || e.code === "KeyL" || e.key === "ArrowRight")) {
      if (cursor) makeChildOfAbove(cursor);
      return true;
    }
    if (e.altKey && (e.key === "j" || e.code === "KeyJ" || e.key === "ArrowDown")) {
      if (cursor) swapDown(cursor);
      return true;
    }
    if (e.altKey && (e.key === "k" || e.code === "KeyK" || e.key === "ArrowUp")) {
      if (cursor) swapUp(cursor);
      return true;
    }

    // --- Plain keys (need cursor) ---
    if (!cursor) {
      if ("jklhG/rnNx".includes(e.key)) {
        const row = rowOf.get(gBrowser.selectedTab);
        if (row) setCursor(row);
      }
      if (!cursor) return false;
    }

    // Navigation keys (only without Ctrl/Meta modifiers)
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
          case "h": case "ArrowLeft": outdentRow(cursor); return true;
          case "l": case "ArrowRight": indentRow(cursor); return true;
        }
      }
    }

    switch (e.key) {
      case "Enter":
        if (refileSource) {
          executeRefile(cursor);
          return true;
        }
        if (cursor._tab) {
          gBrowser.selectedTab = cursor._tab;
          blurPanel();
          gBrowser.selectedBrowser.focus();
        } else {
          toggleCollapse(cursor);
        }
        return true;
      case "Tab": toggleCollapse(cursor); return true;
      case "Escape":
        if (refileSource) { cancelRefile(); return true; }
        return true;
      // case "o": newTabBelow(); return true;
      // case "O": newGroupAbove(); return true;
      case "r": startRename(cursor); return true;
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
      // Move cursor off the selection first
      const last = rows[rows.length - 1];
      let next = last.nextElementSibling;
      while (next && (next.hidden || next === spacer || rows.includes(next))) {
        next = next.nextElementSibling;
      }
      if (next && next !== spacer) setCursor(next);
      // Close in reverse to avoid index shifting
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]._tab) gBrowser.removeTab(rows[i]._tab);
        else if (rows[i]._group) rows[i].remove();
      }
      updateVisibility();
      scheduleSave();
      return;
    }

    if (!cursor) return;
    if (cursor._tab) {
      gBrowser.removeTab(cursor._tab);
    } else if (cursor._group) {
      // Close group: remove group row. Descendants' displayed levels are
      // derived from their parentId chain, so tabs don't need adjustment.
      // Nested groups in the subtree (which still use stored level) do.
      const d = cursor._group;
      const myLevel = d.level || 0;
      let next = cursor.nextElementSibling;
      while (next && next !== spacer) {
        const lv = levelOfRow(next);
        if (lv <= myLevel) break;
        if (next._group) {
          next._group.level = Math.max(0, (next._group.level || 0) - 1);
          syncGroupRow(next);
        }
        next = next.nextElementSibling;
      }
      const dying = cursor;
      moveCursor(1) || moveCursor(-1);
      dying.remove();
      updateVisibility();
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
        const row = createGroupRow(label, cursor ? levelOfRow(cursor) : 0);
        if (cursor) {
          // Insert after cursor's subtree
          const st = subtreeRows(cursor);
          st[st.length - 1].after(row);
        } else {
          panel.insertBefore(row, spacer);
        }
        setCursor(row);
        updateVisibility();
        scheduleSave();
        modelineMsg(`:group ${label}`);
        break;
      }
      case "refile":
      case "rf": {
        if (!cursor) {
          modelineMsg("No cursor — place cursor on tab to refile", 3000);
          break;
        }
        refileSource = cursor;
        const srcLabel = dataOf(cursor)?.name || cursor._tab?.label || "tab";
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

  // --- Drag and drop ---

  let dragSource = null;       // row being dragged
  let dropIndicator = null;    // visual indicator element
  let dropTarget = null;       // row we're hovering over
  let dropPosition = null;     // "before" | "after" | "child"

  function setupDrag(row) {
    row.draggable = true;

    row.addEventListener("dragstart", (e) => {
      // Don't drag if clicking the close button
      if (e.target.classList?.contains("pfx-tab-close")) {
        e.preventDefault();
        return;
      }
      dragSource = row;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "");
      row.setAttribute("pfx-dragging", "true");
      // Reveal an empty pinned drop zone so unpinned tabs can be pinned
      // by dropping into the area at the top of the sidebar.
      if (pinnedContainer && !row._tab?.pinned
          && !pinnedContainer.querySelector(".pfx-tab-row")) {
        pinnedContainer.hidden = false;
        pinnedContainer.setAttribute("pfx-empty-zone", "true");
      }
      // Symmetric: dragging a pinned tab and the tree panel has no rows —
      // reveal a "drop to unpin" zone in the panel.
      if (panel && row._tab?.pinned
          && !panel.querySelector(".pfx-tab-row, .pfx-group-row")) {
        panel.setAttribute("pfx-empty-zone", "true");
      }
    });

    row.addEventListener("dragend", () => {
      dragSource?.removeAttribute("pfx-dragging");
      dragSource = null;
      clearDropIndicator();
      // Restore hidden state on the empty pinned drop zone if still empty.
      if (pinnedContainer?.hasAttribute("pfx-empty-zone")) {
        pinnedContainer.removeAttribute("pfx-empty-zone");
        if (!pinnedContainer.querySelector(".pfx-tab-row")) {
          pinnedContainer.hidden = true;
        }
      }
      panel?.removeAttribute("pfx-empty-zone");
    });

    row.addEventListener("dragover", (e) => {
      if (!dragSource || dragSource === row) return;
      // Don't allow drop onto own subtree
      if (subtreeRows(dragSource).includes(row)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      const tgtPinned = !!row._tab?.pinned;
      if (tgtPinned) {
        // Target is pinned — horizontal layout, before/after only.
        // (Pinned tabs can't have children.)
        const rect = row.getBoundingClientRect();
        const x = e.clientX - rect.left;
        dropPosition = x < rect.width / 2 ? "before" : "after";
      } else {
        const rect = row.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const zone = rect.height / 3;
        if (y < zone) dropPosition = "before";
        else if (y > zone * 2) dropPosition = "after";
        else dropPosition = "child";
      }
      dropTarget = row;
      showDropIndicator(row, dropPosition);
    });

    row.addEventListener("dragleave", (e) => {
      // Only clear if leaving the row entirely (not entering a child)
      if (!row.contains(e.relatedTarget)) {
        if (dropTarget === row) clearDropIndicator();
      }
    });

    row.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!dragSource || dragSource === row) return;
      if (subtreeRows(dragSource).includes(row)) return;
      executeDrop(dragSource, row, dropPosition);
      clearDropIndicator();
    });
  }

  // Drop handlers on the pinned container itself, for two cases:
  //   1. The container is empty (no rows to drag-over): pin the source.
  //   2. Drop in trailing whitespace after the last pinned row: pin and append.
  function setupPinnedContainerDrop(container) {
    container.addEventListener("dragover", (e) => {
      if (!dragSource || dragSource._tab?.pinned) return;
      // Only handle drops landing directly on the container, not on a child row
      // (rows have their own dragover handlers).
      if (e.target !== container) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const lastRow = container.querySelector(".pfx-tab-row:last-of-type");
      if (lastRow) {
        dropTarget = lastRow;
        dropPosition = "after";
        showDropIndicator(lastRow, "after");
      } else {
        dropTarget = container;
        dropPosition = "into-empty-pinned";
      }
    });

    container.addEventListener("drop", (e) => {
      if (!dragSource || dragSource._tab?.pinned) return;
      if (e.target !== container && dropTarget !== container) return;
      e.preventDefault();
      const tab = dragSource._tab;
      if (!tab) return;
      if (dropTarget === container) {
        // Empty pinned container: just pin. onTabPinned moves the row.
        gBrowser.pinTab(tab);
      } else if (dropTarget?._tab) {
        executeDrop(dragSource, dropTarget, dropPosition);
      }
      clearDropIndicator();
    });
  }

  // Drop handler on the tree panel itself (not its rows). Handles two
  // distinct drop intents that the per-row handlers don't cover:
  //   - Pinned-tab drag dropped on panel whitespace → unpin and append.
  //   - Unpinned-tab drag dropped on panel whitespace → move to end at root.
  // Both also cover the empty-panel case (only the spacer is present).
  function setupPanelDrop(p) {
    p.addEventListener("dragover", (e) => {
      if (!dragSource) return;
      // Only handle if the dragover landed on the panel itself or the spacer
      // (rows handle their own dragover).
      if (e.target !== p && e.target !== spacer) return;

      // For unpinned drags, find the last root-level row that isn't part of
      // the source's own subtree — that's the anchor for an "after" drop.
      // For pinned drags, any last row works as an anchor (executeDrop will
      // unpin first, then place the row).
      const srcPinned = !!dragSource._tab?.pinned;
      let anchor;
      if (srcPinned) {
        anchor = p.querySelector(".pfx-tab-row:last-of-type, .pfx-group-row:last-of-type");
      } else {
        const srcSubtree = new Set(subtreeRows(dragSource));
        const rows = [...p.querySelectorAll(".pfx-tab-row, .pfx-group-row")];
        for (let i = rows.length - 1; i >= 0; i--) {
          if (levelOfRow(rows[i]) === 0 && !srcSubtree.has(rows[i])) {
            anchor = rows[i];
            break;
          }
        }
      }

      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (anchor) {
        dropTarget = anchor;
        dropPosition = "after";
        showDropIndicator(anchor, "after");
      } else {
        // No usable anchor (empty panel, or unpinned drag where source is
        // the only root). For pinned: signal "unpin into empty panel".
        // For unpinned: nothing to do (already at end of root).
        dropTarget = srcPinned ? p : null;
        dropPosition = "into-empty-panel";
      }
    });

    p.addEventListener("drop", (e) => {
      if (!dragSource) return;
      if (e.target !== p && e.target !== spacer && dropTarget !== p) return;
      e.preventDefault();
      const tab = dragSource._tab;
      if (!tab) { clearDropIndicator(); return; }
      if (dropTarget === p) {
        // Empty panel + pinned source: just unpin. onTabUnpinned routes the row.
        if (tab.pinned) gBrowser.unpinTab(tab);
      } else if (dropTarget?._tab) {
        executeDrop(dragSource, dropTarget, dropPosition);
      }
      clearDropIndicator();
    });
  }

  function showDropIndicator(targetRow, position) {
    if (!dropIndicator) {
      dropIndicator = document.createXULElement("box");
      dropIndicator.id = "pfx-drop-indicator";
    }
    dropIndicator.removeAttribute("pfx-drop-child");
    dropIndicator.removeAttribute("pfx-pinned");
    dropIndicator.style.marginInlineStart = "";

    // Pinned target: vertical-line indicator before/after the icon.
    if (targetRow._tab?.pinned) {
      dropIndicator.setAttribute("pfx-pinned", "true");
      if (position === "before") targetRow.before(dropIndicator);
      else targetRow.after(dropIndicator);
      return;
    }

    if (position === "child") {
      dropIndicator.setAttribute("pfx-drop-child", "true");
      targetRow.after(dropIndicator);
      dropIndicator.style.marginInlineStart = ((levelOfRow(targetRow) + 1) * INDENT + 8) + "px";
    } else if (position === "before") {
      targetRow.before(dropIndicator);
      dropIndicator.style.marginInlineStart = (levelOfRow(targetRow) * INDENT + 8) + "px";
    } else {
      // after — insert after the target's subtree
      const st = subtreeRows(targetRow);
      st[st.length - 1].after(dropIndicator);
      dropIndicator.style.marginInlineStart = (levelOfRow(targetRow) * INDENT + 8) + "px";
    }
  }

  function clearDropIndicator() {
    dropIndicator?.remove();
    dropTarget = null;
    dropPosition = null;
  }

  function executeDrop(srcRow, tgtRow, position) {
    const tgtLevel = levelOfRow(tgtRow);
    if (!dataOf(tgtRow)) return;

    const srcPinned = !!srcRow._tab?.pinned;
    const tgtPinned = !!tgtRow._tab?.pinned;
    const isCrossContainer = srcPinned !== tgtPinned;

    // Collect rows to move. Cross-container drags only carry the source tab
    // itself — pinned tabs can't have children, and dragging a pinned tab
    // out shouldn't drag siblings with it.
    let movedRows;
    if (isCrossContainer) {
      movedRows = srcRow._tab ? [srcRow] : [];
    } else if (selection.size > 1 && selection.has(srcRow)) {
      movedRows = allRows().filter(r => selection.has(r));
    } else {
      movedRows = subtreeRows(srcRow);
    }
    if (!movedRows.length) return;

    const srcLevel = levelOfRow(movedRows[0]);
    const newSrcLevel = (position === "child" && !tgtPinned) ? tgtLevel + 1 : tgtLevel;
    const delta = newSrcLevel - srcLevel;

    // Source's new parent: pinned target → null; child → tgt; before/after → tgt's parent.
    const newParentForSource = tgtPinned
      ? null
      : (position === "child"
          ? (tgtRow._tab ? treeData(tgtRow._tab).id : null)
          : (tgtRow._tab ? treeData(tgtRow._tab).parentId : null));

    // Update parentId for top-level moved tabs; descendants keep their
    // existing parentId pointers (they follow the source in the subtree).
    const movedSet = new Set(movedRows);
    for (const r of movedRows) {
      if (!r._tab) {
        if (r._group) r._group.level = Math.max(0, (r._group.level || 0) + delta);
        continue;
      }
      const td = treeData(r._tab);
      const parent = tabById(td.parentId);
      if (!parent || !movedSet.has(rowOf.get(parent))) {
        td.parentId = newParentForSource;
      }
    }

    const movedTabs = movedRows.filter(r => r._tab).map(r => r._tab);

    // Cross-container: apply pin/unpin BEFORE computing targetIdx, since
    // pinTab/unpinTab moves the tab in gBrowser.tabs. Our onTabPinned/
    // onTabUnpinned handlers will route the row to the right container.
    if (isCrossContainer) {
      for (const t of movedTabs) {
        if (tgtPinned && !t.pinned) gBrowser.pinTab(t);
        else if (!tgtPinned && t.pinned) gBrowser.unpinTab(t);
      }
    }

    // Move Firefox tabs via gBrowser.moveTab so our panel and Firefox's tab
    // strip stay aligned. TabMove handlers reorder palefox rows in response.
    // Groups have no Firefox counterpart; we move them via DOM below.
    const tabsArr = [...gBrowser.tabs];

    // Compute target index in Firefox's tab list.
    let targetIdx;
    if (position === "before") {
      targetIdx = tabsArr.indexOf(tgtRow._tab);
    } else {
      // "child" and "after": insert right after tgt's subtree's last Firefox tab.
      const tgtSubtreeTab = [...subtreeRows(tgtRow)].reverse().find(r => r._tab)?._tab;
      targetIdx = (tgtSubtreeTab ? tabsArr.indexOf(tgtSubtreeTab) : tabsArr.indexOf(tgtRow._tab)) + 1;
    }
    if (targetIdx < 0) targetIdx = tabsArr.length;

    // Mark every tab we're about to move so TabMove handlers and syncTabRow
    // skip busy-sync / tree-resync while Firefox's move animation runs.
    // One final clean resync happens below after all moves settle.
    for (const t of movedTabs) movingTabs.add(t);

    // moveTabTo each moved tab, adjusting indices as we go so the
    // group lands contiguously in the right spot.
    let insertIdx = targetIdx;
    for (const t of movedTabs) {
      const currentIdx = [...gBrowser.tabs].indexOf(t);
      if (currentIdx < 0) continue;
      if (currentIdx < insertIdx) insertIdx--;
      if (currentIdx !== insertIdx) gBrowser.moveTabTo(t, { tabIndex: insertIdx });
      insertIdx++;
    }

    // Move any groups in the selection via DOM (no Firefox counterpart).
    const groupRows = movedRows.filter(r => r._group);
    if (groupRows.length) {
      if (position === "before") {
        tgtRow.before(...groupRows);
      } else {
        const st = subtreeRows(tgtRow);
        const anchor = st.filter(r => !movedRows.includes(r));
        (anchor.length ? anchor[anchor.length - 1] : tgtRow).after(...groupRows);
      }
    }

    clearSelection();

    // After the browser has had a frame to settle its move animation (and
    // any transient `busy` attributes), clear the moving set and do one
    // clean resync + save. requestAnimationFrame is cheap and reliable.
    requestAnimationFrame(() => {
      for (const t of movedTabs) movingTabs.delete(t);
      // Also explicitly clear any lingering `busy` attribute on our rows
      // (Firefox may have cleared it on the tab but TabAttrModified for
      // the back-to-back toggle is unreliable for pending/lazy tabs).
      for (const t of movedTabs) {
        const row = rowOf.get(t);
        if (row) row.toggleAttribute("busy", t.hasAttribute("busy"));
      }
      scheduleTreeResync();
      scheduleSave();
    });
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

      syncTabRow(clone);
      updateVisibility();
      scheduleSave();
    });
    obs.observe(panel, { childList: true });
  }

  function newTabBelow() {
    pendingCursorMove = true;
    gBrowser.selectedTab = gBrowser.addTab("about:newtab", {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  }

  function newGroupAbove() {
    if (!cursor) return;
    const row = createGroupRow("New Group", levelOfRow(cursor));
    cursor.before(row);
    setCursor(row);
    updateVisibility();
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
    updateVisibility();
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
    updateVisibility();
  }

  // --- Context menu ---

  function setupContextMenu() {
    const menu = document.createXULElement("menupopup");
    menu.id = "pfx-tab-menu";

    function mi(label, handler) {
      const item = document.createXULElement("menuitem");
      item.setAttribute("label", label);
      item.addEventListener("command", handler);
      return item;
    }
    const sep = () => document.createXULElement("menuseparator");

    // --- Palefox items ---
    const renameItem = mi("Rename Tab", () => {
      if (contextTab) startRename(rowOf.get(contextTab));
    });
    const collapseItem = mi("Collapse", () => {
      if (!contextTab) return;
      const row = rowOf.get(contextTab);
      if (row) toggleCollapse(row);
    });
    const createGroupItem = mi("Create Group", () => {
      if (!contextTab) return;
      const row = rowOf.get(contextTab);
      if (!row) return;
      const grp = createGroupRow("New Group", levelOfRow(row));
      const st = subtreeRows(row);
      st[st.length - 1].after(grp);
      setCursor(grp);
      updateVisibility();
      scheduleSave();
      startRename(grp);
    });
    const closeKidsItem = mi("Close Children", () => {
      if (!contextTab) return;
      const row = rowOf.get(contextTab);
      if (!row) return;
      const kids = subtreeRows(row).slice(1);
      for (let i = kids.length - 1; i >= 0; i--) {
        if (kids[i]._tab) gBrowser.removeTab(kids[i]._tab);
        else kids[i].remove();
      }
    });

    // --- Native actions ---
    const splitViewItem = mi("Add Split View", () => {
      if (!contextTab) return;
      TabContextMenu.contextTab = contextTab;
      TabContextMenu.contextTabs = [contextTab];
      TabContextMenu.moveTabsToSplitView();
    });
    const reloadItem = mi("Reload Tab", () => {
      if (contextTab) gBrowser.reloadTab(contextTab);
    });
    const muteItem = mi("Mute Tab", () => {
      if (contextTab) contextTab.toggleMuteAudio();
    });
    const pinItem = mi("Pin Tab", () => {
      if (!contextTab) return;
      if (contextTab.pinned) gBrowser.unpinTab(contextTab);
      else gBrowser.pinTab(contextTab);
    });
    const duplicateItem = mi("Duplicate Tab", () => {
      if (contextTab) gBrowser.duplicateTab(contextTab);
    });
    const bookmarkItem = mi("Bookmark Tab", () => {
      if (contextTab) PlacesCommandHook.bookmarkTabs([contextTab]);
    });
    const moveToWindowItem = mi("Move to New Window", () => {
      if (contextTab) gBrowser.replaceTabWithWindow(contextTab);
    });
    const copyLinkItem = mi("Copy Link", () => {
      if (!contextTab) return;
      const url = contextTab.linkedBrowser?.currentURI?.spec;
      if (url) {
        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper).copyString(url);
      }
    });
    const closeItem = mi("Close Tab", () => {
      if (contextTab) gBrowser.removeTab(contextTab);
    });
    const reopenItem = mi("Reopen Closed Tab", () => {
      undoCloseTab();
    });

    menu.append(
      renameItem, collapseItem, createGroupItem, closeKidsItem,
      sep(),
      splitViewItem, reloadItem, muteItem, pinItem, duplicateItem,
      sep(),
      bookmarkItem, copyLinkItem, moveToWindowItem,
      sep(),
      closeItem, reopenItem
    );

    menu.addEventListener("popupshowing", () => {
      if (!contextTab) return;
      const row = rowOf.get(contextTab);
      const has = row && hasChildren(row);
      collapseItem.hidden = !has;
      closeKidsItem.hidden = !has;
      if (has) {
        collapseItem.setAttribute("label",
          dataOf(row).collapsed ? "Expand" : "Collapse"
        );
      }
      muteItem.setAttribute("label",
        contextTab.hasAttribute("muted") ? "Unmute Tab" : "Mute Tab"
      );
      pinItem.setAttribute("label",
        contextTab.pinned ? "Unpin Tab" : "Pin Tab"
      );
      splitViewItem.hidden = !!contextTab.splitview;
    });

    document.getElementById("mainPopupSet").appendChild(menu);
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
      if (row._tab) syncTabRow(row._tab);
      else syncGroupRow(row);
      panel.focus();
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); focusPanel(); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); focusPanel(); }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
  }

  // --- Persistence ---

  // Write-on-every-change: capture state at the moment of call and fire an
  // async write. If a write is already in flight, queue one more so the
  // latest state always reaches disk. No debounce, no reliance on unload —
  // quitting/crashing at any moment leaves disk consistent with the latest
  // committed change.
  let saveInFlight = false;
  let savePending = false;
  function scheduleSave() {
    if (saveInFlight) { savePending = true; return; }
    saveInFlight = true;
    (async () => {
      try { await writeToDisk(); } catch (e) { console.error("palefox-tabs: save chain", e); }
      saveInFlight = false;
      if (savePending) { savePending = false; scheduleSave(); }
    })();
  }

  async function writeToDisk() {
    // Tabs saved in Firefox's canonical tab order so positional matching
    // at load time is unambiguous. Groups are anchored by afterTabId —
    // "insert this group right after the tab with this id."
    const tabsArr = [...gBrowser.tabs];
    const tabEntries = tabsArr.map((tab) => {
      const d = treeData(tab);
      return {
        type: "tab",
        id: d.id,
        parentId: d.parentId ?? null,
        url: tabUrl(tab),
        name: d.name,
        state: d.state,
        collapsed: d.collapsed,
      };
    });

    // Walk the panel in DOM order to capture group positions. Each group is
    // anchored to the most-recent preceding tab (null = at top of panel).
    const groupEntries = [];
    let lastSeenTabId = null;
    for (const row of allRows()) {
      if (row._tab) {
        lastSeenTabId = treeData(row._tab).id;
      } else if (row._group) {
        groupEntries.push({
          type: "group",
          name: row._group.name,
          level: row._group.level,
          state: row._group.state,
          collapsed: row._group.collapsed,
          afterTabId: lastSeenTabId,
        });
      }
    }

    // Preserve unconsumed saved-state entries (tabs we expected but haven't
    // seen this session yet) so periodic saves during a blank window don't
    // clobber them before the real window is restored.
    // Filter out leftovers whose URL matches a live tab to prevent duplicates
    // that corrupt the correction path on subsequent restores.
    const liveUrls = new Set(tabEntries.map(e => e.url).filter(Boolean));
    const leftovers = savedTabQueue
      .filter(s => !s.url || !liveUrls.has(s.url))
      .map(s => ({ ...s, type: "tab" }));

    const out = [...tabEntries, ...groupEntries, ...leftovers];

    try {
      const path = PathUtils.join(
        Services.dirsvc.get("ProfD", Ci.nsIFile).path, SAVE_FILE
      );
      await IOUtils.writeUTF8(path, JSON.stringify({
        nodes: out,
        closedTabs,
        nextTabId,
      }));
    } catch (e) {
      console.error("palefox-tabs: save failed", e);
    }
  }

  async function loadFromDisk() {
    const path = PathUtils.join(
      Services.dirsvc.get("ProfD", Ci.nsIFile).path, SAVE_FILE
    );
    let saved;
    try {
      saved = JSON.parse(await IOUtils.readUTF8(path));
    } catch (e) {
      console.log(`palefox-tabs: no save file at ${path} (${e?.name || "err"})`);
      return;
    }
    try {
      if (!saved || !Array.isArray(saved.nodes)) {
        console.log("palefox-tabs: save file exists but has no nodes array");
        return;
      }

      if (Number.isInteger(saved.nextTabId)) nextTabId = saved.nextTabId;
      if (Array.isArray(saved.closedTabs)) {
        closedTabs.length = 0;
        closedTabs.push(...saved.closedTabs.slice(-CLOSED_MEMORY));
      }

      const tabs = allTabs();
      const tabNodes = saved.nodes.filter(n => n.type === "tab");
      _lastLoadedNodes = tabNodes.map(s => ({ ...s }));

      // Belt-and-suspenders: advance nextTabId past every saved node ID before
      // any tab calls treeData(). saved.nextTabId covers this normally, but if
      // it was missing/stale, fresh startup tabs (localhost, etc.) would get an
      // ID that collides with a restored session tab's pfx-id attribute, causing
      // the wrong tab to resolve as parent in the tree.
      for (const s of tabNodes) {
        if (s.id && s.id >= nextTabId) nextTabId = s.id + 1;
      }
      pfxLog("loadFromDisk", { nextTabId, savedNextTabId: saved.nextTabId, tabNodes: tabNodes.length, liveTabs: tabs.length, tabNodeIds: tabNodes.map(s => s.id), liveTabPfxIds: tabs.map(t => t.getAttribute?.("pfx-id") || 0) });

      // Legacy-format migration: if tab nodes have `level` but no `parentId`,
      // derive parentId from level+order via a stack walk.
      {
        const stack = [];
        for (const n of tabNodes) {
          const lv = n.level || 0;
          while (stack.length && stack[stack.length - 1].level >= lv) stack.pop();
          if (n.parentId === undefined) {
            n.parentId = stack.length ? stack[stack.length - 1].id : null;
          }
          if (n.id) stack.push({ level: lv, id: n.id });
        }
      }

      const applied = new Set();
      const apply = (tab, s, i) => {
        const id = s.id || nextTabId++;
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
      loadedNodes = saved.nodes;
    } catch (e) {
      console.error("palefox-tabs: loadFromDisk parse/apply error", e);
    }
  }

  let loadedNodes = null;

  // Build the panel from gBrowser.tabs (canonical order). Interleave groups
  // at their saved afterTabId anchors. Unanchored groups go to the top.
  function buildFromSaved() {
    if (!loadedNodes || !panel) return false;

    const groupNodes = loadedNodes.filter(n => n.type === "group");

    // Bucket groups by their anchor tab id. `null` = "top of panel."
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
      const row = createGroupRow(g.name, g.level || 0);
      row._group.state = g.state || null;
      row._group.collapsed = !!g.collapsed;
      syncGroupRow(row);
      return row;
    };

    while (panel.firstChild !== spacer) panel.firstChild.remove();
    if (pinnedContainer) {
      while (pinnedContainer.firstChild) pinnedContainer.firstChild.remove();
    }

    for (const g of leadingGroups) panel.insertBefore(mkGroup(g), spacer);

    for (const tab of gBrowser.tabs) {
      const row = createTabRow(tab);
      if (tab.pinned && pinnedContainer) {
        pinnedContainer.appendChild(row);
      } else {
        panel.insertBefore(row, spacer);
        const tid = treeData(tab).id;
        const groups = groupsAfter.get(tid);
        if (groups) for (const g of groups) panel.insertBefore(mkGroup(g), spacer);
      }
    }
    if (pinnedContainer) {
      pinnedContainer.hidden = !pinnedContainer.querySelector(".pfx-tab-row");
    }

    loadedNodes = null;
    scheduleTreeResync();
    updateVisibility();
    return true;
  }


  // --- Panel positioning ---

  function isVertical() {
    return Services.prefs.getBoolPref("sidebar.verticalTabs", true);
  }

  let toolboxResizeObs = null;

  // Content-alignment spacer: in horizontal mode the tab strip starts at the
  // window's left edge. Inset it by 10px so tabs don't butt against the edge.
  let alignSpacer = null;
  function setupHorizontalAlignSpacer() {
    const target = document.getElementById("TabsToolbar-customization-target");
    if (!target) return;
    if (!alignSpacer) {
      alignSpacer = document.createXULElement("box");
      alignSpacer.id = "pfx-content-alignment-spacer";
      alignSpacer.style.flex = "0 0 auto";
      alignSpacer.style.width = "10px";
    }
    if (target.firstChild !== alignSpacer) target.prepend(alignSpacer);
  }
  function teardownHorizontalAlignSpacer() {
    alignSpacer?.remove();
  }

  function positionPanel() {
    const vertical = isVertical();
    panel.toggleAttribute("pfx-horizontal", !vertical);
    document.documentElement.toggleAttribute("pfx-horizontal-tabs", !vertical);

    if (toolboxResizeObs) {
      toolboxResizeObs.disconnect();
      toolboxResizeObs = null;
    }

    const toolbox = document.getElementById("navigator-toolbox");
    const toolboxInSidebar = toolbox?.parentNode === sidebarMain;

    if (vertical) {
      const expanded = sidebarMain.hasAttribute("sidebar-launcher-expanded");
      panel.toggleAttribute("pfx-icons-only", !expanded);
      pinnedContainer.toggleAttribute("pfx-icons-only", !expanded);
      if (toolboxInSidebar) {
        if (toolbox.nextElementSibling !== pinnedContainer) toolbox.after(pinnedContainer);
        if (pinnedContainer.nextElementSibling !== panel) pinnedContainer.after(panel);
      } else if (panel.parentNode !== sidebarMain ||
                 sidebarMain.firstElementChild !== pinnedContainer) {
        sidebarMain.prepend(panel);
        sidebarMain.prepend(pinnedContainer);
      }
      teardownHorizontalAlignSpacer();
      // If horizontal mode had a popout open, urlbar may be without popover
      setUrlbarTopLayer(true);
    } else {
      panel.removeAttribute("pfx-icons-only");
      const tabbrowserTabs = document.getElementById("tabbrowser-tabs");
      if (tabbrowserTabs && tabbrowserTabs.nextElementSibling !== panel) {
        tabbrowserTabs.after(panel);
      }
      setupHorizontalAlignSpacer();
    }

    // Track toolbox height for compact mode offset when toolbox is above sidebar
    if (!toolboxInSidebar && toolbox) {
      const updateHeight = () => {
        const h = toolbox.getBoundingClientRect().height;
        document.documentElement.style.setProperty("--pfx-toolbox-height", h + "px");
      };
      updateHeight();
      toolboxResizeObs = new ResizeObserver(updateHeight);
      toolboxResizeObs.observe(toolbox);
    } else {
      document.documentElement.style.removeProperty("--pfx-toolbox-height");
    }

    // Re-sync all rows when switching modes
    if (panel) {
      if (vertical) {
        clearHorizontalGrid();
      }
      for (const row of allRows()) syncAnyRow(row);
      updateVisibility(); // calls updateHorizontalGrid() if horizontal
    }
  }

  // --- Init ---

  async function init() {
    tryRegisterPinAttr();
    await loadFromDisk();
    await new Promise((r) => requestAnimationFrame(r));

    pinnedContainer = document.createXULElement("hbox");
    pinnedContainer.id = "pfx-pinned-container";
    pinnedContainer.hidden = true;
    setupPinnedContainerDrop(pinnedContainer);

    panel = document.createXULElement("vbox");
    panel.id = "pfx-tab-panel";

    spacer = document.createXULElement("box");
    spacer.id = "pfx-tab-spacer";
    spacer.setAttribute("flex", "1");
    panel.appendChild(spacer);
    setupPanelDrop(panel);

    positionPanel();

    // Re-position when toolbox moves in/out of sidebar, or expand/collapse
    new MutationObserver(() => positionPanel()).observe(sidebarMain, {
      childList: true,
      attributes: true,
      attributeFilter: ["sidebar-launcher-expanded"],
    });

    // Switch between horizontal/vertical layout
    Services.prefs.addObserver("sidebar.verticalTabs", {
      observe() { positionPanel(); },
    });

    // Build from saved data (preserves groups + order) or fresh
    if (!buildFromSaved()) buildPanel();

    setupContextMenu();
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

    // Click on spacer activates vim with last row
    spacer.addEventListener("click", () => {
      const rows = allRows().filter(r => !r.hidden);
      if (rows.length) activateVim(rows[rows.length - 1]);
    });

    // Clicking content area blurs the panel naturally via the blur listener.

    // After any session restore (startup auto-restore or Ctrl+Shift+T manual
    // restore), fire a final tree resync. scheduleTreeResync() defers via
    // Promise microtask — if Firefox creates session tabs asynchronously across
    // multiple tasks, the per-TabOpen microtask resolves parentId chains before
    // all tabs exist. A resync here guarantees a clean pass once everything
    // is in gBrowser.tabs. One-shot: remove after first fire.
    const onSessionRestored = () => {
      console.log("palefox-tabs: sessionstore-windows-restored — final tree resync");
      pfxLog("sessionstore-windows-restored", { queueLen: savedTabQueue.length, inSessionRestore: _inSessionRestore });
      savedTabQueue.length = 0;
      _inSessionRestore = false;
      scheduleTreeResync();
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
