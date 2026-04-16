// ==UserScript==
// @name           Palefox Tabs
// @description    Tree-style tab panel with vim keybindings
// @include        main
// ==/UserScript==

(() => {
  "use strict";

  // --- Constants ---

  const INDENT = 14;                // px per nesting level
  const SAVE_FILE = "palefox-tab-tree.json";
  const CHORD_TIMEOUT = 500;        // ms to complete a chord (dd, gg)

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

  // --- State ---

  const treeOf = new WeakMap();     // native tab → { level, name, state, collapsed }
  const rowOf  = new WeakMap();     // native tab → row element
  const hzDisplay = new WeakMap();  // row → tab whose visuals to show (horizontal collapse)
  let panel, spacer, contextTab;
  let groupCounter = 0;

  // Vim mode
  let cursor = null;                // row with vim cursor
  let chord = null;                 // pending chord key ("d", "g")
  let chordTimer = 0;
  let pendingCursorMove = false;    // move cursor to next new tab row

  // Multi-select
  const selection = new Set();      // rows in the current selection

  // Recently-closed tab memory, for restoring hierarchy on Ctrl+Shift+T.
  // Matched by URL on reopen; parent is looked up by id.
  const CLOSED_MEMORY = 32;
  const closedTabs = [];            // [{ url, id, parentId, name, state, collapsed }]

  // Saved tab state from last session's tree file, indexed by URL.
  // Consulted by onTabRestoring when a tab URL shows up that wasn't live at init
  // (e.g. Firefox undoCloseWindow / late session restore of an entire window).
  const savedTabState = new Map();  // url → [saved node, ...]

  let nextTabId = 1;

  // Pin a tab's palefox id via SessionStore so it survives browser restart /
  // undoCloseTab / undoCloseWindow. Lets us match live tabs → saved state
  // exactly by id, bypassing URL-comparison fragility for pending tabs.
  // SessionStore.setTabValue/getTabValue aren't exposed on the SessionStore
  // object we can reach from chrome scripts in this Firefox build. Pin via
  // a DOM attribute instead — Firefox's SessionStore tracks a small set of
  // tab attributes via persistTabAttribute. If we can register ours there we
  // get free cross-session persistence; otherwise this is a no-op and we
  // rely on URL matching.
  const PIN_ATTR = "pfx-id";
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
        // Tab already has an id pinned from a prior session — keep it.
        if (id >= nextTabId) nextTabId = id + 1;
      } else {
        id = nextTabId++;
        pinTabId(tab, id);
      }
      treeOf.set(tab, { id, level: 0, name: null, state: null, collapsed: false });
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

  // Find a tab's current parent in the tree: nearest preceding tab at a lower level.
  function parentOfTab(tab) {
    const row = rowOf.get(tab);
    if (!row) return null;
    const myLevel = treeData(tab).level;
    if (myLevel <= 0) return null;
    let r = row.previousElementSibling;
    while (r) {
      if (r._tab && treeData(r._tab).level < myLevel) return r._tab;
      r = r.previousElementSibling;
    }
    return null;
  }

  // Unified data access — works for both tab rows and group rows
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
    return [...panel.querySelectorAll(".pfx-tab-row, .pfx-group-row")];
  }

  function hasChildren(row) {
    const next = row.nextElementSibling;
    if (!next || next === spacer) return false;
    const d = dataOf(row);
    const nd = dataOf(next);
    return d && nd && nd.level > d.level;
  }

  // Get row + all deeper rows immediately following it
  function subtreeRows(row) {
    const d = dataOf(row);
    if (!d) return [row];
    const lv = d.level;
    const out = [row];
    let next = row.nextElementSibling;
    while (next && next !== spacer) {
      const nd = dataOf(next);
      if (!nd || nd.level <= lv) break;
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
    row.toggleAttribute("busy", tab.hasAttribute("busy"));
    row.toggleAttribute("pinned", tab.pinned);
    row.toggleAttribute("pfx-collapsed",
      !!td.collapsed && hasChildren(row));

    row.style.paddingInlineStart = (td.level * INDENT + 8) + "px";
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
      if (hideBelow >= 0 && d.level > hideBelow) {
        row.hidden = true;
        continue;
      }
      row.hidden = false;
      hideBelow = (d.collapsed && hasChildren(row)) ? d.level : -1;
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
    for (const row of allRows()) {
      const d = dataOf(row);
      if (!d) continue;
      if (row.hidden) {
        row.removeAttribute("pfx-popout-child");
        continue;
      }
      if (d.level === 0 || col === 0) {
        col++;
        rowInCol = 0;
      }
      rowInCol++;
      row.style.gridColumn = String(col);
      row.style.gridRow = String(rowInCol);
      row.toggleAttribute("pfx-popout-child", rowInCol > 1);
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
    for (const tab of gBrowser.tabs) {
      panel.insertBefore(createTabRow(tab), spacer);
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

  // Try to resolve a just-opened tab's URL from any available source.
  // Pending (unloaded) session-restore tabs have currentURI=about:blank; the
  // real URL is tucked away in a few internal slots set by SessionStore.
  function resolveOpeningUrl(tab) {
    const u = tabUrl(tab);
    if (u && u !== "about:blank") return u;
    // Internal SessionStore data directly on the browser element.
    const ssData = tab.linkedBrowser?.__SS_data;
    if (ssData?.entries?.length) {
      const i = Math.max(0, Math.min(ssData.entries.length - 1, (ssData.index || 1) - 1));
      const direct = ssData.entries[i]?.url;
      if (direct) return direct;
    }
    // lazyBrowserURI (set by addTrustedTab with createLazyBrowser).
    const lazySpec = tab.linkedBrowser?.lazyBrowserURI?.spec;
    if (lazySpec) return lazySpec;
    // Tab label — for pending tabs without a title, Firefox uses the URL.
    const lbl = tab.getAttribute?.("label") || tab.label || "";
    if (/^[a-z]+:/i.test(lbl)) return lbl;
    return u || "";
  }

  // Apply a saved-state entry to a tab's treeData and re-sync its row.
  // Used by both the immediate onTabOpen match and the deferred match below.
  function applySavedToTab(tab, prior) {
    const td = treeData(tab);
    td.id = prior.id || td.id;
    td.level = prior.level || 0;
    td.name = prior.name || null;
    td.state = prior.state || null;
    td.collapsed = !!prior.collapsed;
    pinTabId(tab, td.id);
    if (rowOf.get(tab)) syncTabRow(tab);
  }

  function onTabOpen(e) {
    const tab = e.target;
    const td = treeData(tab);

    // Session-restore path: the tab matches something we saved last run.
    // This covers pending/unloaded tabs brought back by session auto-restore
    // or undoCloseWindow, which don't fire SSTabRestoring until activated.
    const openUrl = resolveOpeningUrl(tab);
    const prior = openUrl ? popSavedState(openUrl) : null;
    if (prior) {
      applySavedToTab(tab, prior);
      const row = createTabRow(tab);
      panel.insertBefore(row, spacer);    // append in arrival order
      if (pendingCursorMove) { pendingCursorMove = false; setCursor(row); }
      updateVisibility();
      scheduleSave();
      return;
    }

    // URL wasn't resolvable at TabOpen time (pending/lazy session-restored
    // tab). SessionStore populates state at various points depending on
    // restore timing; retry a few times with increasing delay. Also retry
    // on TabAttrModified in case Firefox mutates label/URL later.
    if (savedTabState.size) {
      const tryMatch = () => {
        if (!tab.isConnected || !rowOf.get(tab)) return false;
        const later = resolveOpeningUrl(tab);
        console.log(`palefox-tabs: deferred match tab url=${later || "(empty)"} stateSize=${savedTabState.size}`);
        if (!later || later === "about:blank") return false;
        const match = popSavedState(later);
        if (!match) return false;
        applySavedToTab(tab, match);
        scheduleSave();
        return true;
      };
      Promise.resolve().then(tryMatch);
      setTimeout(tryMatch, 50);
      setTimeout(tryMatch, 250);
      setTimeout(tryMatch, 1000);
    }

    // "root" (default) → level 0, appended at end
    // "child"  → child of opener, or child of selected
    // "sibling"→ sibling of opener, or sibling of selected
    const position = Services.prefs.getCharPref("pfx.tabs.newTabPosition", "root");
    const anchor = tab.owner || (gBrowser.selectedTab !== tab ? gBrowser.selectedTab : null);

    if (position === "child" && anchor) {
      td.level = treeData(anchor).level + 1;
    } else if (position === "sibling" && anchor) {
      td.level = treeData(anchor).level;
    }
    // "root" leaves level at 0

    const row = createTabRow(tab);

    let ref = null;
    if (position !== "root") {
      // Insert after cursor if vim is active, otherwise after selected tab's row
      ref = cursor || rowOf.get(gBrowser.selectedTab);
    }
    if (ref) {
      // Insert after ref's subtree
      const st = subtreeRows(ref);
      st[st.length - 1].after(row);
    } else {
      // Root mode, or no anchor: append at end of panel
      panel.insertBefore(row, spacer);
    }
    if (pendingCursorMove) {
      pendingCursorMove = false;
      setCursor(row);
    }
    updateVisibility();
    scheduleSave();
  }

  function onTabClose(e) {
    const tab = e.target;
    const row = rowOf.get(tab);

    if (row) {
      const td = dataOf(row);

      // Snapshot identity + parent before we mutate the panel, so we can restore on reopen.
      rememberClosedTab(tab, td);

      // Promote orphaned children one level up
      let next = row.nextElementSibling;
      while (next && next !== spacer) {
        const nd = dataOf(next);
        if (!nd || nd.level <= td.level) break;
        nd.level = Math.max(0, nd.level - 1);
        if (next._tab) syncTabRow(next._tab);
        else syncGroupRow(next);
        next = next.nextElementSibling;
      }

      if (cursor === row) moveCursor(1) || moveCursor(-1);
      row.remove();
    }
    rowOf.delete(tab);
    updateVisibility();
    scheduleSave();
  }

  // Pop the first saved-state entry matching this URL (leftover from last session).
  function popSavedState(url) {
    if (!url) return null;
    const list = savedTabState.get(url);
    if (!list || !list.length) return null;
    const entry = list.shift();
    if (!list.length) savedTabState.delete(url);
    return entry;
  }

  // Fires when SessionStore is about to restore a tab (e.g. Ctrl+Shift+T,
  // undoCloseWindow, late session restore). URL is committed by this point.
  //
  // Two cases:
  //  - Tab was closed this session → matched via closedTabs (full restore:
  //    position relative to prev sibling, descendants re-demoted).
  //  - Tab was saved last session but never live this session → matched via
  //    savedTabState (partial restore: id + level + metadata, DOM position
  //    follows session-restore order).
  function onTabRestoring(e) {
    const tab = e.target;
    const url = tabUrl(tab);

    const entry = popClosedEntry(url);
    if (!entry) {
      // Fallback: saved state from last session's tree file.
      const prior = popSavedState(url);
      if (prior) {
        const td = treeData(tab);
        td.id = prior.id || td.id;
        td.level = prior.level || 0;
        td.name = prior.name || null;
        td.state = prior.state || null;
        td.collapsed = !!prior.collapsed;
        pinTabId(tab, td.id);
        if (rowOf.get(tab)) syncTabRow(tab);
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

    const parent = tabById(entry.parentId);
    td.level = parent ? treeData(parent).level + 1 : 0;

    // Move this tab's row to its restored position.
    const row = rowOf.get(tab);
    if (row) {
      placeRestoredRow(row, parent, entry.prevSiblingId);
      syncTabRow(tab);
      // Re-demote any contiguous ex-descendants that onTabClose had promoted.
      // Stop at the first row that isn't a known descendant — anything moved
      // elsewhere by the user is left alone.
      if (entry.descendantIds?.length) {
        const expected = new Set(entry.descendantIds);
        let n = row.nextElementSibling;
        while (n && n !== spacer) {
          if (!n._tab) break;
          const id = treeData(n._tab).id;
          if (!expected.has(id)) break;
          treeData(n._tab).level += 1;
          syncTabRow(n._tab);
          n = n.nextElementSibling;
        }
      }
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
    const myLevel = td?.level || 0;

    // Walk backwards for previous sibling.
    let prevSiblingId = null;
    let r = row.previousElementSibling;
    while (r) {
      if (r._tab) {
        const lvl = treeData(r._tab).level;
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
        const lvl = treeData(n._tab).level;
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
    if (row && !cursor) row.scrollIntoView({ block: "nearest" });
  }

  function onTabAttrModified(e) { syncTabRow(e.target); }
  function onTabMove() {}

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
      const d = dataOf(rows[i]);
      if (d && d.level === 0) return rows[i];
    }
    return row;
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
  }

  function expandHzTree(root) {
    const d = dataOf(root);
    if (!d || !hasChildren(root)) return;

    // Clear display override — show the real root tab
    hzDisplay.delete(root);

    d.collapsed = false;
    syncAnyRow(root);
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
      const d = dataOf(rows[i]);
      if (d && d.level === 0) {
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

  // h — indent single row only
  function indentRow(row) {
    const rows = allRows();
    const i = rows.indexOf(row);
    if (i <= 0) return;
    const d = dataOf(row);
    const prevD = dataOf(rows[i - 1]);
    if (!d || !prevD || d.level > prevD.level) return;
    d.level++;
    syncAnyRow(row);
    updateVisibility();
    scheduleSave();
  }

  // Ctrl+l — indent row + entire subtree
  function indentSubtree(row) {
    const rows = allRows();
    const i = rows.indexOf(row);
    if (i <= 0) return;
    const d = dataOf(row);
    const prevD = dataOf(rows[i - 1]);
    if (!d || !prevD || d.level > prevD.level) return;
    for (const r of subtreeRows(row)) {
      dataOf(r).level++;
      syncAnyRow(r);
    }
    updateVisibility();
    scheduleSave();
  }

  // h — outdent single row only
  function outdentRow(row) {
    const d = dataOf(row);
    if (!d || d.level <= 0) return;
    d.level = Math.max(0, d.level - 1);
    syncAnyRow(row);
    updateVisibility();
    scheduleSave();
  }

  // Ctrl+h — outdent row + entire subtree
  function outdentSubtree(row) {
    const d = dataOf(row);
    if (!d || d.level <= 0) return;
    for (const r of subtreeRows(row)) {
      dataOf(r).level = Math.max(0, dataOf(r).level - 1);
      syncAnyRow(r);
    }
    updateVisibility();
    scheduleSave();
  }

  // Alt+j — swap with next sibling at same level
  function swapDown(row) {
    const d = dataOf(row);
    if (!d) return;
    const rows = subtreeRows(row);
    const lastRow = rows[rows.length - 1];
    const nextRow = lastRow.nextElementSibling;
    if (!nextRow || nextRow === spacer) return;
    const nd = dataOf(nextRow);
    if (!nd || nd.level !== d.level) return;

    subtreeRows(nextRow).at(-1).after(...rows);
    updateVisibility();
    scheduleSave();
  }

  // Alt+k — swap with previous sibling at same level
  function swapUp(row) {
    const d = dataOf(row);
    if (!d) return;
    let prev = row.previousElementSibling;
    while (prev && dataOf(prev)?.level > d.level) {
      prev = prev.previousElementSibling;
    }
    if (!prev || dataOf(prev)?.level !== d.level) return;

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
    // Alt+h/l = outdent/indent subtree, Alt+j/k = swap siblings
    if (e.altKey && (e.key === "h" || e.code === "KeyH")) {
      if (cursor) outdentSubtree(cursor);
      return true;
    }
    if (e.altKey && (e.key === "l" || e.code === "KeyL")) {
      if (cursor) indentSubtree(cursor);
      return true;
    }
    if (e.altKey && (e.key === "j" || e.code === "KeyJ")) {
      if (cursor) swapDown(cursor);
      return true;
    }
    if (e.altKey && (e.key === "k" || e.code === "KeyK")) {
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
      // Close group: remove group row, promote children
      const d = cursor._group;
      let next = cursor.nextElementSibling;
      while (next && next !== spacer) {
        const nd = dataOf(next);
        if (!nd || nd.level <= d.level) break;
        nd.level = Math.max(0, nd.level - 1);
        if (next._tab) syncTabRow(next._tab);
        else syncGroupRow(next);
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
        const d = cursor ? dataOf(cursor) : null;
        const row = createGroupRow(label, d?.level || 0);
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
    });

    row.addEventListener("dragend", () => {
      dragSource?.removeAttribute("pfx-dragging");
      dragSource = null;
      clearDropIndicator();
    });

    row.addEventListener("dragover", (e) => {
      if (!dragSource || dragSource === row) return;
      // Don't allow drop onto own subtree
      if (subtreeRows(dragSource).includes(row)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      const rect = row.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const zone = rect.height / 3;

      if (y < zone) {
        dropPosition = "before";
      } else if (y > zone * 2) {
        dropPosition = "after";
      } else {
        dropPosition = "child";
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

  function showDropIndicator(targetRow, position) {
    if (!dropIndicator) {
      dropIndicator = document.createXULElement("box");
      dropIndicator.id = "pfx-drop-indicator";
    }
    dropIndicator.removeAttribute("pfx-drop-child");

    if (position === "child") {
      dropIndicator.setAttribute("pfx-drop-child", "true");
      targetRow.after(dropIndicator);
      const d = dataOf(targetRow);
      dropIndicator.style.marginInlineStart = ((d ? d.level + 1 : 1) * INDENT + 8) + "px";
    } else if (position === "before") {
      targetRow.before(dropIndicator);
      dropIndicator.style.marginInlineStart = (dataOf(targetRow)?.level * INDENT + 8) + "px";
    } else {
      // after — insert after the target's subtree
      const st = subtreeRows(targetRow);
      st[st.length - 1].after(dropIndicator);
      dropIndicator.style.marginInlineStart = (dataOf(targetRow)?.level * INDENT + 8) + "px";
    }
  }

  function clearDropIndicator() {
    dropIndicator?.remove();
    dropTarget = null;
    dropPosition = null;
  }

  function executeDrop(srcRow, tgtRow, position) {
    const tgtData = dataOf(tgtRow);
    if (!tgtData) return;

    // Collect rows to move: multi-select or single subtree
    let movedRows;
    if (selection.size > 1 && selection.has(srcRow)) {
      // Gather selected rows in visual order
      movedRows = allRows().filter(r => selection.has(r));
    } else {
      movedRows = subtreeRows(srcRow);
    }
    if (!movedRows.length) return;

    const firstData = dataOf(movedRows[0]);
    if (!firstData) return;

    const newLevel = position === "child" ? tgtData.level + 1 : tgtData.level;
    const delta = newLevel - firstData.level;

    for (const r of movedRows) {
      dataOf(r).level += delta;
    }

    // Move DOM nodes
    if (position === "before") {
      tgtRow.before(...movedRows);
    } else {
      const st = subtreeRows(tgtRow);
      const anchor = st.filter(r => !movedRows.includes(r));
      (anchor.length ? anchor[anchor.length - 1] : tgtRow).after(...movedRows);
    }

    for (const r of movedRows) syncAnyRow(r);
    clearSelection();
    updateVisibility();
    scheduleSave();
  }

  function cloneAsChild(tab) {
    const parentRow = rowOf.get(tab);
    if (!parentRow) return;
    const parentData = treeData(tab);
    const childLevel = parentData.level + 1;

    pendingCursorMove = true;
    const clone = gBrowser.duplicateTab(tab);

    // Position the clone as a child once its row is created
    const obs = new MutationObserver(() => {
      const cloneRow = rowOf.get(clone);
      if (!cloneRow) return;
      obs.disconnect();
      treeData(clone).level = childLevel;

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
    const d = dataOf(cursor);
    const row = createGroupRow("New Group", d?.level || 0);
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

    // Calculate level delta: source becomes child of target
    const delta = (tgtData.level + 1) - srcData.level;
    for (const r of srcRows) {
      dataOf(r).level += delta;
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
      let lv = dataOf(row).level;
      let prev = row.previousElementSibling;
      while (prev) {
        const pd = dataOf(prev);
        if (pd && pd.level < lv) {
          matched.add(prev);
          lv = pd.level;
        }
        if (pd && pd.level === 0) break;
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
      const d = dataOf(row);
      const grp = createGroupRow("New Group", d?.level || 0);
      // Insert after this row's subtree
      const st = subtreeRows(row);
      st[st.length - 1].after(grp);
      setCursor(grp);
      updateVisibility();
      scheduleSave();
      startRename(grp);
    });

    const sep = document.createXULElement("menuseparator");

    const closeItem = mi("Close Tab", () => {
      if (contextTab) gBrowser.removeTab(contextTab);
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

    menu.append(renameItem, collapseItem, createGroupItem, sep, closeItem, closeKidsItem);

    menu.addEventListener("popupshowing", () => {
      const row = contextTab ? rowOf.get(contextTab) : null;
      const has = row && hasChildren(row);
      collapseItem.hidden = !has;
      closeKidsItem.hidden = !has;
      if (has) {
        collapseItem.setAttribute("label",
          dataOf(row).collapsed ? "Expand" : "Collapse"
        );
      }
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
    const out = allRows().map((row) => {
      const d = dataOf(row);
      if (!d) return null;
      if (row._group) {
        return { type: "group", name: d.name, level: d.level,
                 state: d.state, collapsed: d.collapsed };
      }
      return {
        type: "tab",
        id: d.id,
        url: tabUrl(row._tab),
        level: d.level, name: d.name,
        state: d.state, collapsed: d.collapsed,
      };
    }).filter(Boolean);

    // Preserve unconsumed saved-state entries (tabs saved last session that
    // haven't been brought back yet). Otherwise periodic saves during a
    // nearly-empty session would clobber them before SSTabRestoring can claim.
    for (const [, list] of savedTabState) {
      for (const s of list) out.push({ ...s, type: "tab" });
    }

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
      const used = new Set();

      // Reviver: apply saved tree data (preserving id) to a live tab.
      const applied = new Set();
      const apply = (tab, s, i) => {
        const id = s.id || nextTabId++;
        treeOf.set(tab, {
          id, level: s.level || 0, name: s.name || null,
          state: s.state || null, collapsed: !!s.collapsed,
        });
        pinTabId(tab, id);
        applied.add(i);
      };

      const tabNodes = saved.nodes.filter(n => n.type === "tab");

      // 1. Primary: match by SessionStore-pinned id. Exact, survives session
      //    restore including lazy/pending tabs (no URL comparison needed).
      tabs.forEach((tab, i) => {
        if (used.has(i)) return;
        const pid = readPinnedId(tab);
        if (!pid) return;
        const j = tabNodes.findIndex((s, k) => !applied.has(k) && s.id === pid);
        if (j >= 0) {
          apply(tab, tabNodes[j], j);
          used.add(i);
        }
      });

      // 2. Fallback: URL matching (position-first, then by URL). Covers first
      //    run after upgrade, and tabs opened outside palefox.
      const liveUrls = tabs.map(tabUrl);
      tabNodes.forEach((s, i) => {
        if (applied.has(i)) return;
        if (i < tabs.length && !used.has(i) && liveUrls[i] === s.url) {
          apply(tabs[i], s, i);
          used.add(i);
        }
      });
      tabNodes.forEach((s, i) => {
        if (applied.has(i)) return;
        const j = liveUrls.findIndex((u, k) => !used.has(k) && u === s.url);
        if (j >= 0) {
          apply(tabs[j], s, i);
          used.add(j);
        }
      });

      // Diagnostic: how much of the saved tree did we manage to pin to live tabs?
      console.log(
        `palefox-tabs: loaded ${tabNodes.length} saved tab nodes, ` +
        `matched ${applied.size} to live tabs (of ${tabs.length}). ` +
        `Sample live URL[0]="${liveUrls[0] || ""}", ` +
        `saved URL[0]="${tabNodes[0]?.url || ""}".`
      );

      // Leftover nodes — tabs saved last session but not live right now.
      // Keyed by URL so SSTabRestoring can pick them up if the session/window
      // gets restored later (e.g. via undoCloseWindow).
      savedTabState.clear();
      tabNodes.forEach((s, i) => {
        if (applied.has(i)) return;
        const list = savedTabState.get(s.url) || [];
        list.push(s);
        savedTabState.set(s.url, list);
      });

      // Store full node list for buildPanel to reconstruct groups + order
      loadedNodes = saved.nodes;
    } catch (e) {
      console.error("palefox-tabs: loadFromDisk parse/apply error", e);
    }
  }

  let loadedNodes = null;

  // Build panel from saved node list (preserving groups + visual order)
  function buildFromSaved() {
    if (!loadedNodes || !panel) return false;
    const tabs = allTabs();
    const usedTabs = new Set();

    while (panel.firstChild !== spacer) panel.firstChild.remove();

    // Build id + URL lookup tables for matching saved nodes to live tabs.
    // Id matching (from SessionStore-pinned values) is primary; URL is fallback.
    const liveIds = tabs.map(readPinnedId);
    const liveUrls = tabs.map(tabUrl);
    for (const node of loadedNodes) {
      if (node.type === "group") {
        const row = createGroupRow(node.name, node.level || 0);
        row._group.state = node.state || null;
        row._group.collapsed = !!node.collapsed;
        syncGroupRow(row);
        panel.insertBefore(row, spacer);
      } else {
        let i = -1;
        if (node.id) {
          i = liveIds.findIndex((id, k) => !usedTabs.has(k) && id && id === node.id);
        }
        if (i < 0) {
          i = liveUrls.findIndex((u, k) => !usedTabs.has(k) && u === node.url);
        }
        if (i >= 0) {
          usedTabs.add(i);
          panel.insertBefore(createTabRow(tabs[i]), spacer);
        }
      }
    }
    // Add any tabs not in saved data (new tabs since last save)
    for (let i = 0; i < tabs.length; i++) {
      if (!usedTabs.has(i)) {
        panel.insertBefore(createTabRow(tabs[i]), spacer);
      }
    }
    loadedNodes = null;
    updateVisibility();
    return true;
  }

  // --- CSS ---

  function injectCSS() {
    const style = document.createElement("style");
    style.id = "pfx-tabs-css";
    style.textContent = `
      /* Hide native vertical tab strip */
      #vertical-tabs { display: none !important; }
      #sidebar-main > sidebar-main {
        flex: none !important;
        overflow: hidden !important;
      }

      #pfx-tab-panel {
        flex: 1 !important;
        min-height: 82% !important;
        overflow-y: auto !important;
        overflow-x: hidden !important;
        scrollbar-width: thin;
      }
      #pfx-tab-panel:focus { outline: none; }

      /* Icons-only mode (collapsed sidebar layout) */
      #pfx-tab-panel[pfx-icons-only] .pfx-tab-label,
      #pfx-tab-panel[pfx-icons-only] .pfx-tab-close {
        display: none !important;
      }
      #pfx-tab-panel[pfx-icons-only] .pfx-group-row {
        display: none !important;
      }
      #pfx-tab-panel[pfx-icons-only] .pfx-tab-row {
        width: 32px;
        height: 32px;
        padding: 8px !important;
        padding-inline-start: 8px !important;
        justify-content: center;
        margin: 2px auto;
        min-height: unset;
        box-sizing: content-box;
      }
      #pfx-tab-panel[pfx-icons-only] .pfx-tab-icon {
        margin: 0;
      }

      #pfx-tab-spacer {
        min-height: 20px;
        -moz-window-dragging: drag;
      }

      /* Shared row base */
      .pfx-tab-row, .pfx-group-row {
        padding: 5px 8px;
        padding-inline-end: 6px;
        border-radius: 4px;
        margin: 1px var(--pfx-sidebar-inset);
        min-height: 28px;
        cursor: default;
        transition: padding-inline-start 0.15s ease;
      }
      .pfx-tab-row:hover, .pfx-group-row:hover {
        background: color-mix(in srgb, currentColor 8%, transparent);
      }
      .pfx-tab-row[selected] {
        background: color-mix(in srgb, currentColor 12%, transparent);
      }

      /* Vim cursor — visible ring in normal mode */
      [pfx-cursor] {
        outline: 1px solid color-mix(in srgb, currentColor 35%, transparent);
        outline-offset: -1px;
      }
      /* Dim cursor in insert mode */
      :root[pfx-mode="insert"] [pfx-cursor] {
        outline-color: color-mix(in srgb, currentColor 10%, transparent);
      }

      /* Modeline — absolute overlay at bottom, hidden by default */
      #pfx-modeline {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        height: 20px;
        padding: 0 8px;
        font-family: monospace;
        font-size: 11px;
        line-height: 20px;
        background: color-mix(in srgb, currentColor 8%, transparent);
        border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
        z-index: 100;
        display: none;
      }
      #pfx-modeline[pfx-visible] {
        display: flex;
      }
      #pfx-modeline-mode {
        font-weight: bold;
        margin-inline-end: 12px;
      }
      #pfx-modeline-chord {
        opacity: 0.6;
      }
      #pfx-modeline-msg {
        opacity: 0.5;
        margin-inline-start: 8px;
      }
      :root[pfx-mode="normal"] #pfx-modeline-mode { color: #7aa2f7; }
      :root[pfx-mode="insert"] #pfx-modeline-mode { color: #9ece6a; }

      /* Collapse indicator */
      [pfx-collapsed] .pfx-tab-label::after {
        content: " ▸";
        opacity: 0.5;
        margin-inline-start: 4px;
      }

      /* Favicon */
      .pfx-tab-icon {
        width: 16px; height: 16px;
        margin-inline-end: 6px;
        flex-shrink: 0;
      }
      .pfx-tab-row[busy] .pfx-tab-icon { opacity: 0.4; }

      /* Multi-select */
      [pfx-multi] {
        background: color-mix(in srgb, currentColor 10%, transparent);
      }

      /* Drag and drop */
      [pfx-dragging] {
        opacity: 0.5;
        outline: 1px solid color-mix(in srgb, currentColor 40%, transparent);
        outline-offset: -1px;
      }
      #pfx-drop-indicator {
        height: 2px;
        background: color-mix(in srgb, currentColor 50%, transparent);
        margin: 0 var(--pfx-sidebar-inset);
        border-radius: 1px;
      }
      #pfx-drop-indicator[pfx-drop-child] {
        height: 0;
        border: 1px dashed color-mix(in srgb, currentColor 35%, transparent);
        margin-top: -1px;
        margin-bottom: -1px;
      }

      /* Label */
      .pfx-tab-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }

      /* Close button — hover only */
      .pfx-tab-close {
        width: 16px; height: 16px;
        margin-inline-start: 4px;
        opacity: 0; flex-shrink: 0;
        list-style-image: url("chrome://global/skin/icons/close.svg");
        -moz-context-properties: fill;
        fill: currentColor;
      }
      .pfx-tab-row:hover .pfx-tab-close { opacity: 0.5; }
      .pfx-tab-close:hover { opacity: 1 !important; cursor: pointer; }

      /* Group rows */
      .pfx-group-row {
        font-weight: 600;
        opacity: 0.85;
      }
      .pfx-group-marker {
        margin-inline-end: 6px;
        font-size: 8px;
        opacity: 0.5;
        flex-shrink: 0;
      }

      /* Search input (in modeline) */
      .pfx-search-prefix {
        font-family: monospace;
        font-size: 11px;
        font-weight: bold;
        opacity: 0.6;
        margin: 0 !important;
        padding: 0 !important;
      }
      .pfx-search-input {
        flex: 1;
        min-width: 0;
        padding: 0 !important;
        margin: 0 !important;
        border: none;
        font-family: monospace;
        font-size: 11px;
        line-height: 20px;
        background: transparent;
        color: inherit;
        outline: none;
      }

      /* Rename input */
      .pfx-rename-input {
        flex: 1; min-width: 0;
        padding: 1px 4px;
        border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
        border-radius: 2px;
        font: inherit;
        background: var(--toolbar-field-background-color, Field);
        color: var(--toolbar-field-color, FieldText);
      }

      /* Horizontal mode — replace native tab strip */
      :root[pfx-horizontal-tabs] #tabbrowser-tabs {
        display: none !important;
      }
      :root[pfx-horizontal-tabs] #TabsToolbar {
        position: relative;
        z-index: 100;
        margin-top: 6px;
      }

      #pfx-tab-panel[pfx-horizontal] {
        display: grid !important;
        grid-auto-columns: minmax(100px, 200px);
        grid-auto-rows: auto;
        justify-content: start;
        align-content: start;
        flex: none !important;
        min-height: unset !important;
        overflow: visible !important;
        z-index: 2;
        padding: 0 12px;
      }

      #pfx-tab-panel[pfx-horizontal] .pfx-tab-row,
      #pfx-tab-panel[pfx-horizontal] .pfx-group-row {
        margin: 1px;
      }

      /* Popout children — background so they're readable over content */
      #pfx-tab-panel[pfx-horizontal] [pfx-popout-child] {
        background: var(--toolbar-bgcolor, var(--sidebar-background-color));
        z-index: 3;
      }
      /* Shadow on the last child in each popout column */
      #pfx-tab-panel[pfx-horizontal] [pfx-popout-child]:not(:has(+ [pfx-popout-child])) {
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      }

      #pfx-tab-panel[pfx-horizontal] #pfx-tab-spacer {
        display: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  // --- Panel positioning ---

  function isVertical() {
    return Services.prefs.getBoolPref("sidebar.verticalTabs", true);
  }

  let toolboxResizeObs = null;

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
      if (toolboxInSidebar) {
        if (toolbox.nextElementSibling !== panel) toolbox.after(panel);
      } else if (panel.parentNode !== sidebarMain ||
                 sidebarMain.firstElementChild !== panel) {
        sidebarMain.prepend(panel);
      }
      // Popover is managed by palefox-drawer in vertical mode
    } else {
      panel.removeAttribute("pfx-icons-only");
      const tabbrowserTabs = document.getElementById("tabbrowser-tabs");
      if (tabbrowserTabs && tabbrowserTabs.nextElementSibling !== panel) {
        tabbrowserTabs.after(panel);
      }
      // Remove popover so urlbar leaves the top layer — otherwise it
      // renders above the horizontal tab popout regardless of z-index
      const urlbar = document.getElementById("urlbar");
      if (urlbar?.hasAttribute("popover")) {
        urlbar.removeAttribute("popover");
      }
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
    injectCSS();
    tryRegisterPinAttr();
    await loadFromDisk();
    await new Promise((r) => requestAnimationFrame(r));

    panel = document.createXULElement("vbox");
    panel.id = "pfx-tab-panel";

    spacer = document.createXULElement("box");
    spacer.id = "pfx-tab-spacer";
    spacer.setAttribute("flex", "1");
    panel.appendChild(spacer);

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

    // Click on spacer activates vim with last row
    spacer.addEventListener("click", () => {
      const rows = allRows().filter(r => !r.hidden);
      if (rows.length) activateVim(rows[rows.length - 1]);
    });

    // Clicking content area blurs the panel naturally via the blur listener.

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
})();
