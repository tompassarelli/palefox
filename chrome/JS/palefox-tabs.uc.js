// ==UserScript==
// @name           Palefox Tabs
// @description    Tree-style tab panel with vim keybindings
// @include        main
// ==/UserScript==

(() => {
  // src/tabs/state.ts
  var state = {
    panel: null,
    spacer: null,
    pinnedContainer: null,
    contextTab: null,
    contextGroupRow: null,
    cursor: null,
    nextTabId: 1,
    inSessionRestore: true,
    lastLoadedNodes: []
  };
  var treeOf = new WeakMap;
  var rowOf = new WeakMap;
  var hzDisplay = new WeakMap;
  var savedTabQueue = [];
  var closedTabs = [];
  var selection = new Set;
  var movingTabs = new Set;

  // src/tabs/constants.ts
  var INDENT = 14;
  var CHORD_TIMEOUT = 500;
  var CLOSED_MEMORY = 32;
  var PIN_ATTR = "pfx-id";

  // src/tabs/log.ts
  var LOG_FILENAME = "palefox-debug.log";
  var LOG_MAX_BYTES = 5 * 1024 * 1024;
  var _logPath = null;
  var _rotateChecked = false;
  function logPath() {
    if (_logPath)
      return _logPath;
    _logPath = PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, LOG_FILENAME);
    return _logPath;
  }
  function maybeRotate() {
    if (_rotateChecked)
      return;
    _rotateChecked = true;
    IOUtils.stat(logPath()).then((info) => {
      if (info.size > LOG_MAX_BYTES) {
        return IOUtils.write(logPath(), new Uint8Array(0), { mode: "overwrite" });
      }
    }).catch(() => {});
  }
  var _lines = [];
  var _flushPending = false;
  function flush() {
    const batch = _lines.splice(0);
    if (!batch.length) {
      _flushPending = false;
      return;
    }
    const blob = new TextEncoder().encode(batch.join(`
`) + `
`);
    const path = logPath();
    IOUtils.write(path, blob, { mode: "appendOrCreate" }).then(() => {
      if (_lines.length)
        flush();
      else
        _flushPending = false;
    }).catch((e) => {
      console.error("[PFX:log] write failed", e);
      _flushPending = false;
    });
  }
  function createLogger(tag) {
    const consolePrefix = `[PFX:${tag}]`;
    return (event, data = {}) => {
      if (!Services.prefs.getBoolPref("pfx.debug", false))
        return;
      maybeRotate();
      console.log(consolePrefix, event, data);
      _lines.push(`${Date.now()} [${tag}] ${event} ${JSON.stringify(data)}`);
      if (!_flushPending) {
        _flushPending = true;
        Promise.resolve().then(flush);
      }
    };
  }

  // src/tabs/helpers.ts
  var log = createLogger("tabs");
  var SS = (() => {
    try {
      if (typeof SessionStore !== "undefined")
        return SessionStore;
    } catch {}
    try {
      return ChromeUtils.importESModule("resource:///modules/sessionstore/SessionStore.sys.mjs").SessionStore;
    } catch (e) {
      console.error("palefox-tabs: SessionStore unavailable", e);
      return null;
    }
  })();
  var pinAttrRegistered = false;
  function tryRegisterPinAttr() {
    if (pinAttrRegistered || !SS?.persistTabAttribute)
      return;
    try {
      SS.persistTabAttribute(PIN_ATTR);
      pinAttrRegistered = true;
    } catch (e) {
      console.error("palefox-tabs: persistTabAttribute failed", e);
    }
  }
  function pinTabId(tab, id) {
    try {
      tab.setAttribute(PIN_ATTR, String(id));
    } catch {}
  }
  function readPinnedId(tab) {
    try {
      const v = tab.getAttribute?.(PIN_ATTR);
      if (v) {
        const n = Number(v);
        if (n)
          return n;
      }
    } catch {}
    return 0;
  }
  function treeData(tab) {
    if (!treeOf.has(tab)) {
      let id = readPinnedId(tab);
      if (id) {
        if (id >= state.nextTabId)
          state.nextTabId = id + 1;
        log("treeData:pfxId", { pfxId: id, label: tab.label, nextTabId: state.nextTabId });
      } else {
        id = state.nextTabId++;
        pinTabId(tab, id);
        log("treeData:fresh", { id, label: tab.label, nextTabId: state.nextTabId });
      }
      treeOf.set(tab, {
        id,
        parentId: null,
        name: null,
        state: null,
        collapsed: false
      });
    }
    return treeOf.get(tab);
  }
  function tabById(id) {
    if (id == null || typeof id !== "number" || !id)
      return null;
    for (const t of gBrowser.tabs) {
      if (treeOf.get(t)?.id === id)
        return t;
    }
    return null;
  }
  function groupById(id) {
    if (!id)
      return null;
    for (const row of allRows()) {
      if (row._group?.id === id)
        return row;
    }
    return null;
  }
  function parentOfTab(tab) {
    return tabById(treeData(tab).parentId);
  }
  function levelOf(tab) {
    let lv = 0;
    let t = tab;
    const seen = new Set;
    while (t && !seen.has(t)) {
      seen.add(t);
      const pid = treeData(t).parentId;
      if (pid == null)
        break;
      if (typeof pid === "string") {
        const group = groupById(pid);
        if (!group || !group._group)
          break;
        return lv + 1 + (group._group.level || 0);
      }
      const p = tabById(pid);
      if (!p)
        break;
      lv++;
      t = p;
    }
    return lv;
  }
  function levelOfRow(row) {
    if (!row)
      return 0;
    if (row._group)
      return row._group.level || 0;
    if (row._tab)
      return levelOf(row._tab);
    return 0;
  }
  function dataOf(row) {
    if (row._group)
      return row._group;
    if (row._tab)
      return treeData(row._tab);
    return null;
  }
  function allTabs() {
    return [...gBrowser.tabs];
  }
  function allRows() {
    const pinned = state.pinnedContainer ? [...state.pinnedContainer.querySelectorAll(".pfx-tab-row")] : [];
    const treeRows = state.panel ? [...state.panel.querySelectorAll(".pfx-tab-row, .pfx-group-row")] : [];
    return [...pinned, ...treeRows];
  }
  function hasChildren(row) {
    const next = row.nextElementSibling;
    if (!next || next === state.spacer)
      return false;
    return levelOfRow(next) > levelOfRow(row);
  }
  function subtreeRows(row) {
    if (!row)
      return [];
    const lv = levelOfRow(row);
    const out = [row];
    let next = row.nextElementSibling;
    while (next && next !== state.spacer) {
      if (levelOfRow(next) <= lv)
        break;
      out.push(next);
      next = next.nextElementSibling;
    }
    return out;
  }
  function isHorizontal() {
    return !!state.panel?.hasAttribute("pfx-horizontal");
  }
  function tabUrl(tab) {
    if (!tab)
      return "";
    const spec = tab.linkedBrowser?.currentURI?.spec;
    if (spec && spec !== "about:blank")
      return spec;
    if (SS) {
      try {
        const raw = SS.getTabState(tab);
        if (raw) {
          const ts = JSON.parse(raw);
          const entries = ts.entries;
          if (Array.isArray(entries) && entries.length) {
            const idx = Math.max(0, Math.min(entries.length - 1, (ts.index || 1) - 1));
            const entryUrl = entries[idx]?.url;
            if (entryUrl)
              return entryUrl;
          }
        }
      } catch (e) {
        console.error("palefox-tabs: getTabState failed", e);
      }
    }
    return spec || "";
  }

  // src/tabs/menu.ts
  function buildContextMenu(deps) {
    const {
      startRename,
      toggleCollapse,
      createGroupRow,
      setCursor,
      updateVisibility,
      scheduleSave
    } = deps;
    const menu = document.createXULElement("menupopup");
    menu.id = "pfx-tab-menu";
    function mi(label, handler) {
      const item = document.createXULElement("menuitem");
      item.setAttribute("label", label);
      item.addEventListener("command", handler);
      return item;
    }
    const sep = () => document.createXULElement("menuseparator");
    const renameItem = mi("Rename Tab", () => {
      if (state.contextTab) {
        const row = rowOf.get(state.contextTab);
        if (row)
          startRename(row);
      }
    });
    const collapseItem = mi("Collapse", () => {
      if (!state.contextTab)
        return;
      const row = rowOf.get(state.contextTab);
      if (row)
        toggleCollapse(row);
    });
    const createGroupItem = mi("Create Group", () => {
      if (!state.contextTab)
        return;
      const row = rowOf.get(state.contextTab);
      if (!row)
        return;
      const grp = createGroupRow("New Group", levelOfRow(row));
      const st = subtreeRows(row);
      st[st.length - 1].after(grp);
      setCursor(grp);
      updateVisibility();
      scheduleSave();
      startRename(grp);
    });
    const closeKidsItem = mi("Close Children", () => {
      if (!state.contextTab)
        return;
      const row = rowOf.get(state.contextTab);
      if (!row)
        return;
      const kids = subtreeRows(row).slice(1);
      for (let i = kids.length - 1;i >= 0; i--) {
        const k = kids[i];
        if (k._tab)
          gBrowser.removeTab(k._tab);
        else
          k.remove();
      }
    });
    const splitViewItem = mi("Add Split View", () => {
      if (!state.contextTab)
        return;
      TabContextMenu.contextTab = state.contextTab;
      TabContextMenu.contextTabs = [state.contextTab];
      TabContextMenu.moveTabsToSplitView?.();
    });
    const reloadItem = mi("Reload Tab", () => {
      if (state.contextTab)
        gBrowser.reloadTab(state.contextTab);
    });
    const muteItem = mi("Mute Tab", () => {
      if (state.contextTab)
        state.contextTab.toggleMuteAudio();
    });
    const pinItem = mi("Pin Tab", () => {
      if (!state.contextTab)
        return;
      if (state.contextTab.pinned)
        gBrowser.unpinTab(state.contextTab);
      else
        gBrowser.pinTab(state.contextTab);
    });
    const duplicateItem = mi("Duplicate Tab", () => {
      if (state.contextTab)
        gBrowser.duplicateTab(state.contextTab);
    });
    const bookmarkItem = mi("Bookmark Tab", () => {
      if (state.contextTab)
        PlacesCommandHook.bookmarkTabs?.([state.contextTab]);
    });
    const moveToWindowItem = mi("Move to New Window", () => {
      if (state.contextTab)
        gBrowser.replaceTabWithWindow(state.contextTab);
    });
    const copyLinkItem = mi("Copy Link", () => {
      if (!state.contextTab)
        return;
      const url = state.contextTab.linkedBrowser?.currentURI?.spec;
      if (url) {
        const helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);
        helper.copyString(url);
      }
    });
    const closeItem = mi("Close Tab", () => {
      if (state.contextTab)
        gBrowser.removeTab(state.contextTab);
    });
    const reopenItem = mi("Reopen Closed Tab", () => {
      undoCloseTab();
    });
    menu.append(renameItem, collapseItem, createGroupItem, closeKidsItem, sep(), splitViewItem, reloadItem, muteItem, pinItem, duplicateItem, sep(), bookmarkItem, copyLinkItem, moveToWindowItem, sep(), closeItem, reopenItem);
    menu.addEventListener("popupshowing", () => {
      if (!state.contextTab)
        return;
      const row = rowOf.get(state.contextTab);
      const has = !!row && hasChildren(row);
      collapseItem.hidden = !has;
      closeKidsItem.hidden = !has;
      if (has && row) {
        const d = dataOf(row);
        collapseItem.setAttribute("label", d?.collapsed ? "Expand" : "Collapse");
      }
      muteItem.setAttribute("label", state.contextTab.hasAttribute("muted") ? "Unmute Tab" : "Mute Tab");
      pinItem.setAttribute("label", state.contextTab.pinned ? "Unpin Tab" : "Pin Tab");
      splitViewItem.hidden = !!state.contextTab.splitview;
    });
    document.getElementById("mainPopupSet").appendChild(menu);
    return menu;
  }
  function buildGroupContextMenu(deps) {
    const { startRename, toggleCollapse, syncGroupRow, updateVisibility, scheduleSave } = deps;
    const menu = document.createXULElement("menupopup");
    menu.id = "pfx-group-menu";
    function mi(label, handler) {
      const item = document.createXULElement("menuitem");
      item.setAttribute("label", label);
      item.addEventListener("command", handler);
      return item;
    }
    const sep = () => document.createXULElement("menuseparator");
    const renameItem = mi("Rename Group", () => {
      if (state.contextGroupRow)
        startRename(state.contextGroupRow);
    });
    const collapseItem = mi("Collapse", () => {
      if (state.contextGroupRow)
        toggleCollapse(state.contextGroupRow);
    });
    const closeGroupItem = mi("Close Group", () => {
      const row = state.contextGroupRow;
      if (!row || !row._group)
        return;
      const myLevel = row._group.level || 0;
      const groupId = row._group.id;
      for (const tab of gBrowser.tabs) {
        const td = treeData(tab);
        if (td.parentId === groupId)
          td.parentId = null;
      }
      let next = row.nextElementSibling;
      while (next && next !== state.spacer) {
        const lv = levelOfRow(next);
        if (lv <= myLevel)
          break;
        if (next._group) {
          next._group.level = Math.max(0, (next._group.level || 0) - 1);
          syncGroupRow(next);
        }
        next = next.nextElementSibling;
      }
      row.remove();
      updateVisibility();
      scheduleSave();
    });
    const closeTabsItem = mi("Close Tabs in Group", () => {
      const row = state.contextGroupRow;
      if (!row)
        return;
      const tabsInGroup = subtreeRows(row).slice(1).filter((r) => r._tab).map((r) => r._tab);
      for (let i = tabsInGroup.length - 1;i >= 0; i--) {
        gBrowser.removeTab(tabsInGroup[i]);
      }
    });
    const moveToWindowItem = mi("Move Tabs to New Window", () => {
      const row = state.contextGroupRow;
      if (!row)
        return;
      const tabsInGroup = subtreeRows(row).slice(1).filter((r) => r._tab).map((r) => r._tab);
      if (!tabsInGroup.length)
        return;
      if (typeof gBrowser.replaceTabsWithWindow === "function") {
        gBrowser.replaceTabsWithWindow(tabsInGroup);
      } else {
        gBrowser.replaceTabWithWindow(tabsInGroup[0]);
      }
    });
    menu.append(renameItem, collapseItem, closeTabsItem, sep(), closeGroupItem, moveToWindowItem);
    menu.addEventListener("popupshowing", () => {
      const row = state.contextGroupRow;
      if (!row || !row._group)
        return;
      const has = hasChildren(row);
      collapseItem.hidden = !has;
      if (has) {
        collapseItem.setAttribute("label", row._group.collapsed ? "Expand" : "Collapse");
      }
      closeTabsItem.hidden = !has;
      moveToWindowItem.hidden = !has;
    });
    document.getElementById("mainPopupSet").appendChild(menu);
    return menu;
  }

  // src/tabs/drag.ts
  var log2 = createLogger("tabs/drag");
  function rowDesc(row) {
    if (!row)
      return { row: "null" };
    if (row._tab) {
      return {
        kind: "tab",
        id: treeData(row._tab).id,
        label: row._tab.label,
        level: levelOf(row._tab),
        pinned: !!row._tab.pinned,
        parentId: treeData(row._tab).parentId
      };
    }
    if (row._group) {
      return {
        kind: "group",
        id: row._group.id,
        name: row._group.name,
        level: row._group.level
      };
    }
    return { kind: "?" };
  }
  function findGroupContextParent(group) {
    const id = group._group?.id ?? null;
    log2("findGroupContextParent", {
      groupId: id,
      groupLevel: group._group?.level ?? 0
    });
    return id;
  }
  function findClosestTabBefore(row) {
    let prev = row.previousElementSibling;
    while (prev) {
      if (prev._tab)
        return prev._tab;
      prev = prev.previousElementSibling;
    }
    return null;
  }
  function findLastTabInGroupOrBefore(group) {
    const subtreeTabs = subtreeRows(group).slice(1).filter((r) => r._tab).map((r) => r._tab);
    if (subtreeTabs.length)
      return subtreeTabs[subtreeTabs.length - 1];
    return findClosestTabBefore(group);
  }
  function makeDrag(deps) {
    const { clearSelection, scheduleTreeResync, scheduleSave } = deps;
    let dragSource = null;
    let dropIndicator = null;
    let dropTarget = null;
    let dropPosition = null;
    function setupDrag(row) {
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        const t = e.target;
        if (t.classList?.contains("pfx-tab-close")) {
          e.preventDefault();
          return;
        }
        dragSource = row;
        log2("dragstart", { source: rowDesc(row) });
        const dt = e.dataTransfer;
        dt.effectAllowed = "move";
        dt.setData("text/plain", "");
        row.setAttribute("pfx-dragging", "true");
        if (state.pinnedContainer && !row._tab?.pinned && !state.pinnedContainer.querySelector(".pfx-tab-row")) {
          state.pinnedContainer.hidden = false;
          state.pinnedContainer.setAttribute("pfx-empty-zone", "true");
        }
        if (state.panel && row._tab?.pinned && !state.panel.querySelector(".pfx-tab-row, .pfx-group-row")) {
          state.panel.setAttribute("pfx-empty-zone", "true");
        }
      });
      row.addEventListener("dragend", () => {
        log2("dragend/row", {
          listenerOnRow: rowDesc(row),
          sourceWas: dragSource ? rowDesc(dragSource) : "already-null",
          dropTargetWas: dropTarget instanceof HTMLElement && dropTarget._tab ? rowDesc(dropTarget) : dropTarget instanceof HTMLElement && dropTarget._group ? rowDesc(dropTarget) : dropTarget === state.panel ? "panel" : dropTarget === state.pinnedContainer ? "pinnedContainer" : "other",
          dropPositionWas: dropPosition
        });
        dragSource?.removeAttribute("pfx-dragging");
        dragSource = null;
        clearDropIndicator();
        if (state.pinnedContainer?.hasAttribute("pfx-empty-zone")) {
          state.pinnedContainer.removeAttribute("pfx-empty-zone");
          if (!state.pinnedContainer.querySelector(".pfx-tab-row")) {
            state.pinnedContainer.hidden = true;
          }
        }
        state.panel?.removeAttribute("pfx-empty-zone");
      });
      let lastLoggedPos = null;
      row.addEventListener("dragover", (e) => {
        if (!dragSource || dragSource === row)
          return;
        if (subtreeRows(dragSource).includes(row))
          return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = row.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const horizontal = isHorizontal();
        let posBranch;
        if (horizontal) {
          if (y > rect.height * 2 / 3) {
            dropPosition = "child";
            posBranch = "hz/y>2/3→child";
          } else if (x < rect.width / 2) {
            dropPosition = "before";
            posBranch = "hz/x<w/2→before";
          } else {
            dropPosition = "after";
            posBranch = "hz/x>=w/2→after";
          }
        } else {
          const zone = rect.height / 3;
          if (y < zone) {
            dropPosition = "before";
            posBranch = "vt/y<1/3→before";
          } else if (y > zone * 2) {
            dropPosition = "after";
            posBranch = "vt/y>2/3→after";
          } else {
            dropPosition = "child";
            posBranch = "vt/middle→child";
          }
        }
        dropTarget = row;
        if (row._group || lastLoggedPos !== dropPosition) {
          log2("dragover", {
            target: rowDesc(row),
            source: rowDesc(dragSource),
            position: dropPosition,
            posBranch,
            rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
            mouse: { x: Math.round(x), y: Math.round(y) },
            horizontal
          });
          lastLoggedPos = dropPosition;
        }
        showDropIndicator(row, dropPosition);
      });
      row.addEventListener("dragleave", (e) => {
        const related = e.relatedTarget;
        if (!row.contains(related)) {
          if (dropTarget === row)
            clearDropIndicator();
        }
      });
      row.addEventListener("drop", (e) => {
        log2("drop/row:fired", {
          listenerOnRow: rowDesc(row),
          eventTarget: e.target?.className || e.target?.tagName,
          hasDragSource: !!dragSource,
          sourceEqualsRow: dragSource === row
        });
        e.preventDefault();
        if (!dragSource) {
          log2("drop/row:abort", { reason: "no-dragSource" });
          return;
        }
        if (dragSource === row) {
          log2("drop/row:abort", { reason: "source-equals-row" });
          return;
        }
        if (subtreeRows(dragSource).includes(row)) {
          log2("drop/row:abort", { reason: "row-in-source-subtree" });
          return;
        }
        log2("drop/row:proceeding", {
          target: rowDesc(row),
          source: rowDesc(dragSource),
          position: dropPosition
        });
        if (dropPosition && dropPosition !== "into-empty-pinned" && dropPosition !== "into-empty-panel") {
          executeDrop(dragSource, row, dropPosition);
        } else {
          log2("drop/row:abort", { reason: "no-or-empty-zone-position", dropPosition });
        }
        clearDropIndicator();
      });
    }
    function setupPinnedContainerDrop(container) {
      container.addEventListener("dragover", (e) => {
        if (!dragSource || dragSource._tab?.pinned)
          return;
        if (e.target !== container)
          return;
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
        log2("drop/pinnedContainer:fired", {
          eventTarget: e.target?.id || e.target?.className || e.target?.tagName,
          hasDragSource: !!dragSource,
          srcPinned: !!dragSource?._tab?.pinned
        });
        if (!dragSource || dragSource._tab?.pinned)
          return;
        if (e.target !== container && dropTarget !== container)
          return;
        e.preventDefault();
        const tab = dragSource._tab;
        if (!tab) {
          clearDropIndicator();
          return;
        }
        if (dropTarget === container) {
          gBrowser.pinTab(tab);
        } else if (dropTarget?._tab && dropPosition) {
          executeDrop(dragSource, dropTarget, dropPosition);
        }
        clearDropIndicator();
      });
    }
    function setupPanelDrop(p) {
      p.addEventListener("dragover", (e) => {
        if (!dragSource)
          return;
        const eventTargetDesc = e.target?.id || e.target?.className || e.target?.tagName;
        if (e.target !== p && e.target !== state.spacer) {
          log2("dragover/panel:skip", { eventTarget: eventTargetDesc });
          return;
        }
        const srcPinned = !!dragSource._tab?.pinned;
        let anchor = null;
        if (srcPinned) {
          anchor = p.querySelector(".pfx-tab-row:last-of-type, .pfx-group-row:last-of-type");
        } else {
          const srcSubtree = new Set(subtreeRows(dragSource));
          const rows = [...p.querySelectorAll(".pfx-tab-row, .pfx-group-row")];
          for (let i = rows.length - 1;i >= 0; i--) {
            const candidate = rows[i];
            if (levelOfRow(candidate) === 0 && !srcSubtree.has(candidate)) {
              anchor = candidate;
              break;
            }
          }
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (anchor) {
          dropTarget = anchor;
          dropPosition = "after";
          log2("dragover/panel:anchor", {
            eventTarget: eventTargetDesc,
            anchor: rowDesc(anchor),
            position: "after"
          });
          showDropIndicator(anchor, "after");
        } else {
          dropTarget = srcPinned ? p : null;
          dropPosition = "into-empty-panel";
          log2("dragover/panel:noAnchor", {
            eventTarget: eventTargetDesc,
            srcPinned
          });
        }
      });
      p.addEventListener("drop", (e) => {
        log2("drop/panel:fired", {
          eventTarget: e.target?.id || e.target?.className || e.target?.tagName,
          eventTargetIsPanel: e.target === p,
          eventTargetIsSpacer: e.target === state.spacer,
          hasDragSource: !!dragSource
        });
        if (!dragSource)
          return;
        if (e.target !== p && e.target !== state.spacer && dropTarget !== p)
          return;
        e.preventDefault();
        const tab = dragSource._tab;
        if (!tab) {
          clearDropIndicator();
          return;
        }
        if (dropTarget === p) {
          if (tab.pinned)
            gBrowser.unpinTab(tab);
        } else if (dropTarget && dropTarget._tab || dropTarget?._group) {
          if (dropPosition)
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
      dropIndicator.removeAttribute("pfx-fixed");
      dropIndicator.style.cssText = "";
      log2("showDropIndicator", {
        target: rowDesc(targetRow),
        position,
        horizontal: isHorizontal(),
        rect: targetRow.getBoundingClientRect ? (() => {
          const r = targetRow.getBoundingClientRect();
          return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        })() : null
      });
      if (isHorizontal()) {
        if (!dropIndicator.parentNode) {
          document.documentElement.appendChild(dropIndicator);
        } else if (dropIndicator.parentNode !== document.documentElement) {
          document.documentElement.appendChild(dropIndicator);
        }
        const rect = targetRow.getBoundingClientRect();
        dropIndicator.setAttribute("pfx-fixed", "true");
        if (position === "child") {
          dropIndicator.setAttribute("pfx-drop-child", "true");
          Object.assign(dropIndicator.style, {
            position: "fixed",
            left: rect.left + "px",
            top: rect.bottom - 1 + "px",
            width: rect.width + "px",
            height: "2px"
          });
        } else {
          const xEdge = position === "before" ? rect.left - 1 : rect.right - 1;
          Object.assign(dropIndicator.style, {
            position: "fixed",
            left: xEdge + "px",
            top: rect.top + "px",
            width: "2px",
            height: rect.height + "px"
          });
        }
        return;
      }
      if (position === "child") {
        dropIndicator.setAttribute("pfx-drop-child", "true");
        targetRow.after(dropIndicator);
        dropIndicator.style.marginInlineStart = (levelOfRow(targetRow) + 1) * INDENT + 8 + "px";
      } else if (position === "before") {
        targetRow.before(dropIndicator);
        dropIndicator.style.marginInlineStart = levelOfRow(targetRow) * INDENT + 8 + "px";
      } else {
        const st = subtreeRows(targetRow);
        st[st.length - 1].after(dropIndicator);
        dropIndicator.style.marginInlineStart = levelOfRow(targetRow) * INDENT + 8 + "px";
      }
    }
    function clearDropIndicator() {
      dropIndicator?.remove();
      dropTarget = null;
      dropPosition = null;
    }
    function executeDrop(srcRow, tgtRow, position) {
      const tgtLevel = levelOfRow(tgtRow);
      if (!dataOf(tgtRow)) {
        log2("executeDrop:abort", { reason: "no-tgt-data", target: rowDesc(tgtRow) });
        return;
      }
      const srcPinned = !!srcRow._tab?.pinned;
      const tgtPinned = !!tgtRow._tab?.pinned;
      const isCrossContainer = srcPinned !== tgtPinned;
      log2("executeDrop:enter", {
        source: rowDesc(srcRow),
        target: rowDesc(tgtRow),
        position,
        srcPinned,
        tgtPinned,
        isCrossContainer,
        tgtLevel
      });
      let movedRows;
      if (isCrossContainer) {
        movedRows = srcRow._tab ? [srcRow] : [];
      } else if (selection.size > 1 && selection.has(srcRow)) {
        movedRows = [...allRows()].filter((r) => selection.has(r));
      } else {
        movedRows = subtreeRows(srcRow);
      }
      if (!movedRows.length) {
        log2("executeDrop:abort", { reason: "no-movedRows" });
        return;
      }
      const srcLevel = levelOfRow(movedRows[0]);
      const newSrcLevel = position === "child" ? tgtLevel + 1 : tgtLevel;
      const delta = newSrcLevel - srcLevel;
      log2("executeDrop:plan", {
        movedRowsCount: movedRows.length,
        movedRowsKinds: movedRows.map((r) => r._tab ? "tab" : r._group ? "group" : "?"),
        srcLevel,
        newSrcLevel,
        delta
      });
      let newParentForSource = null;
      let parentBranch;
      if (tgtRow._tab) {
        parentBranch = position === "child" ? "tab/child→tgtId" : "tab/sibling→tgtParentId";
        newParentForSource = position === "child" ? treeData(tgtRow._tab).id : treeData(tgtRow._tab).parentId;
      } else if (tgtRow._group) {
        parentBranch = "group→groupId";
        newParentForSource = findGroupContextParent(tgtRow);
      } else {
        parentBranch = "no-tab-no-group→null";
      }
      log2("executeDrop:newParent", { branch: parentBranch, newParentForSource });
      const movedSet = new Set(movedRows);
      let parentIdMutations = 0;
      for (const r of movedRows) {
        if (!r._tab) {
          if (r._group)
            r._group.level = Math.max(0, (r._group.level || 0) + delta);
          continue;
        }
        const td = treeData(r._tab);
        const parent = tabById(td.parentId ?? 0);
        if (!parent || !movedSet.has(rowOf.get(parent))) {
          const oldPid = td.parentId;
          td.parentId = newParentForSource;
          parentIdMutations++;
          log2("executeDrop:mutate", {
            tab: r._tab.label,
            tabId: td.id,
            oldParentId: oldPid,
            newParentId: newParentForSource
          });
        }
      }
      log2("executeDrop:mutations", { parentIdMutations });
      const movedTabs = movedRows.filter((r) => r._tab).map((r) => r._tab);
      if (isCrossContainer) {
        for (const t of movedTabs) {
          if (tgtPinned && !t.pinned)
            gBrowser.pinTab(t);
          else if (!tgtPinned && t.pinned)
            gBrowser.unpinTab(t);
        }
      }
      const tabsArr = [...gBrowser.tabs];
      let targetIdx;
      let idxBranch;
      if (tgtRow._group) {
        const anchorTab = position === "before" ? findClosestTabBefore(tgtRow) : findLastTabInGroupOrBefore(tgtRow);
        if (anchorTab) {
          targetIdx = tabsArr.indexOf(anchorTab) + 1;
          idxBranch = `group/${position}→after-anchor(${anchorTab.label || "?"}@${tabsArr.indexOf(anchorTab)})`;
        } else {
          targetIdx = tabsArr.length;
          idxBranch = `group/${position}→no-anchor→end(${tabsArr.length})`;
        }
      } else if (position === "before") {
        targetIdx = tabsArr.indexOf(tgtRow._tab);
        idxBranch = `tab/before→${targetIdx}`;
      } else {
        const tgtSubtreeTab = [...subtreeRows(tgtRow)].reverse().find((r) => r._tab)?._tab;
        targetIdx = (tgtSubtreeTab ? tabsArr.indexOf(tgtSubtreeTab) : tabsArr.indexOf(tgtRow._tab)) + 1;
        idxBranch = `tab/${position}→after-${tgtSubtreeTab ? "subtreeLast" : "self"}→${targetIdx}`;
      }
      if (targetIdx < 0) {
        idxBranch += `→clamp(${tabsArr.length})`;
        targetIdx = tabsArr.length;
      }
      log2("executeDrop:targetIdx", { idxBranch, targetIdx, tabsLen: tabsArr.length });
      for (const t of movedTabs)
        movingTabs.add(t);
      let insertIdx = targetIdx;
      let actualMoves = 0;
      for (const t of movedTabs) {
        const currentIdx = [...gBrowser.tabs].indexOf(t);
        if (currentIdx < 0)
          continue;
        if (currentIdx < insertIdx)
          insertIdx--;
        if (currentIdx !== insertIdx) {
          log2("executeDrop:moveTabTo", {
            tab: t.label,
            currentIdx,
            insertIdx
          });
          gBrowser.moveTabTo(t, { tabIndex: insertIdx });
          actualMoves++;
        }
        insertIdx++;
      }
      log2("executeDrop:moveSummary", { actualMoves, totalTabs: movedTabs.length });
      const groupRows = movedRows.filter((r) => r._group);
      if (groupRows.length) {
        if (position === "before") {
          tgtRow.before(...groupRows);
        } else {
          const st = subtreeRows(tgtRow);
          const anchorRows = st.filter((r) => !movedRows.includes(r));
          const anchor = anchorRows.length ? anchorRows[anchorRows.length - 1] : tgtRow;
          anchor.after(...groupRows);
        }
        log2("executeDrop:groupDOMMove", { groupRowsCount: groupRows.length });
      }
      clearSelection();
      requestAnimationFrame(() => {
        for (const t of movedTabs)
          movingTabs.delete(t);
        for (const t of movedTabs) {
          const row = rowOf.get(t);
          if (row)
            row.toggleAttribute("busy", t.hasAttribute("busy"));
        }
        log2("executeDrop:settled", {
          sourceFinal: rowDesc(srcRow),
          sourceParentInTree: srcRow._tab ? treeData(srcRow._tab).parentId : null,
          sourceLevelDerived: srcRow._tab ? levelOf(srcRow._tab) : null,
          sourceDOMParent: srcRow.parentNode === state.panel ? "panel" : srcRow.parentNode === state.pinnedContainer ? "pinnedContainer" : "?",
          sourcePrevSibling: rowDesc(srcRow.previousElementSibling || null),
          sourceNextSibling: rowDesc(srcRow.nextElementSibling || null)
        });
        scheduleTreeResync();
        scheduleSave();
      });
    }
    return { setupDrag, setupPinnedContainerDrop, setupPanelDrop };
  }

  // src/tabs/snapshot.ts
  function buildEnvelope(snapshot) {
    const tabEntries = snapshot.tabs.map((tab) => {
      const d = snapshot.treeData(tab);
      return {
        id: d.id,
        parentId: d.parentId ?? null,
        url: snapshot.tabUrl(tab),
        name: d.name,
        state: d.state,
        collapsed: d.collapsed
      };
    });
    const groupEntries = [];
    let lastSeenTabId = null;
    for (const row of snapshot.rows()) {
      if (row._tab) {
        lastSeenTabId = snapshot.treeData(row._tab).id;
      } else if (row._group) {
        groupEntries.push({
          id: 0,
          parentId: null,
          type: "group",
          name: row._group.name,
          level: row._group.level,
          state: row._group.state,
          collapsed: row._group.collapsed,
          afterTabId: lastSeenTabId
        });
      }
    }
    const liveUrls = new Set(tabEntries.map((e) => e.url).filter(Boolean));
    const leftovers = snapshot.savedTabQueue.filter((s) => !s.url || !liveUrls.has(s.url)).map((s) => ({ ...s }));
    const out = [...tabEntries, ...groupEntries, ...leftovers];
    return {
      nodes: out,
      closedTabs: snapshot.closedTabs.slice(-CLOSED_MEMORY),
      nextTabId: snapshot.nextTabId
    };
  }
  function makeSaver(getSnapshot, history, onError = (e) => console.error("palefox-tabs: save chain", e)) {
    let inFlight = false;
    let pending = false;
    function scheduleSave() {
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      (async () => {
        try {
          await history.appendEvent(buildEnvelope(getSnapshot()));
        } catch (e) {
          onError(e);
        }
        inFlight = false;
        if (pending) {
          pending = false;
          scheduleSave();
        }
      })();
    }
    return scheduleSave;
  }
  function popSavedByUrl(queue, url) {
    if (!url)
      return null;
    const i = queue.findIndex((s) => s.url === url);
    return i >= 0 ? queue.splice(i, 1)[0] : null;
  }
  function popSavedForTab(queue, ctx) {
    const { currentIdx, pinnedId, url, inSessionRestore, log: log3 } = ctx;
    if (pinnedId) {
      const i = queue.findIndex((s) => s.id === pinnedId);
      if (i >= 0) {
        log3?.("popSavedForTab:pfxId", { idx: currentIdx, pfxId: pinnedId, url });
        return queue.splice(i, 1)[0];
      }
    }
    if (url && url !== "about:blank") {
      const node2 = popSavedByUrl(queue, url);
      log3?.("popSavedForTab:url", { idx: currentIdx, url, found: !!node2 });
      return node2;
    }
    if (!inSessionRestore)
      return null;
    const node = queue.length ? queue.shift() : null;
    log3?.("popSavedForTab:fifo", {
      idx: currentIdx,
      pfxId: pinnedId,
      url,
      nodeId: node?.id,
      nodeOrigIdx: node?._origIdx
    });
    return node;
  }

  // src/tabs/events.ts
  var log3 = createLogger("tabs");
  function makeEvents(deps) {
    const { rows, vim, scheduleSave } = deps;
    function popSavedByUrl2(url) {
      return popSavedByUrl(savedTabQueue, url);
    }
    function popSavedForTab2(tab) {
      return popSavedForTab(savedTabQueue, {
        currentIdx: [...gBrowser.tabs].indexOf(tab),
        pinnedId: readPinnedId(tab),
        url: tabUrl(tab),
        inSessionRestore: state.inSessionRestore,
        log: log3
      });
    }
    function popClosedEntry(url) {
      if (!url)
        return null;
      for (let i = closedTabs.length - 1;i >= 0; i--) {
        const entry = closedTabs[i];
        if (entry.url === url)
          return closedTabs.splice(i, 1)[0];
      }
      return null;
    }
    function applySavedToTab(tab, prior) {
      const td = treeData(tab);
      if (td.appliedSavedState)
        return;
      td.appliedSavedState = true;
      td.id = prior.id || td.id;
      td.parentId = prior.parentId ?? null;
      td.name = prior.name || null;
      td.state = prior.state || null;
      td.collapsed = !!prior.collapsed;
      pinTabId(tab, td.id);
      log3("applySavedToTab", {
        id: td.id,
        parentId: td.parentId,
        priorId: prior.id,
        priorParentId: prior.parentId
      });
      rows.scheduleTreeResync();
    }
    function rememberClosedTab(tab, td) {
      const url = tabUrl(tab);
      if (!url || url === "about:blank")
        return;
      const row = rowOf.get(tab);
      if (!row)
        return;
      const parent = parentOfTab(tab);
      const myLevel = levelOf(tab);
      let prevSiblingId = null;
      let r = row.previousElementSibling;
      while (r) {
        if (r._tab) {
          const lvl = levelOf(r._tab);
          if (lvl < myLevel)
            break;
          if (lvl === myLevel) {
            prevSiblingId = treeData(r._tab).id;
            break;
          }
        }
        r = r.previousElementSibling;
      }
      const descendantIds = [];
      let n = row.nextElementSibling;
      while (n && n !== state.spacer) {
        if (n._tab) {
          const lvl = levelOf(n._tab);
          if (lvl <= myLevel)
            break;
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
        collapsed: !!td?.collapsed
      });
      if (closedTabs.length > CLOSED_MEMORY)
        closedTabs.shift();
    }
    function isFxPinned(tab) {
      if (tab.pinned)
        return true;
      const ptc = gBrowser.tabContainer?.pinnedTabsContainer || gBrowser.pinnedTabsContainer;
      return !!ptc && tab.parentNode === ptc;
    }
    function placeRowInFirefoxOrder(tab, row) {
      if (!row || !state.panel)
        return false;
      const tabsArr = [...gBrowser.tabs];
      const myIdx = tabsArr.indexOf(tab);
      if (myIdx < 0)
        return false;
      if (isFxPinned(tab)) {
        let prevTab2 = null;
        for (let i = myIdx - 1;i >= 0; i--) {
          if (isFxPinned(tabsArr[i])) {
            prevTab2 = tabsArr[i];
            break;
          }
        }
        if (prevTab2) {
          const prevRow = rowOf.get(prevTab2);
          if (!prevRow || prevRow === row)
            return false;
          if (prevRow.nextElementSibling !== row) {
            prevRow.after(row);
            return true;
          }
        } else if (state.pinnedContainer.firstChild !== row) {
          state.pinnedContainer.insertBefore(row, state.pinnedContainer.firstChild);
          return true;
        }
        return false;
      }
      let prevTab = null;
      for (let i = myIdx - 1;i >= 0; i--) {
        if (!isFxPinned(tabsArr[i])) {
          prevTab = tabsArr[i];
          break;
        }
      }
      if (prevTab) {
        const prevRow = rowOf.get(prevTab);
        if (!prevRow || prevRow === row)
          return false;
        const prevSubtree = subtreeRows(prevRow);
        const anchor = prevSubtree[prevSubtree.length - 1];
        if (anchor.nextElementSibling !== row) {
          anchor.after(row);
          return true;
        }
      } else if (state.panel.firstChild !== row) {
        state.panel.insertBefore(row, state.panel.firstChild);
        return true;
      }
      return false;
    }
    function placeRestoredRow(row, parent, prevSiblingId) {
      const parentRow = parent ? rowOf.get(parent) : null;
      if (prevSiblingId) {
        const sib = tabById(prevSiblingId);
        const sibRow = sib ? rowOf.get(sib) : null;
        const sibParent = sib ? parentOfTab(sib) : null;
        const sameParent = !parent && !sibParent || !!parent && !!sibParent && treeData(parent).id === treeData(sibParent).id;
        if (sibRow && sameParent) {
          const st = subtreeRows(sibRow);
          st[st.length - 1].after(row);
          return;
        }
      } else {
        if (parentRow) {
          parentRow.after(row);
          return;
        }
        state.panel.insertBefore(row, state.panel.firstChild);
        return;
      }
      if (parentRow) {
        const st = subtreeRows(parentRow);
        st[st.length - 1].after(row);
      } else {
        state.panel.insertBefore(row, state.spacer);
      }
    }
    function onTabOpen(e) {
      const tab = e.target;
      const td = treeData(tab);
      const prior = popSavedForTab2(tab);
      if (prior) {
        const idx = [...gBrowser.tabs].indexOf(tab);
        console.log(`palefox-tabs: onTabOpen matched — tab[${idx}] url="${tabUrl(tab)}" → saved id=${prior.id} parentId=${prior.parentId} origIdx=${prior._origIdx}`);
        applySavedToTab(tab, prior);
        const row2 = rows.createTabRow(tab);
        if (tab.pinned) {
          state.pinnedContainer.appendChild(row2);
          state.pinnedContainer.hidden = false;
        } else {
          state.panel.insertBefore(row2, state.spacer);
        }
        if (vim.consumePendingCursorMove())
          vim.setCursor(row2);
        rows.updateVisibility();
        scheduleSave();
        return;
      }
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
          try {
            gBrowser.moveTabTo(tab, { tabIndex: lastIdx });
          } catch {}
        }
      }
      if (vim.consumePendingCursorMove())
        vim.setCursor(row);
      rows.scheduleTreeResync();
      scheduleSave();
    }
    function onTabClose(e) {
      const tab = e.target;
      const row = rowOf.get(tab);
      if (row) {
        const td = treeData(tab);
        rememberClosedTab(tab, td);
        const closingId = td.id;
        const newParentId = td.parentId ?? null;
        const myLevel = levelOf(tab);
        let next = row.nextElementSibling;
        while (next && next !== state.spacer) {
          if (next._tab) {
            const ntd = treeData(next._tab);
            if (levelOf(next._tab) <= myLevel)
              break;
            if (ntd.parentId === closingId) {
              ntd.parentId = newParentId;
              rows.syncTabRow(next._tab);
            }
          } else if (next._group) {
            const gLv = next._group.level || 0;
            if (gLv <= myLevel)
              break;
            next._group.level = Math.max(0, gLv - 1);
            rows.syncGroupRow(next);
          }
          next = next.nextElementSibling;
        }
        if (state.cursor === row)
          vim.moveCursor(1) || vim.moveCursor(-1);
        row.remove();
      }
      rowOf.delete(tab);
      if (!state.pinnedContainer.querySelector(".pfx-tab-row")) {
        state.pinnedContainer.hidden = true;
      }
      rows.updateVisibility();
      scheduleSave();
    }
    function onTabPinned(e) {
      const tab = e.target;
      const row = rowOf.get(tab);
      if (!row)
        return;
      const td = treeData(tab);
      if (td.parentId != null) {
        if (typeof td.parentId === "string") {
          td.parentId = null;
        } else {
          const parent = tabById(td.parentId);
          if (!parent || !parent.pinned)
            td.parentId = null;
        }
      }
      const kids = [];
      for (const t of gBrowser.tabs) {
        if (!t.pinned && treeData(t).parentId === td.id)
          kids.push(t);
      }
      for (const kid of kids)
        gBrowser.pinTab(kid);
      row.removeAttribute("style");
      if (row.parentNode !== state.pinnedContainer) {
        state.pinnedContainer.appendChild(row);
        placeRowInFirefoxOrder(tab, row);
      }
      state.pinnedContainer.hidden = false;
      rows.syncTabRow(tab);
      for (const r of allRows())
        rows.syncAnyRow(r);
      rows.updateVisibility();
      scheduleSave();
    }
    function onTabUnpinned(e) {
      const tab = e.target;
      const row = rowOf.get(tab);
      if (!row)
        return;
      const td = treeData(tab);
      if (td.parentId != null && typeof td.parentId === "number") {
        const parent = tabById(td.parentId);
        if (parent && parent.pinned)
          td.parentId = null;
      }
      const kids = [];
      for (const t of gBrowser.tabs) {
        if (t.pinned && treeData(t).parentId === td.id)
          kids.push(t);
      }
      for (const kid of kids)
        gBrowser.unpinTab(kid);
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
    function onTabRestoring(e) {
      const tab = e.target;
      const url = tabUrl(tab);
      const idx = [...gBrowser.tabs].indexOf(tab);
      log3("onTabRestoring", {
        idx,
        url,
        currentId: treeOf.get(tab)?.id,
        currentParentId: treeOf.get(tab)?.parentId,
        queueLen: savedTabQueue.length
      });
      const entry = popClosedEntry(url);
      if (!entry) {
        const td2 = treeData(tab);
        if (td2.appliedSavedState)
          return;
        const correction = popSavedByUrl2(url);
        if (correction) {
          log3("onTabRestoring:correction", {
            idx,
            url,
            savedId: correction.id,
            savedParentId: correction.parentId,
            parentResolvesTo: tabById(correction.parentId)?.label
          });
          td2.id = correction.id || td2.id;
          td2.parentId = correction.parentId ?? null;
          td2.name = correction.name || null;
          td2.state = correction.state || null;
          td2.collapsed = !!correction.collapsed;
          td2.appliedSavedState = true;
          pinTabId(tab, td2.id);
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
        if (entry.descendantIds?.length) {
          const expected = new Set(entry.descendantIds);
          const oldParentId = entry.parentId ?? null;
          let n = row.nextElementSibling;
          while (n && n !== state.spacer) {
            if (!n._tab)
              break;
            const ntd = treeData(n._tab);
            if (!expected.has(ntd.id))
              break;
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
    function onTabSelect() {
      for (const tab of gBrowser.tabs) {
        const row2 = rowOf.get(tab);
        if (row2)
          row2.toggleAttribute("selected", tab.selected);
      }
      const row = rowOf.get(gBrowser.selectedTab);
      if (row && !state.cursor) {
        row.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      if (isHorizontal())
        rows.updateHorizontalGrid();
    }
    function onTabAttrModified(e) {
      rows.syncTabRow(e.target);
    }
    function onTabMove(e) {
      const tab = e.target;
      const row = rowOf.get(tab);
      if (!row)
        return;
      const moved = placeRowInFirefoxOrder(tab, row);
      if (moved && !movingTabs.has(tab)) {
        rows.scheduleTreeResync();
        scheduleSave();
      }
    }
    function install() {
      const tc = gBrowser.tabContainer;
      tc.addEventListener("TabOpen", onTabOpen);
      tc.addEventListener("TabClose", onTabClose);
      tc.addEventListener("TabSelect", onTabSelect);
      tc.addEventListener("TabAttrModified", onTabAttrModified);
      tc.addEventListener("TabMove", onTabMove);
      tc.addEventListener("SSTabRestoring", onTabRestoring);
      tc.addEventListener("TabPinned", onTabPinned);
      tc.addEventListener("TabUnpinned", onTabUnpinned);
      const onSessionRestored = () => {
        console.log("palefox-tabs: sessionstore-windows-restored — final tree resync");
        log3("sessionstore-windows-restored", {
          queueLen: savedTabQueue.length,
          inSessionRestore: state.inSessionRestore
        });
        savedTabQueue.length = 0;
        state.inSessionRestore = false;
        rows.scheduleTreeResync();
      };
      Services.obs.addObserver(onSessionRestored, "sessionstore-windows-restored");
      const onManualRestore = () => {
        const aliveUrls = new Set([...gBrowser.tabs].map((t) => tabUrl(t)).filter((u) => u && u !== "about:blank"));
        savedTabQueue.length = 0;
        state.lastLoadedNodes.forEach((s, i) => {
          if (s.url && aliveUrls.has(s.url))
            return;
          savedTabQueue.push({ ...s, _origIdx: i });
        });
        state.inSessionRestore = true;
        log3("manualRestoreArmed", {
          queueLen: savedTabQueue.length,
          queueIds: savedTabQueue.map((s) => s.id)
        });
      };
      Services.obs.addObserver(onManualRestore, "sessionstore-initiating-manual-restore");
      return () => {
        try {
          Services.obs.removeObserver(onSessionRestored, "sessionstore-windows-restored");
        } catch {}
        try {
          Services.obs.removeObserver(onManualRestore, "sessionstore-initiating-manual-restore");
        } catch {}
      };
    }
    return { install };
  }

  // src/tabs/layout.ts
  var log4 = createLogger("tabs/layout");
  function makeLayout(deps) {
    const { sidebarMain, rows } = deps;
    let toolboxResizeObs = null;
    let alignSpacer = null;
    let lastVertical = null;
    function isVertical() {
      return Services.prefs.getBoolPref("sidebar.verticalTabs", true);
    }
    function collapseInactiveTreesKeepingActive() {
      const activeTab = gBrowser?.selectedTab;
      const activeRow = activeTab ? rowOf.get(activeTab) : undefined;
      const all = allRows();
      let activeRoot = null;
      if (activeRow) {
        const idx = all.indexOf(activeRow);
        for (let i = idx;i >= 0; i--) {
          if (levelOfRow(all[i]) === 0) {
            activeRoot = all[i];
            break;
          }
        }
      }
      const rootsBefore = [];
      let mutated = false;
      for (const row of all) {
        if (levelOfRow(row) !== 0)
          continue;
        const d = dataOf(row);
        const wasCollapsed = !!d?.collapsed;
        const isActiveTree = row === activeRoot;
        if (isActiveTree) {
          if (d?.collapsed) {
            d.collapsed = false;
            rows.syncAnyRow(row);
            mutated = true;
          }
        } else {
          if (d && !d.collapsed) {
            d.collapsed = true;
            rows.syncAnyRow(row);
            mutated = true;
          }
        }
        rootsBefore.push({
          kind: row._tab ? "tab" : row._group ? "group" : "?",
          label: row._tab?.label || row._group?.name,
          wasCollapsed,
          isActiveTree,
          nowCollapsed: !!d?.collapsed
        });
      }
      log4("collapseInactiveTrees", {
        activeTab: activeTab?.label,
        activeRootLabel: activeRoot?._tab?.label || activeRoot?._group?.name,
        activeRootFound: !!activeRoot,
        rootCount: rootsBefore.length,
        mutated,
        roots: rootsBefore
      });
      if (mutated)
        rows.updateVisibility();
    }
    function setupHorizontalAlignSpacer() {
      const target = document.getElementById("TabsToolbar-customization-target");
      if (!target)
        return;
      if (!alignSpacer) {
        alignSpacer = document.createXULElement("box");
        alignSpacer.id = "pfx-content-alignment-spacer";
        alignSpacer.style.flex = "0 0 auto";
        alignSpacer.style.width = "10px";
      }
      if (target.firstChild !== alignSpacer)
        target.prepend(alignSpacer);
    }
    function teardownHorizontalAlignSpacer() {
      alignSpacer?.remove();
    }
    function setUrlbarTopLayer(inTopLayer) {
      const urlbar = document.getElementById("urlbar");
      if (!urlbar)
        return;
      if (sidebarMain.hasAttribute("data-pfx-compact"))
        return;
      if (inTopLayer && !urlbar.hasAttribute("popover")) {
        urlbar.setAttribute("popover", "manual");
        try {
          urlbar.showPopover();
        } catch (_) {}
      } else if (!inTopLayer && urlbar.hasAttribute("popover")) {
        urlbar.removeAttribute("popover");
      }
    }
    function positionPanel() {
      if (!state.panel)
        return;
      const vertical = isVertical();
      state.panel.toggleAttribute("pfx-horizontal", !vertical);
      state.pinnedContainer?.toggleAttribute("pfx-horizontal", !vertical);
      document.documentElement.toggleAttribute("pfx-horizontal-tabs", !vertical);
      if (toolboxResizeObs) {
        toolboxResizeObs.disconnect();
        toolboxResizeObs = null;
      }
      const toolbox = document.getElementById("navigator-toolbox");
      const toolboxInSidebar = toolbox?.parentNode === sidebarMain;
      if (vertical) {
        const expanded = sidebarMain.hasAttribute("sidebar-launcher-expanded");
        state.panel.toggleAttribute("pfx-icons-only", !expanded);
        state.pinnedContainer?.toggleAttribute("pfx-icons-only", !expanded);
        if (toolboxInSidebar && toolbox && state.pinnedContainer) {
          if (toolbox.nextElementSibling !== state.pinnedContainer)
            toolbox.after(state.pinnedContainer);
          if (state.pinnedContainer.nextElementSibling !== state.panel)
            state.pinnedContainer.after(state.panel);
        } else if (state.pinnedContainer && (state.panel.parentNode !== sidebarMain || sidebarMain.firstElementChild !== state.pinnedContainer)) {
          sidebarMain.prepend(state.panel);
          sidebarMain.prepend(state.pinnedContainer);
        }
        teardownHorizontalAlignSpacer();
        setUrlbarTopLayer(true);
      } else {
        state.panel.removeAttribute("pfx-icons-only");
        state.pinnedContainer?.removeAttribute("pfx-icons-only");
        const tabbrowserTabs = document.getElementById("tabbrowser-tabs");
        if (tabbrowserTabs) {
          if (state.pinnedContainer && tabbrowserTabs.nextElementSibling !== state.pinnedContainer) {
            tabbrowserTabs.after(state.pinnedContainer);
          }
          const anchor = state.pinnedContainer ?? tabbrowserTabs;
          if (anchor.nextElementSibling !== state.panel) {
            anchor.after(state.panel);
          }
        }
        setupHorizontalAlignSpacer();
      }
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
      if (vertical)
        rows.clearHorizontalGrid();
      for (const row of allRows())
        rows.syncAnyRow(row);
      rows.updateVisibility();
      const modeChanged = lastVertical !== null && lastVertical !== vertical;
      const initialHorizontal = lastVertical === null && !vertical;
      log4("positionPanel:transitionCheck", {
        lastVertical,
        vertical,
        modeChanged,
        initialHorizontal,
        willTrigger: modeChanged || initialHorizontal
      });
      if (modeChanged || initialHorizontal) {
        collapseInactiveTreesKeepingActive();
      }
      lastVertical = vertical;
    }
    return { positionPanel, isVertical, setUrlbarTopLayer };
  }

  // src/tabs/rows.ts
  var log5 = createLogger("tabs/rows");
  function makeRows(deps) {
    const {
      setupDrag,
      activateVim,
      selectRange,
      clearSelection,
      cloneAsSibling,
      startRename,
      scheduleSave
    } = deps;
    let groupCounter = 0;
    let resyncPending = false;
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
      const chevron = document.createXULElement("image");
      chevron.className = "pfx-tab-chevron";
      row.append(icon, label, chevron);
      row._tab = tab;
      rowOf.set(tab, row);
      row.addEventListener("click", (e) => {
        const me = e;
        if (me.button === 0) {
          if (me.shiftKey) {
            selectRange(row);
          } else {
            const target = hzDisplay.get(row) || tab;
            clearSelection();
            gBrowser.selectedTab = target;
            activateVim(rowOf.get(target) || row);
          }
        } else if (me.button === 1) {
          e.preventDefault();
          gBrowser.removeTab(tab);
        }
      });
      row.addEventListener("dblclick", (e) => {
        const me = e;
        if (me.button === 0) {
          e.stopPropagation();
          cloneAsSibling(tab);
        }
      });
      row.addEventListener("contextmenu", (e) => {
        const me = e;
        e.preventDefault();
        e.stopPropagation();
        state.contextTab = tab;
        const menu = document.getElementById("pfx-tab-menu");
        menu?.openPopupAtScreen(me.screenX, me.screenY, true);
      });
      setupDrag(row);
      syncTabRow(tab);
      return row;
    }
    function syncTabRow(tab) {
      const row = rowOf.get(tab);
      if (!row)
        return;
      const td = treeData(tab);
      const showTab = hzDisplay.get(row) || tab;
      const showTd = showTab === tab ? td : treeData(showTab);
      const img = showTab.getAttribute("image");
      const iconEl = row.querySelector(".pfx-tab-icon");
      iconEl?.setAttribute("src", img || "chrome://global/skin/icons/defaultFavicon.svg");
      row.querySelector(".pfx-tab-label")?.setAttribute("value", showTd.name || showTab.label || "New Tab");
      row.toggleAttribute("selected", tab.selected);
      if (!movingTabs.has(tab)) {
        row.toggleAttribute("busy", tab.hasAttribute("busy"));
      }
      row.toggleAttribute("pinned", tab.pinned);
      row.toggleAttribute("pfx-collapsed", !!td.collapsed && hasChildren(row));
      row.style.paddingInlineStart = levelOf(tab) * INDENT + 8 + "px";
    }
    function createGroupRow(name, level = 0) {
      const group = {
        id: `g${++groupCounter}`,
        type: "group",
        name: name || "New Group",
        level,
        state: null,
        collapsed: false
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
        if (e.button === 0)
          activateVim(row);
      });
      row.addEventListener("dblclick", (e) => {
        if (e.button === 0) {
          e.stopPropagation();
          startRename(row);
        }
      });
      row.addEventListener("contextmenu", (e) => {
        const me = e;
        e.preventDefault();
        e.stopPropagation();
        state.contextGroupRow = row;
        const menu = document.getElementById("pfx-group-menu");
        menu?.openPopupAtScreen(me.screenX, me.screenY, true);
      });
      setupDrag(row);
      syncGroupRow(row);
      return row;
    }
    function syncGroupRow(row) {
      const g = row._group;
      if (!g)
        return;
      const label = row.querySelector(".pfx-tab-label");
      const statePrefix = g.state === "todo" ? "[ ] " : g.state === "wip" ? "[-] " : g.state === "done" ? "[x] " : "";
      label?.setAttribute("value", statePrefix + g.name);
      row.toggleAttribute("pfx-collapsed", !!g.collapsed && hasChildren(row));
      row.style.paddingInlineStart = g.level * INDENT + 8 + "px";
    }
    function updateVisibility() {
      let hideBelow = -1;
      for (const row of allRows()) {
        const d = dataOf(row);
        if (!d)
          continue;
        const lv = levelOfRow(row);
        if (hideBelow >= 0 && lv > hideBelow) {
          row.hidden = true;
          continue;
        }
        row.hidden = false;
        hideBelow = d.collapsed && hasChildren(row) ? lv : -1;
      }
      updateHorizontalGrid();
    }
    function updateHorizontalGrid() {
      if (!isHorizontal())
        return;
      const containers = [state.pinnedContainer, state.panel].filter(Boolean);
      for (const container of containers) {
        const rowsInContainer = [
          ...container.querySelectorAll(".pfx-tab-row, .pfx-group-row")
        ];
        let col = 0;
        let rowInCol = 0;
        let selectedCol = 0;
        for (const row of rowsInContainer) {
          const d = dataOf(row);
          if (!d)
            continue;
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
          if (row.hasAttribute("selected"))
            selectedCol = col;
        }
        if (col > 0) {
          const tracks = [];
          for (let i = 1;i <= col; i++) {
            tracks.push(i === selectedCol ? "minmax(200px, 200px)" : "minmax(0, 200px)");
          }
          container.style.gridTemplateColumns = tracks.join(" ");
        } else {
          container.style.gridTemplateColumns = "";
        }
      }
      requestAnimationFrame(() => {
        if (!isHorizontal())
          return;
        for (const container of containers) {
          const firstRow = container.querySelector(".pfx-tab-row:not([hidden]), .pfx-group-row:not([hidden])");
          if (firstRow) {
            container.style.maxHeight = firstRow.offsetHeight + 2 + "px";
          }
        }
        const totalPopouts = (state.panel?.querySelectorAll("[pfx-popout-child]").length ?? 0) + (state.pinnedContainer?.querySelectorAll("[pfx-popout-child]").length ?? 0);
        const urlbar = document.getElementById("urlbar");
        if (urlbar) {
          const before = {
            hasPopover: urlbar.hasAttribute("popover"),
            matchesOpen: (() => {
              try {
                return urlbar.matches(":popover-open");
              } catch {
                return null;
              }
            })()
          };
          if (totalPopouts > 0 && urlbar.hasAttribute("popover")) {
            urlbar.removeAttribute("popover");
          }
          log5("hzGrid:urlbar", { totalPopouts, before, hasPopoverAfter: urlbar.hasAttribute("popover") });
        }
        for (const container of containers) {
          const allRowsInContainer = container.querySelectorAll(".pfx-tab-row, .pfx-group-row");
          for (const p of allRowsInContainer) {
            if (p.style.position === "fixed") {
              p.style.position = "";
              p.style.left = "";
              p.style.top = "";
              p.style.width = "";
              p.style.zIndex = "";
            }
          }
          const popouts = [...container.querySelectorAll("[pfx-popout-child]")];
          if (popouts.length) {
            container.offsetHeight;
            const rects = popouts.map((p) => p.getBoundingClientRect());
            for (let i = 0;i < popouts.length; i++) {
              const p = popouts[i];
              const r = rects[i];
              if (r.width > 0 && r.height > 0) {
                p.style.position = "fixed";
                p.style.left = r.left + "px";
                p.style.top = r.top + "px";
                p.style.width = r.width + "px";
                p.style.zIndex = "9999";
              }
            }
          }
        }
        const popout = state.panel?.querySelector("[pfx-popout-child]");
        if (popout) {
          const cs = (el) => {
            if (!el)
              return null;
            const s = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return {
              position: s.position,
              zIndex: s.zIndex,
              overflow: s.overflow,
              rect: {
                x: Math.round(r.left),
                y: Math.round(r.top),
                w: Math.round(r.width),
                h: Math.round(r.height)
              }
            };
          };
          log5("hzGrid:stacking", {
            popout: cs(popout),
            panel: cs(state.panel),
            tabsToolbar: cs(document.getElementById("TabsToolbar")),
            navBar: cs(document.getElementById("nav-bar")),
            urlbar: cs(document.getElementById("urlbar"))
          });
        }
      });
    }
    function clearHorizontalGrid() {
      for (const container of [state.pinnedContainer, state.panel]) {
        if (!container)
          continue;
        container.style.maxHeight = "";
        container.style.gridTemplateColumns = "";
      }
      for (const row of allRows()) {
        row.style.gridColumn = "";
        row.style.gridRow = "";
        row.style.position = "";
        row.style.left = "";
        row.style.top = "";
        row.style.width = "";
        row.style.zIndex = "";
        row.removeAttribute("pfx-popout-child");
      }
    }
    function toggleCollapse(row) {
      const d = dataOf(row);
      if (!d || !hasChildren(row))
        return;
      d.collapsed = !d.collapsed;
      if (row._tab)
        syncTabRow(row._tab);
      else
        syncGroupRow(row);
      updateVisibility();
      scheduleSave();
    }
    function scheduleTreeResync() {
      if (resyncPending)
        return;
      resyncPending = true;
      Promise.resolve().then(() => {
        resyncPending = false;
        for (const t of gBrowser.tabs) {
          if (rowOf.get(t))
            syncTabRow(t);
        }
        updateVisibility();
      });
    }
    function syncAnyRow(row) {
      if (row._tab)
        syncTabRow(row._tab);
      else if (row._group)
        syncGroupRow(row);
    }
    return {
      createTabRow,
      syncTabRow,
      createGroupRow,
      syncGroupRow,
      syncAnyRow,
      updateVisibility,
      updateHorizontalGrid,
      clearHorizontalGrid,
      toggleCollapse,
      scheduleTreeResync
    };
  }

  // src/tabs/picker.ts
  function makePicker(deps) {
    let pickerEl = null;
    let pickerInput = null;
    let pickerList = null;
    let active = false;
    let items = [];
    let filtered = [];
    let selectedIdx = 0;
    let onSelect = null;
    let actions = [];
    let preserveTree = false;
    function onDocKeydown(e) {
      if (!active)
        return;
      if (e.key !== "Escape")
        return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dismiss();
    }
    document.addEventListener("keydown", onDocKeydown, true);
    function onDocMouseDown(e) {
      if (!active || !pickerEl)
        return;
      const t = e.target;
      if (t && pickerEl.contains(t))
        return;
      dismiss();
    }
    document.addEventListener("mousedown", onDocMouseDown, true);
    function ensureBuilt() {
      if (pickerEl)
        return;
      const xul = (tag) => document.createXULElement(tag);
      const root = xul("vbox");
      root.id = "pfx-picker";
      root.hidden = true;
      root.setAttribute("aria-modal", "true");
      const inputBox = xul("hbox");
      inputBox.className = "pfx-picker-input-box";
      const prompt = xul("label");
      prompt.className = "pfx-picker-prompt";
      prompt.setAttribute("value", "›");
      const input = document.createElement("input");
      input.className = "pfx-picker-input";
      input.placeholder = "Filter…";
      inputBox.append(prompt, input);
      const list = xul("vbox");
      list.className = "pfx-picker-list";
      root.append(inputBox, list);
      document.documentElement.appendChild(root);
      pickerEl = root;
      pickerInput = input;
      pickerList = list;
      input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        filtered = computeFiltered(items, q);
        selectedIdx = 0;
        renderList();
      });
      input.addEventListener("keydown", (e) => {
        if (!active)
          return;
        switch (e.key) {
          case "Escape":
            e.preventDefault();
            e.stopImmediatePropagation();
            dismiss();
            return;
          case "Enter":
            e.preventDefault();
            e.stopImmediatePropagation();
            commit();
            return;
          case "Tab":
            if (actions.length > 0) {
              e.preventDefault();
              e.stopImmediatePropagation();
              openActionMenu();
              return;
            }
            break;
          case "ArrowDown":
            e.preventDefault();
            e.stopImmediatePropagation();
            moveSelection(1);
            return;
          case "ArrowUp":
            e.preventDefault();
            e.stopImmediatePropagation();
            moveSelection(-1);
            return;
          case "j":
            if (e.ctrlKey) {
              e.preventDefault();
              e.stopImmediatePropagation();
              moveSelection(1);
              return;
            }
            break;
          case "k":
            if (e.ctrlKey) {
              e.preventDefault();
              e.stopImmediatePropagation();
              moveSelection(-1);
              return;
            }
            break;
          case "n":
            if (e.ctrlKey) {
              e.preventDefault();
              e.stopImmediatePropagation();
              moveSelection(1);
              return;
            }
            break;
          case "p":
            if (e.ctrlKey) {
              e.preventDefault();
              e.stopImmediatePropagation();
              moveSelection(-1);
              return;
            }
            break;
        }
      }, true);
    }
    function computeFiltered(allItems, q) {
      if (!q)
        return [...allItems];
      const matchedSet = new Set;
      for (const it of allItems) {
        const hay = ((it.display ?? "") + " " + (it.secondary ?? "")).toLowerCase();
        if (hay.includes(q))
          matchedSet.add(it);
      }
      if (!preserveTree) {
        return allItems.filter((it) => matchedSet.has(it));
      }
      const byId = new Map;
      for (const it of allItems) {
        if (it.id != null)
          byId.set(it.id, it);
      }
      const visible = new Set(matchedSet);
      for (const m of matchedSet) {
        let cur = m;
        while (cur && cur.parentId != null) {
          const p = byId.get(cur.parentId);
          if (!p || visible.has(p))
            break;
          visible.add(p);
          cur = p;
        }
      }
      return allItems.filter((it) => visible.has(it));
    }
    function isDirectMatch(item, q) {
      if (!q)
        return true;
      const hay = ((item.display ?? "") + " " + (item.secondary ?? "")).toLowerCase();
      return hay.includes(q);
    }
    function renderList() {
      if (!pickerList)
        return;
      while (pickerList.firstChild)
        pickerList.firstChild.remove();
      if (!filtered.length) {
        const empty = document.createXULElement("label");
        empty.className = "pfx-picker-empty";
        empty.setAttribute("value", "(no matches)");
        pickerList.appendChild(empty);
        return;
      }
      const q = pickerInput?.value?.trim().toLowerCase() ?? "";
      filtered.forEach((item, idx) => {
        const row = document.createXULElement("hbox");
        row.className = "pfx-picker-row";
        if (idx === selectedIdx)
          row.setAttribute("pfx-picker-selected", "true");
        if (preserveTree && q && !isDirectMatch(item, q)) {
          row.setAttribute("pfx-picker-context", "true");
        }
        if (item.depth) {
          row.style.setProperty("padding-left", `${14 + item.depth * 14}px`, "important");
        }
        if (item.icon) {
          if (/^https?:|^data:|^chrome:|^moz-/.test(item.icon)) {
            const img = document.createElement("img");
            img.className = "pfx-picker-icon";
            img.src = item.icon;
            img.alt = "";
            row.appendChild(img);
          } else {
            const ic = document.createXULElement("label");
            ic.className = "pfx-picker-icon-text";
            ic.setAttribute("value", item.icon);
            row.appendChild(ic);
          }
        }
        const text = document.createXULElement("hbox");
        text.className = "pfx-picker-text";
        text.setAttribute("flex", "1");
        const primary = document.createXULElement("label");
        primary.className = "pfx-picker-label";
        primary.setAttribute("value", item.display);
        primary.setAttribute("crop", "end");
        text.appendChild(primary);
        if (item.secondary) {
          const sec = document.createXULElement("label");
          sec.className = "pfx-picker-secondary";
          sec.setAttribute("value", item.secondary);
          sec.setAttribute("crop", "end");
          text.appendChild(sec);
        }
        row.appendChild(text);
        row.addEventListener("click", () => {
          selectedIdx = idx;
          commit();
        });
        pickerList.appendChild(row);
      });
      const selected = pickerList.querySelector("[pfx-picker-selected='true']");
      selected?.scrollIntoView({ block: "nearest" });
    }
    function openActionMenu() {
      const target = filtered[selectedIdx];
      const localActions = actions;
      if (!target || !localActions.length)
        return;
      dismiss();
      show({
        prompt: `actions ›`,
        items: localActions.map((a) => ({
          display: a.label + (a.key ? `   (${a.key})` : ""),
          data: a
        })),
        onSelect: (chosen) => {
          const action = chosen.data;
          try {
            action.run(target);
          } catch (e) {
            deps.modelineMsg(`action failed: ${e.message}`, 4000);
          }
        }
      });
    }
    function moveSelection(delta) {
      if (!filtered.length)
        return;
      selectedIdx = (selectedIdx + delta + filtered.length) % filtered.length;
      renderList();
    }
    function commit() {
      if (!active)
        return;
      const item = filtered[selectedIdx];
      const cb = onSelect;
      active = false;
      onSelect = null;
      actions = [];
      preserveTree = false;
      if (pickerEl)
        pickerEl.hidden = true;
      if (item && cb)
        cb(item);
    }
    function dismiss() {
      if (!active)
        return;
      active = false;
      onSelect = null;
      actions = [];
      preserveTree = false;
      if (pickerEl)
        pickerEl.hidden = true;
      deps.restoreFocus();
    }
    function show(opts) {
      ensureBuilt();
      if (!pickerEl || !pickerInput || !pickerList)
        return;
      items = opts.items;
      selectedIdx = 0;
      onSelect = opts.onSelect;
      actions = opts.actions ?? [];
      preserveTree = !!opts.preserveTree;
      filtered = [...opts.items];
      active = true;
      const promptEl = pickerEl.querySelector(".pfx-picker-prompt");
      if (promptEl && opts.prompt) {
        promptEl.setAttribute("value", opts.prompt);
      } else if (promptEl) {
        promptEl.setAttribute("value", "›");
      }
      pickerInput.value = "";
      renderList();
      pickerEl.hidden = false;
      pickerInput.focus();
    }
    function destroy() {
      document.removeEventListener("keydown", onDocKeydown, true);
      document.removeEventListener("mousedown", onDocMouseDown, true);
      dismiss();
      pickerEl?.remove();
      pickerEl = null;
      pickerInput = null;
      pickerList = null;
    }
    return {
      show,
      isActive: () => active,
      dismiss,
      destroy
    };
  }

  // src/tabs/vim.ts
  var log6 = createLogger("tabs/vim");
  function makeVim(deps) {
    const { rows, layout, scheduleSave, clearSelection, selectRange, sidebarMain, history, contentFocus } = deps;
    const picker = makePicker({
      restoreFocus: () => state.panel?.focus(),
      modelineMsg: (text, durationMs) => modelineMsg(text, durationMs)
    });
    let chord = null;
    let chordTimer = 0;
    let pendingCtrlW = false;
    let pendingSpace = false;
    let pendingCursorMove = false;
    let hzExpandedRoot = null;
    let modeline = null;
    let modelineTimer = 0;
    let panelActive = false;
    let refileSource = null;
    let selectionAnchor = null;
    let searchInput = null;
    let searchActive = false;
    let searchMatches = [];
    let searchIdx = -1;
    function setCursor(row) {
      if (state.cursor)
        state.cursor.removeAttribute("pfx-cursor");
      state.cursor = row;
      if (row) {
        row.setAttribute("pfx-cursor", "true");
        row.scrollIntoView({ block: "nearest", inline: "nearest" });
        if (isHorizontal())
          updateHorizontalExpansion();
      }
    }
    function treeRoot(row) {
      const allR = allRows();
      const idx = allR.indexOf(row);
      for (let i = idx;i >= 0; i--) {
        if (levelOfRow(allR[i]) === 0)
          return allR[i];
      }
      return row;
    }
    function collapseHzTree(root) {
      const d = dataOf(root);
      if (!d || !hasChildren(root))
        return;
      if (state.cursor && state.cursor._tab && state.cursor !== root) {
        const curRoot = treeRoot(state.cursor);
        if (curRoot === root) {
          hzDisplay.set(root, state.cursor._tab);
        }
      }
      d.collapsed = true;
      rows.syncAnyRow(root);
      if (isHorizontal())
        layout.setUrlbarTopLayer(true);
    }
    function expandHzTree(root) {
      const d = dataOf(root);
      if (!d || !hasChildren(root))
        return;
      hzDisplay.delete(root);
      d.collapsed = false;
      rows.syncAnyRow(root);
      if (isHorizontal())
        layout.setUrlbarTopLayer(false);
    }
    function updateHorizontalExpansion() {
      if (!state.cursor)
        return;
      const root = treeRoot(state.cursor);
      if (root === hzExpandedRoot)
        return;
      if (hzExpandedRoot)
        collapseHzTree(hzExpandedRoot);
      expandHzTree(root);
      hzExpandedRoot = root;
      rows.updateVisibility();
    }
    function moveToLevel0(delta) {
      if (!state.cursor)
        return false;
      const allR = allRows();
      const curIdx = allR.indexOf(state.cursor);
      if (curIdx < 0)
        return false;
      const step = delta > 0 ? 1 : -1;
      for (let i = curIdx + step;i >= 0 && i < allR.length; i += step) {
        const candidate = allR[i];
        if (levelOfRow(candidate) === 0) {
          setCursor(candidate);
          if (candidate._tab)
            gBrowser.selectedTab = candidate._tab;
          return true;
        }
      }
      return false;
    }
    function activateVim(row) {
      focusPanel();
      setCursor(row);
    }
    function moveCursor(delta) {
      if (!state.cursor) {
        log6("moveCursor:noCursor", { delta });
        return false;
      }
      const all = allRows();
      const idx = all.indexOf(state.cursor);
      if (idx < 0) {
        log6("moveCursor:cursorNotInAllRows", { delta, allLen: all.length });
        return false;
      }
      const step = delta > 0 ? 1 : -1;
      const skipped = [];
      for (let i = idx + step;i >= 0 && i < all.length; i += step) {
        const row = all[i];
        if (row.hidden) {
          skipped.push({
            i,
            kind: row._tab ? "tab" : row._group ? "group" : "?",
            label: row._tab?.label || row._group?.name,
            parentId: row._tab ? treeData(row._tab).parentId : row._group?.id,
            domParent: row.parentNode === state.pinnedContainer ? "pinned" : row.parentNode === state.panel ? "panel" : "other"
          });
          continue;
        }
        log6("moveCursor:landed", {
          delta,
          fromIdx: idx,
          toIdx: i,
          skippedHidden: skipped,
          landedOn: {
            kind: row._tab ? "tab" : row._group ? "group" : "?",
            label: row._tab?.label || row._group?.name,
            parentId: row._tab ? treeData(row._tab).parentId : row._group?.id,
            domParent: row.parentNode === state.pinnedContainer ? "pinned" : row.parentNode === state.panel ? "panel" : "other"
          }
        });
        setCursor(row);
        if (row._tab)
          gBrowser.selectedTab = row._tab;
        return true;
      }
      log6("moveCursor:noTarget", {
        delta,
        fromIdx: idx,
        allLen: all.length,
        skippedHidden: skipped
      });
      return false;
    }
    function prevSiblingTab(row) {
      if (!row?._tab)
        return null;
      const myTd = treeData(row._tab);
      const myLevel = levelOf(row._tab);
      let r = row.previousElementSibling;
      while (r) {
        if (r._tab) {
          const lv = levelOf(r._tab);
          if (lv < myLevel)
            return null;
          if (lv === myLevel && treeData(r._tab).parentId === myTd.parentId) {
            return r._tab;
          }
        }
        r = r.previousElementSibling;
      }
      return null;
    }
    function indentRow(row) {
      if (row._group) {
        const allR = allRows();
        const i = allR.indexOf(row);
        if (i <= 0)
          return;
        const d = row._group;
        const prevLv = levelOfRow(allR[i - 1]);
        if (d.level > prevLv)
          return;
        d.level++;
        rows.syncAnyRow(row);
      } else if (row._tab) {
        const prev = row.previousElementSibling;
        if (prev?._group) {
          treeData(row._tab).parentId = prev._group.id;
          for (const r of subtreeRows(row))
            rows.syncAnyRow(r);
        } else {
          const sibling = prevSiblingTab(row);
          if (!sibling)
            return;
          treeData(row._tab).parentId = treeData(sibling).id;
          for (const r of subtreeRows(row))
            rows.syncAnyRow(r);
        }
      }
      rows.updateVisibility();
      scheduleSave();
    }
    function outdentRow(row) {
      if (row._group) {
        const d = row._group;
        if ((d.level || 0) <= 0)
          return;
        d.level = Math.max(0, d.level - 1);
        rows.syncAnyRow(row);
      } else if (row._tab) {
        const td = treeData(row._tab);
        if (td.parentId == null)
          return;
        if (typeof td.parentId === "string") {
          td.parentId = null;
        } else {
          const parent = tabById(td.parentId);
          td.parentId = parent ? treeData(parent).parentId : null;
        }
        for (const r of subtreeRows(row))
          rows.syncAnyRow(r);
      }
      rows.updateVisibility();
      scheduleSave();
    }
    function moveToRoot(row) {
      if (!row?._tab)
        return;
      const td = treeData(row._tab);
      if (!td.parentId)
        return;
      td.parentId = null;
      for (const r of subtreeRows(row))
        rows.syncAnyRow(r);
      rows.updateVisibility();
      scheduleSave();
    }
    function makeChildOfAbove(row) {
      if (!row?._tab)
        return;
      const prev = row.previousElementSibling;
      if (!prev)
        return;
      if (prev._group) {
        treeData(row._tab).parentId = prev._group.id;
      } else if (prev._tab) {
        treeData(row._tab).parentId = treeData(prev._tab).id;
      } else {
        return;
      }
      for (const r of subtreeRows(row))
        rows.syncAnyRow(r);
      rows.updateVisibility();
      scheduleSave();
    }
    function swapDown(row) {
      if (!dataOf(row))
        return;
      const myLevel = levelOfRow(row);
      const sub = subtreeRows(row);
      const lastRow = sub[sub.length - 1];
      const nextRow = lastRow.nextElementSibling;
      if (!nextRow || nextRow === state.spacer)
        return;
      if (levelOfRow(nextRow) !== myLevel)
        return;
      subtreeRows(nextRow).at(-1).after(...sub);
      rows.updateVisibility();
      scheduleSave();
    }
    function swapUp(row) {
      if (!dataOf(row))
        return;
      const myLevel = levelOfRow(row);
      let prev = row.previousElementSibling;
      while (prev && levelOfRow(prev) > myLevel) {
        prev = prev.previousElementSibling;
      }
      if (!prev || levelOfRow(prev) !== myLevel)
        return;
      prev.before(...subtreeRows(row));
      rows.updateVisibility();
      scheduleSave();
    }
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
      document.documentElement.appendChild(modeline);
    }
    function updateModeline() {
      if (!modeline)
        return;
      const modeLabel = document.getElementById("pfx-modeline-mode");
      const chordLabel = document.getElementById("pfx-modeline-chord");
      const msgLabel = document.getElementById("pfx-modeline-msg");
      let pending = "";
      if (pendingSpace === true)
        pending = "SPC-";
      else if (pendingSpace === "w")
        pending = "SPC w-";
      else if (pendingCtrlW)
        pending = "C-w-";
      else if (chord === "g")
        pending = "g-";
      if (modeLabel)
        modeLabel.setAttribute("value", "");
      if (chordLabel)
        chordLabel.setAttribute("value", pending);
      const hasContent = pending || msgLabel && msgLabel.getAttribute("value") || searchActive || modeline.querySelector(".pfx-search-input");
      modeline.toggleAttribute("pfx-visible", !!hasContent);
    }
    function modelineMsg(text, duration = 3000) {
      if (!modeline)
        return;
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
    function focusPanel() {
      panelActive = true;
      state.panel.focus();
      if (!state.cursor) {
        const row = rowOf.get(gBrowser.selectedTab);
        if (row)
          setCursor(row);
      }
      updateModeline();
    }
    function blurPanel() {
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
    let lastTab = null;
    let currentSelectedTab = null;
    function openTabsPicker(scope = "current") {
      const Palefox = window.Palefox;
      if (scope === "all" && Palefox) {
        const all = Palefox.tabs.all();
        if (!all.length) {
          modelineMsg("No tabs", 3000);
          return;
        }
        const windowLabels = new Map;
        for (const t of all) {
          if (!windowLabels.has(t.windowId)) {
            windowLabels.set(t.windowId, `Window ${windowLabels.size + 1}`);
          }
        }
        const items2 = all.map((t) => {
          const wLabel = windowLabels.get(t.windowId) ?? "Window ?";
          const host = (() => {
            try {
              return new URL(t.url).hostname;
            } catch {
              return "";
            }
          })();
          return {
            display: t.customName || t.label || "(untitled)",
            secondary: host ? `${host}  ·  ${wLabel}` : wLabel,
            data: { id: t.id, windowId: t.windowId }
          };
        });
        picker.show({
          prompt: `tabs (all windows) ›`,
          items: items2,
          preserveTree: false,
          onSelect: (item) => {
            const d = item.data;
            try {
              Palefox.tabs.activate(d.id, d.windowId);
            } catch {}
          }
        });
        return;
      }
      const items = [];
      for (const tab of gBrowser.tabs) {
        const td = treeOf.get(tab);
        if (!td)
          continue;
        const url = tab.linkedBrowser?.currentURI?.spec || "";
        const host = (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return "";
          }
        })();
        let icon;
        try {
          icon = gBrowser.getIcon(tab) || undefined;
        } catch {}
        items.push({
          display: td.name || tab.label || "(untitled)",
          secondary: host || url || "",
          icon,
          id: td.id,
          parentId: typeof td.parentId === "number" ? td.parentId : null,
          depth: levelOf(tab),
          data: tab
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
          const tab = item.data;
          try {
            gBrowser.selectedTab = tab;
          } catch {}
        },
        actions: [
          { label: "Close", key: "x", run: (item) => {
            try {
              gBrowser.removeTab(item.data);
            } catch {}
          } },
          { label: "Duplicate", key: "d", run: (item) => {
            try {
              gBrowser.duplicateTab(item.data);
            } catch {}
          } },
          { label: "Pin / Unpin", key: "p", run: (item) => {
            const t = item.data;
            try {
              if (t.pinned)
                gBrowser.unpinTab(t);
              else
                gBrowser.pinTab(t);
            } catch {}
          } },
          { label: "Reload", key: "r", run: (item) => {
            try {
              gBrowser.reloadTab(item.data);
            } catch {}
          } }
        ]
      });
    }
    function activateUrlbar(intent) {
      document.dispatchEvent(new CustomEvent("pfx-urlbar-activate", {
        detail: { intent }
      }));
    }
    function toggleLastTab() {
      const target = lastTab;
      if (!target)
        return;
      try {
        if (target.isOpen)
          gBrowser.selectedTab = target;
      } catch (e) {
        console.error("palefox-tabs: toggleLastTab failed", e);
      }
    }
    function keyEnabled(name) {
      return Services.prefs.getBoolPref(`pfx.keys.${name}.enabled`, true);
    }
    function blacklistedHosts() {
      const raw = Services.prefs.getStringPref("pfx.keys.blacklist", "");
      return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
    function currentHost() {
      try {
        const uri = gBrowser.selectedBrowser?.currentURI?.spec;
        if (!uri)
          return "";
        return new URL(uri).hostname.toLowerCase();
      } catch {
        return "";
      }
    }
    function currentHostBlacklisted() {
      const host = currentHost();
      if (!host)
        return false;
      for (const entry of blacklistedHosts()) {
        if (host === entry)
          return true;
        if (host.endsWith("." + entry))
          return true;
      }
      return false;
    }
    function blacklistAdd(host) {
      const list = blacklistedHosts();
      const h = host.trim().toLowerCase();
      if (!h || list.includes(h))
        return;
      list.push(h);
      Services.prefs.setStringPref("pfx.keys.blacklist", list.join(","));
    }
    function blacklistRemove(host) {
      const list = blacklistedHosts();
      const h = host.trim().toLowerCase();
      const next = list.filter((x) => x !== h);
      if (next.length === list.length)
        return false;
      Services.prefs.setStringPref("pfx.keys.blacklist", next.join(","));
      return true;
    }
    function setupGlobalKeys() {
      currentSelectedTab = gBrowser.selectedTab;
      gBrowser.tabContainer.addEventListener("TabSelect", (e) => {
        const newTab = e.target;
        if (newTab !== currentSelectedTab) {
          lastTab = currentSelectedTab;
          currentSelectedTab = newTab;
        }
      });
      document.addEventListener("keydown", (e) => {
        if (picker.isActive())
          return;
        if (contentFocus.contentInputFocused())
          return;
        if (currentHostBlacklisted())
          return;
        const a = document.activeElement;
        if (a && a !== state.panel && (a.tagName === "INPUT" || a.tagName === "input" || a.tagName === "TEXTAREA" || a.tagName === "textarea" || a.isContentEditable))
          return;
        if (a && (a.closest?.("#urlbar") || a.closest?.("findbar") || a.closest?.(".pfx-search-input") || a.closest?.(".pfx-picker")))
          return;
        if (!e.ctrlKey && !e.altKey && !e.metaKey) {
          switch (e.key) {
            case "t":
              if (!keyEnabled("t"))
                break;
              e.preventDefault();
              e.stopImmediatePropagation();
              openTabsPicker("current");
              return;
            case "T":
              if (!keyEnabled("T"))
                break;
              e.preventDefault();
              e.stopImmediatePropagation();
              openTabsPicker("all");
              return;
            case ":":
              if (!keyEnabled("colon"))
                break;
              e.preventDefault();
              e.stopImmediatePropagation();
              startExMode();
              return;
            case "x":
              if (!keyEnabled("x"))
                break;
              e.preventDefault();
              e.stopImmediatePropagation();
              try {
                gBrowser.removeTab(gBrowser.selectedTab);
              } catch {}
              return;
            case "o":
              if (!keyEnabled("o"))
                break;
              e.preventDefault();
              e.stopImmediatePropagation();
              activateUrlbar("current");
              return;
            case "O":
              if (!keyEnabled("O"))
                break;
              e.preventDefault();
              e.stopImmediatePropagation();
              activateUrlbar("newTab");
              return;
            case "`":
              if (!keyEnabled("backtick"))
                break;
              e.preventDefault();
              e.stopImmediatePropagation();
              toggleLastTab();
              return;
          }
        }
      }, true);
    }
    function setupVimKeys() {
      state.panel.setAttribute("tabindex", "0");
      document.addEventListener("keydown", (e) => {
        if (picker.isActive())
          return;
        if (!panelActive)
          return;
        const active = document.activeElement;
        if (active && active !== state.panel && (active.tagName === "INPUT" || active.tagName === "input" || active.tagName === "TEXTAREA" || active.tagName === "textarea" || active.isContentEditable || active.closest?.("#urlbar") || active.closest?.("findbar"))) {
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
          blurPanel();
          if (!e.ctrlKey && !e.altKey && !e.metaKey) {
            gBrowser.selectedBrowser.focus();
          }
        }
      }, true);
      gBrowser.tabpanels.addEventListener("mousedown", () => {
        if (panelActive)
          blurPanel();
      });
    }
    function focusContent() {
      gBrowser.selectedBrowser.focus();
    }
    function paneSwitch(key) {
      switch (key) {
        case "h":
        case "H":
          state.panel.focus();
          if (!state.cursor) {
            const r = rowOf.get(gBrowser.selectedTab);
            if (r)
              setCursor(r);
          }
          return;
        case "l":
        case "L":
          focusContent();
          return;
        case "w":
          if (document.activeElement === state.panel) {
            focusContent();
          } else {
            state.panel.focus();
            if (!state.cursor) {
              const r = rowOf.get(gBrowser.selectedTab);
              if (r)
                setCursor(r);
            }
          }
          return;
      }
    }
    function handleNormalKey(e) {
      if (e.key !== "J" && e.key !== "K")
        selectionAnchor = null;
      if (pendingCtrlW) {
        pendingCtrlW = false;
        clearTimeout(chordTimer);
        paneSwitch(e.key);
        return true;
      }
      if (e.ctrlKey && (e.key === "w" || e.code === "KeyW")) {
        pendingCtrlW = true;
        chordTimer = setTimeout(() => {
          pendingCtrlW = false;
        }, CHORD_TIMEOUT);
        return true;
      }
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
          chordTimer = setTimeout(() => {
            pendingSpace = false;
          }, CHORD_TIMEOUT);
          return true;
        }
        return true;
      }
      if (e.key === " ") {
        pendingSpace = true;
        chordTimer = setTimeout(() => {
          pendingSpace = false;
        }, CHORD_TIMEOUT);
        return true;
      }
      if (chord) {
        const combo = chord + e.key;
        chord = null;
        clearTimeout(chordTimer);
        if (combo === "gg") {
          goToTop();
          return true;
        }
        if (combo === "gC") {
          if (state.cursor?._tab)
            cloneAsSibling(state.cursor._tab);
          return true;
        }
        return true;
      }
      if (e.key === "g" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        chord = e.key;
        chordTimer = setTimeout(() => {
          chord = null;
        }, CHORD_TIMEOUT);
        return true;
      }
      if (e.key === "i") {
        blurPanel();
        gBrowser.selectedBrowser.focus();
        return true;
      }
      if (e.altKey && (e.key === "h" || e.code === "KeyH" || e.key === "ArrowLeft")) {
        if (state.cursor)
          moveToRoot(state.cursor);
        return true;
      }
      if (e.altKey && (e.key === "l" || e.code === "KeyL" || e.key === "ArrowRight")) {
        if (state.cursor)
          makeChildOfAbove(state.cursor);
        return true;
      }
      if (e.altKey && (e.key === "j" || e.code === "KeyJ" || e.key === "ArrowDown")) {
        if (state.cursor)
          swapDown(state.cursor);
        return true;
      }
      if (e.altKey && (e.key === "k" || e.code === "KeyK" || e.key === "ArrowUp")) {
        if (state.cursor)
          swapUp(state.cursor);
        return true;
      }
      if (!state.cursor) {
        if ("jklhG/rnNx".includes(e.key)) {
          const row = rowOf.get(gBrowser.selectedTab);
          if (row)
            setCursor(row);
        }
        if (!state.cursor)
          return false;
      }
      if (!e.ctrlKey && !e.metaKey) {
        if (isHorizontal()) {
          switch (e.key) {
            case "h":
            case "ArrowLeft":
              moveToLevel0(-1);
              return true;
            case "l":
            case "ArrowRight":
              moveToLevel0(1);
              return true;
            case "j":
            case "ArrowDown":
              moveCursor(1);
              return true;
            case "k":
            case "ArrowUp":
              moveCursor(-1);
              return true;
          }
        } else {
          switch (e.key) {
            case "j":
            case "ArrowDown":
              moveCursor(1);
              return true;
            case "k":
            case "ArrowUp":
              moveCursor(-1);
              return true;
            case "h":
            case "ArrowLeft":
              outdentRow(state.cursor);
              return true;
            case "l":
            case "ArrowRight":
              indentRow(state.cursor);
              return true;
          }
        }
      }
      switch (e.key) {
        case "Enter":
          if (refileSource) {
            if (state.cursor)
              executeRefile(state.cursor);
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
        case "Tab":
          rows.toggleCollapse(state.cursor);
          return true;
        case "Escape":
          if (refileSource) {
            cancelRefile();
            return true;
          }
          return true;
        case "r":
          startRename(state.cursor);
          return true;
        case "G":
          goToBottom();
          return true;
        case "x":
          closeFocused();
          return true;
        case ":":
          startExMode();
          return true;
        case "J": {
          if (!selectionAnchor)
            selectionAnchor = state.cursor;
          if (moveCursor(1) && selectionAnchor)
            selectRange(selectionAnchor);
          return true;
        }
        case "K": {
          if (!selectionAnchor)
            selectionAnchor = state.cursor;
          if (moveCursor(-1) && selectionAnchor)
            selectRange(selectionAnchor);
          return true;
        }
      }
      return false;
    }
    function goToTop() {
      const visible = allRows().filter((r) => !r.hidden);
      if (!visible.length)
        return;
      const first = visible[0];
      setCursor(first);
      if (first._tab)
        gBrowser.selectedTab = first._tab;
    }
    function goToBottom() {
      const visible = allRows().filter((r) => !r.hidden);
      if (!visible.length)
        return;
      const last = visible[visible.length - 1];
      setCursor(last);
      if (last._tab)
        gBrowser.selectedTab = last._tab;
    }
    function nextMatch(dir) {
      if (!searchMatches.length) {
        modelineMsg("No previous search");
        return;
      }
      searchIdx = (searchIdx + dir + searchMatches.length) % searchMatches.length;
      const row = searchMatches[searchIdx];
      setCursor(row);
      if (row._tab)
        gBrowser.selectedTab = row._tab;
      const hint = refileSource ? "  Enter=refile" : "";
      modelineMsg(`[${searchIdx + 1}/${searchMatches.length}]${hint}`);
    }
    function closeFocused() {
      if (selection.size > 1) {
        const sel = [...selection];
        clearSelection();
        const last = sel[sel.length - 1];
        let next = last.nextElementSibling;
        while (next && (next.hidden || next === state.spacer || sel.includes(next))) {
          next = next.nextElementSibling;
        }
        if (next && next !== state.spacer)
          setCursor(next);
        for (let i = sel.length - 1;i >= 0; i--) {
          const row = sel[i];
          if (row._tab)
            gBrowser.removeTab(row._tab);
          else if (row._group)
            row.remove();
        }
        rows.updateVisibility();
        scheduleSave();
        return;
      }
      if (!state.cursor)
        return;
      if (state.cursor._tab) {
        gBrowser.removeTab(state.cursor._tab);
      } else if (state.cursor._group) {
        const d = state.cursor._group;
        const myLevel = d.level || 0;
        const groupId = d.id;
        for (const tab of gBrowser.tabs) {
          const td = treeData(tab);
          if (td.parentId === groupId)
            td.parentId = null;
        }
        let next = state.cursor.nextElementSibling;
        while (next && next !== state.spacer) {
          const lv = levelOfRow(next);
          if (lv <= myLevel)
            break;
          if (next._group) {
            next._group.level = Math.max(0, (next._group.level || 0) - 1);
            rows.syncGroupRow(next);
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
    function cloneAsSibling(tab) {
      const sourceRow = rowOf.get(tab);
      if (!sourceRow)
        return;
      const siblingParentId = treeData(tab).parentId;
      pendingCursorMove = true;
      const clone = gBrowser.duplicateTab(tab);
      const obs = new MutationObserver(() => {
        const cloneRow = rowOf.get(clone);
        if (!cloneRow)
          return;
        obs.disconnect();
        treeData(clone).parentId = siblingParentId;
        const st = subtreeRows(sourceRow);
        st[st.length - 1].after(cloneRow);
        rows.syncTabRow(clone);
        rows.updateVisibility();
        scheduleSave();
      });
      obs.observe(state.panel, { childList: true });
    }
    function newTabBelow() {
      pendingCursorMove = true;
      gBrowser.selectedTab = gBrowser.addTab("about:newtab", {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
      });
    }
    function newGroupAbove() {
      if (!state.cursor)
        return;
      const row = rows.createGroupRow("New Group", levelOfRow(state.cursor));
      state.cursor.before(row);
      setCursor(row);
      rows.updateVisibility();
      scheduleSave();
      startRename(row);
    }
    function startExMode() {
      if (searchActive || !modeline)
        return;
      for (const child of modeline.children)
        child.hidden = true;
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
        if (e.key === "Escape") {
          endExMode(null);
          focusPanel();
          return;
        }
        if (e.key === "Enter") {
          endExMode(input.value.trim());
          focusPanel();
          return;
        }
        if (e.key === "Backspace" && !input.value) {
          endExMode(null);
          focusPanel();
          return;
        }
      });
    }
    function endExMode(cmd) {
      modeline.querySelector(".pfx-search-prefix")?.remove();
      modeline.querySelector(".pfx-search-input")?.remove();
      for (const child of modeline.children)
        child.hidden = false;
      updateModeline();
      if (!cmd)
        return;
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
            st[st.length - 1].after(row);
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
          log6("refile:start", {
            srcLabel,
            srcKind: refileSource._tab ? "tab" : refileSource._group ? "group" : "?",
            srcLevel: levelOfRow(refileSource),
            srcSubtreeSize: subtreeRows(refileSource).length
          });
          modelineMsg(`Refile: "${srcLabel}" → search for target...`);
          setTimeout(() => startSearch(), 0);
          break;
        }
        case "pin": {
          const t = state.cursor?._tab;
          if (!t) {
            modelineMsg("No tab at cursor", 3000);
            break;
          }
          if (t.pinned)
            modelineMsg(`Already pinned: ${t.label}`, 2000);
          else {
            gBrowser.pinTab(t);
            modelineMsg(`:pin ${t.label}`);
          }
          break;
        }
        case "unpin": {
          const t = state.cursor?._tab;
          if (!t) {
            modelineMsg("No tab at cursor", 3000);
            break;
          }
          if (!t.pinned)
            modelineMsg(`Not pinned: ${t.label}`, 2000);
          else {
            gBrowser.unpinTab(t);
            modelineMsg(`:unpin ${t.label}`);
          }
          break;
        }
        case "checkpoint":
        case "cp": {
          const label = args.slice(1).join(" ").trim();
          if (!label) {
            modelineMsg("Usage: :checkpoint <label>", 3000);
            break;
          }
          scheduleSave();
          setTimeout(async () => {
            try {
              const id = await history.tagLatest("checkpoint", label);
              modelineMsg(id ? `:checkpoint "${label}"` : "Nothing to tag (no events yet)", 3000);
            } catch (e) {
              modelineMsg(`:checkpoint failed: ${e.message}`, 4000);
            }
          }, 100);
          break;
        }
        case "restore": {
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
                    const ev = item.data;
                    try {
                      await restoreEvent(ev);
                      modelineMsg(`Restored: ${labelOf(ev.tag)}`, 4000);
                    } catch (e) {
                      modelineMsg(`:restore failed: ${e.message}`, 4000);
                    }
                  }
                });
                return;
              }
              const needle = arg.toLowerCase();
              const matches = tagged.filter((e) => (labelOf(e.tag) ?? "").toLowerCase().includes(needle));
              if (matches.length === 0) {
                modelineMsg(`No sessions match "${arg}"`, 3000);
                return;
              }
              const target = matches[0];
              await restoreEvent(target);
              modelineMsg(`Restored: ${labelOf(target.tag)}`, 4000);
            } catch (e) {
              modelineMsg(`:restore failed: ${e.message}`, 4000);
            }
          })();
          break;
        }
        case "sessions": {
          const q = args.slice(1).join(" ").trim();
          (async () => {
            try {
              const evs = q ? await history.search(q, { taggedOnly: true, limit: 100 }) : await history.getTagged(100);
              if (!evs.length) {
                modelineMsg(q ? `No sessions match "${q}"` : "No sessions yet", 3000);
                return;
              }
              picker.show({
                prompt: "sessions ›",
                items: evs.map((e) => ({ display: summarizeEvent(e), data: e })),
                onSelect: async (item) => {
                  const ev = item.data;
                  try {
                    await restoreEvent(ev);
                    modelineMsg(`Restored: ${labelOf(ev.tag)}`, 4000);
                  } catch (e) {
                    modelineMsg(`:sessions restore failed: ${e.message}`, 4000);
                  }
                }
              });
            } catch (e) {
              modelineMsg(`:sessions failed: ${e.message}`, 4000);
            }
          })();
          break;
        }
        case "tabs": {
          const sub = (args[1] || "").toLowerCase();
          const scope = sub === "all" || sub === "*" ? "all" : "current";
          openTabsPicker(scope);
          break;
        }
        case "blacklist":
        case "bl": {
          const sub = (args[1] || "").toLowerCase();
          if (sub === "list" || sub === "ls") {
            const list = blacklistedHosts();
            modelineMsg(list.length ? `Blacklist: ${list.join(", ")}` : "Blacklist is empty", 5000);
          } else if (sub === "remove" || sub === "rm" || sub === "del") {
            const host = args[2]?.trim() || currentHost();
            if (!host) {
              modelineMsg("No host to remove", 3000);
              break;
            }
            modelineMsg(blacklistRemove(host) ? `Removed: ${host}` : `Not in blacklist: ${host}`, 3000);
          } else {
            const host = args[1]?.trim() || currentHost();
            if (!host) {
              modelineMsg("No host to blacklist", 3000);
              break;
            }
            blacklistAdd(host);
            modelineMsg(`Blacklisted: ${host}`, 3000);
          }
          break;
        }
        case "unblacklist":
        case "ubl": {
          const host = args[1]?.trim() || currentHost();
          if (!host) {
            modelineMsg("No host to remove", 3000);
            break;
          }
          modelineMsg(blacklistRemove(host) ? `Removed: ${host}` : `Not in blacklist: ${host}`, 3000);
          break;
        }
        case "history": {
          const q = args.slice(1).join(" ").trim();
          (async () => {
            try {
              const evs = q ? await history.search(q, { taggedOnly: false, limit: 100 }) : await history.getRecent(100);
              if (!evs.length) {
                modelineMsg(q ? `No events match "${q}"` : "No history yet", 3000);
                return;
              }
              picker.show({
                prompt: "history ›",
                items: evs.map((e) => ({ display: summarizeEvent(e), data: e })),
                onSelect: async (item) => {
                  const ev = item.data;
                  try {
                    await restoreEvent(ev);
                    const label = labelOf(ev.tag);
                    modelineMsg(`Restored: ${label ?? new Date(ev.timestamp).toLocaleString()}`, 4000);
                  } catch (e) {
                    modelineMsg(`:history restore failed: ${e.message}`, 4000);
                  }
                }
              });
            } catch (e) {
              modelineMsg(`:history failed: ${e.message}`, 4000);
            }
          })();
          break;
        }
        default:
          modelineMsg(`Unknown command: ${name}`, 3000);
      }
    }
    function labelOf(tag) {
      if (!tag)
        return null;
      const i = tag.indexOf(":");
      return i >= 0 ? tag.slice(i + 1) : tag;
    }
    function summarizeEvent(e) {
      const t = labelOf(e.tag);
      const head = t ? `[${t}]` : new Date(e.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });
      const tabs = (e.snapshot.nodes ?? []).filter((n) => n.type !== "group");
      const sample = pickSample(tabs);
      return sample ? `${head} ${tabs.length}t ${sample}` : `${head} ${tabs.length}t`;
    }
    function pickSample(tabs) {
      const tail = tabs[tabs.length - 1];
      const head = tabs[0];
      const tryNode = (n) => {
        if (!n)
          return "";
        if (n.name)
          return n.name;
        const url = n.url || "";
        try {
          const host = new URL(url).hostname;
          if (host)
            return host;
        } catch {}
        return url.slice(0, 24);
      };
      const out = tryNode(tail) || tryNode(head);
      return out.length > 24 ? out.slice(0, 22) + "…" : out;
    }
    async function restoreEvent(event) {
      const env = event.snapshot;
      const tabNodes = env.nodes.filter((n) => n.type !== "group");
      if (!tabNodes.length) {
        modelineMsg("Restore: no tabs in event", 3000);
        return;
      }
      const maxSavedId = Math.max(0, ...tabNodes.map((n) => n.id || 0));
      const offset = state.nextTabId;
      state.nextTabId = state.nextTabId + maxSavedId + 1;
      const groupName = labelOf(event.tag) ?? `Restored ${new Date(event.timestamp).toLocaleString()}`;
      const groupRow = rows.createGroupRow(groupName, 0);
      state.panel.insertBefore(groupRow, state.spacer);
      rows.syncAnyRow(groupRow);
      for (const n of tabNodes) {
        const newId = (n.id || 0) + offset;
        const newParentId = typeof n.parentId === "number" ? n.parentId + offset : groupRow._group.id;
        const cloned = {
          ...n,
          id: newId,
          parentId: newParentId,
          _origIdx: savedTabQueue.length
        };
        savedTabQueue.push(cloned);
      }
      for (const n of tabNodes) {
        const url = n.url || "about:blank";
        try {
          gBrowser.addTab(url, {
            triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
          });
        } catch (e) {
          log6("restore:addTab-failed", { url, err: String(e) });
        }
      }
      scheduleSave();
    }
    function executeRefile(target) {
      if (!refileSource) {
        log6("refile:abort", { reason: "no-refileSource" });
        return;
      }
      if (!target) {
        log6("refile:abort", { reason: "no-target" });
        return;
      }
      if (target === refileSource) {
        log6("refile:abort", { reason: "target-is-source" });
        return;
      }
      const srcRows = subtreeRows(refileSource);
      if (srcRows.includes(target)) {
        log6("refile:abort", { reason: "target-in-source-subtree", srcRowsCount: srcRows.length });
        modelineMsg("Can't refile under own subtree", 3000);
        return;
      }
      const srcData = dataOf(refileSource);
      const tgtData = dataOf(target);
      if (!srcData || !tgtData) {
        log6("refile:abort", { reason: "no-data", hasSrcData: !!srcData, hasTgtData: !!tgtData });
        return;
      }
      const srcKind = refileSource._tab ? "tab" : "group";
      const tgtKind = target._tab ? "tab" : "group";
      const groupCountInSubtree = srcRows.filter((r) => r._group).length;
      log6("refile:enter", {
        srcLabel: srcData.name || refileSource._tab?.label,
        tgtLabel: tgtData.name || target._tab?.label,
        srcKind,
        tgtKind,
        srcLevel: levelOfRow(refileSource),
        tgtLevel: levelOfRow(target),
        srcSubtreeSize: srcRows.length,
        groupCountInSubtree,
        srcParentIdBefore: refileSource._tab ? treeData(refileSource._tab).parentId : null
      });
      if (refileSource._tab && target._tab) {
        const oldParentId = treeData(refileSource._tab).parentId;
        treeData(refileSource._tab).parentId = treeData(target._tab).id;
        log6("refile:tab-to-tab", {
          oldParentId,
          newParentId: treeData(target._tab).id,
          groupsAffected: groupCountInSubtree
        });
      } else {
        const tgtLevel = levelOfRow(target);
        const srcLevel = levelOfRow(refileSource);
        const delta = tgtLevel + 1 - srcLevel;
        log6("refile:level-delta", { srcLevel, tgtLevel, delta });
        for (const r of srcRows) {
          if (r._group)
            r._group.level = Math.max(0, (r._group.level || 0) + delta);
        }
      }
      const tgtSub = subtreeRows(target);
      log6("refile:placing", { tgtSubtreeSize: tgtSub.length });
      tgtSub[tgtSub.length - 1].after(...srcRows);
      for (const r of srcRows)
        rows.syncAnyRow(r);
      rows.updateVisibility();
      scheduleSave();
      log6("refile:done", {
        srcLevelAfter: levelOfRow(refileSource),
        groupLevelsAfter: srcRows.filter((r) => r._group).map((r) => r._group.level)
      });
      const label = srcData.name || refileSource._tab?.label || "tab";
      const tgtLabel = tgtData.name || target._tab?.label || "tab";
      modelineMsg(`Refiled "${label}" → "${tgtLabel}"`);
      refileSource = null;
      searchMatches = [];
      searchIdx = -1;
    }
    function cancelRefile() {
      if (refileSource) {
        log6("refile:cancel", {});
        refileSource = null;
        searchMatches = [];
        searchIdx = -1;
        modelineMsg("Refile cancelled");
      }
    }
    function startSearch() {
      if (searchActive || !modeline)
        return;
      searchActive = true;
      for (const child of modeline.children)
        child.hidden = true;
      modeline.setAttribute("pfx-visible", "true");
      const input = document.createElement("input");
      searchInput = input;
      input.className = "pfx-search-input";
      input.placeholder = "";
      modeline.appendChild(input);
      input.focus();
      const prefix = document.createXULElement("label");
      prefix.className = "pfx-search-prefix";
      prefix.setAttribute("value", "/");
      modeline.insertBefore(prefix, input);
      input.addEventListener("input", () => applyFilter(input.value));
      input.addEventListener("keydown", (e) => {
        e.stopImmediatePropagation();
        e.stopPropagation();
        if (e.key === "Escape") {
          endSearch(false);
          return;
        }
        if (e.key === "Enter") {
          endSearch(true);
          return;
        }
        if (e.key === "Backspace" && !input.value) {
          endSearch(false);
          return;
        }
      });
    }
    function endSearch(accept) {
      searchActive = false;
      if (accept) {
        const q = searchInput?.value?.trim().toLowerCase() || "";
        searchMatches = [];
        searchIdx = -1;
        const excluded = refileSource ? new Set(subtreeRows(refileSource)) : null;
        if (q) {
          for (const row of allRows()) {
            if (excluded?.has(row))
              continue;
            const d = dataOf(row);
            if (!d)
              continue;
            const label = (d.name || (row._tab ? row._tab.label : "") || "").toLowerCase();
            const url = (row._tab?.linkedBrowser?.currentURI?.spec || "").toLowerCase();
            if (label.includes(q) || url.includes(q))
              searchMatches.push(row);
          }
        }
        let dismissedToContent = false;
        if (searchMatches.length === 1) {
          const match = searchMatches[0];
          setCursor(match);
          if (match._tab)
            gBrowser.selectedTab = match._tab;
          if (refileSource) {
            executeRefile(match);
          } else {
            panelActive = false;
            searchMatches = [];
            searchIdx = -1;
            sidebarMain.dispatchEvent(new Event("pfx-dismiss"));
            dismissedToContent = true;
          }
        } else if (searchMatches.length) {
          searchIdx = 0;
          const first = searchMatches[0];
          setCursor(first);
          if (first._tab)
            gBrowser.selectedTab = first._tab;
          const hint = refileSource ? "  Enter=refile, n/N=cycle" : "";
          modelineMsg(`/${q}  [1/${searchMatches.length}]${hint}`);
        } else if (refileSource) {
          modelineMsg("No refile targets found");
        }
        clearFilter();
        if (searchInput)
          searchInput.remove();
        searchInput = null;
        const prefix = modeline?.querySelector(".pfx-search-prefix");
        if (prefix)
          prefix.remove();
        for (const child of modeline.children)
          child.hidden = false;
        updateModeline();
        if (!dismissedToContent)
          focusPanel();
      } else {
        searchMatches = [];
        searchIdx = -1;
        clearFilter();
        if (refileSource)
          cancelRefile();
        if (searchInput)
          searchInput.remove();
        searchInput = null;
        const prefix = modeline?.querySelector(".pfx-search-prefix");
        if (prefix)
          prefix.remove();
        for (const child of modeline.children)
          child.hidden = false;
        updateModeline();
        focusPanel();
      }
    }
    function applyFilter(query) {
      const q = query.trim().toLowerCase();
      if (!q) {
        clearFilter();
        return;
      }
      const allR = allRows();
      const matched = new Set;
      for (const row of allR) {
        const d = dataOf(row);
        if (!d)
          continue;
        const label = (d.name || (row._tab ? row._tab.label : "") || "").toLowerCase();
        const url = (row._tab?.linkedBrowser?.currentURI?.spec || "").toLowerCase();
        if (label.includes(q) || url.includes(q)) {
          matched.add(row);
        }
      }
      for (const row of [...matched]) {
        let lv = levelOfRow(row);
        let prev = row.previousElementSibling;
        while (prev) {
          const plv = levelOfRow(prev);
          if (plv < lv) {
            matched.add(prev);
            lv = plv;
          }
          if (plv === 0)
            break;
          prev = prev.previousElementSibling;
        }
      }
      for (const row of allR) {
        row.hidden = !matched.has(row);
      }
    }
    function clearFilter() {
      for (const row of allRows())
        row.hidden = false;
      rows.updateVisibility();
    }
    function startRename(row) {
      if (!row)
        return;
      const label = row.querySelector(".pfx-tab-label");
      if (!label)
        return;
      const d = dataOf(row);
      if (!d)
        return;
      const input = document.createElement("input");
      input.className = "pfx-rename-input";
      input.value = d.name || (row._tab ? row._tab.label : "") || "";
      label.hidden = true;
      row.insertBefore(input, label.nextSibling);
      input.focus();
      input.select();
      let done = false;
      function finish(commit) {
        if (done)
          return;
        done = true;
        if (commit) {
          const v = input.value.trim();
          if (row._group) {
            d.name = v || "New Group";
          } else {
            d.name = v && v !== row._tab.label ? v : null;
          }
          scheduleSave();
        }
        input.remove();
        label.hidden = false;
        if (row._tab)
          rows.syncTabRow(row._tab);
        else
          rows.syncAnyRow(row);
        state.panel.focus();
      }
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
          focusPanel();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
          focusPanel();
        }
        e.stopPropagation();
      });
      input.addEventListener("blur", () => finish(true));
    }
    function consumePendingCursorMove() {
      if (!pendingCursorMove)
        return false;
      pendingCursorMove = false;
      return true;
    }
    return {
      setCursor,
      activateVim,
      moveCursor,
      focusPanel,
      createModeline,
      setupVimKeys,
      setupGlobalKeys,
      cloneAsSibling,
      startRename,
      consumePendingCursorMove
    };
  }

  // src/tabs/history.ts
  var SCHEMA_VERSION = 2;
  var INSTANCE_ID_PREF = "pfx.instance.id";
  var MIGRATIONS = [
    `
  CREATE TABLE events (
    id        INTEGER PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    hash      TEXT    NOT NULL UNIQUE,
    snapshot  TEXT    NOT NULL,
    tag       TEXT
  );
  CREATE INDEX events_timestamp ON events(timestamp DESC);
  CREATE INDEX events_tag       ON events(tag) WHERE tag IS NOT NULL;

  CREATE TABLE events_search_content (
    rowid    INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    url      TEXT NOT NULL,
    label    TEXT NOT NULL
  );
  CREATE INDEX esc_event ON events_search_content(event_id);
  CREATE INDEX esc_url   ON events_search_content(url);
  CREATE INDEX esc_label ON events_search_content(label);
  `,
    `
  ALTER TABLE events ADD COLUMN instance_id TEXT;
  CREATE INDEX events_instance ON events(instance_id);
  `
  ];
  var log7 = createLogger("history");
  var _conn = null;
  var _lastHash = null;
  var _instanceId = null;
  function loadInstanceId() {
    if (_instanceId)
      return _instanceId;
    let id = "";
    try {
      id = Services.prefs.getStringPref(INSTANCE_ID_PREF, "");
    } catch {}
    if (!id) {
      id = crypto.randomUUID();
      try {
        Services.prefs.setStringPref(INSTANCE_ID_PREF, id);
      } catch {}
      log7("instanceId:generated", { id });
    }
    _instanceId = id;
    return id;
  }
  async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (const b of bytes)
      hex += b.toString(16).padStart(2, "0");
    return hex;
  }
  function canonicalize(value) {
    if (value === null || typeof value !== "object")
      return JSON.stringify(value);
    if (Array.isArray(value)) {
      return "[" + value.map(canonicalize).join(",") + "]";
    }
    const obj = value;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  async function openConnection() {
    if (_conn)
      return _conn;
    const { Sqlite } = ChromeUtils.importESModule("resource://gre/modules/Sqlite.sys.mjs");
    const path = PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, "palefox-history.sqlite");
    log7("openConnection", { path });
    const conn = await Sqlite.openConnection({ path });
    await conn.execute("PRAGMA journal_mode = WAL");
    await conn.execute("PRAGMA foreign_keys = ON");
    await applyMigrations(conn);
    _conn = conn;
    await primeLastHash(conn);
    return conn;
  }
  async function applyMigrations(conn) {
    const rows = await conn.execute("PRAGMA user_version");
    const current = rows?.[0]?.getResultByName?.("user_version") ?? 0;
    if (current >= SCHEMA_VERSION) {
      log7("migrate:current", { version: current });
      return;
    }
    log7("migrate:apply", { from: current, to: SCHEMA_VERSION });
    for (let v = current;v < SCHEMA_VERSION; v++) {
      const sql = MIGRATIONS[v];
      if (!sql)
        throw new Error(`palefox-history: no migration for v${v} → v${v + 1}`);
      await conn.executeTransaction(async () => {
        for (const stmt of sql.split(/;\s*\n/)) {
          const trimmed = stmt.trim();
          if (trimmed)
            await conn.execute(trimmed);
        }
        if (v === 1) {
          const id = loadInstanceId();
          await conn.execute("UPDATE events SET instance_id = ? WHERE instance_id IS NULL", [id]);
          log7("migrate:backfill-instance", { id });
        }
        await conn.execute(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }
  async function primeLastHash(conn) {
    const rows = await conn.execute("SELECT hash FROM events ORDER BY id DESC LIMIT 1");
    if (rows?.length) {
      _lastHash = rows[0].getResultByName("hash");
    }
  }
  function dateLabel(d = new Date) {
    const dayShort = d.toLocaleDateString("en-US", { weekday: "short" });
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const HH = String(d.getHours()).padStart(2, "0");
    const MM = String(d.getMinutes()).padStart(2, "0");
    return `Session - ${dayShort} ${yyyy}/${mm}/${dd} ${HH}:${MM}`;
  }
  function decodeRow(row) {
    const snap = row.getResultByName("snapshot");
    return {
      id: row.getResultByName("id"),
      timestamp: row.getResultByName("timestamp"),
      hash: row.getResultByName("hash"),
      snapshot: JSON.parse(snap),
      tag: row.getResultByName("tag"),
      instanceId: row.getResultByName("instance_id") ?? ""
    };
  }
  function extractSearchableRows(snapshot) {
    const out = [];
    for (const node of snapshot.nodes) {
      const url = node.url ?? "";
      const label = node.name ?? "";
      if (url || label)
        out.push({ url, label });
    }
    return out;
  }
  function makeHistory() {
    return {
      async appendEvent(snapshot) {
        const conn = await openConnection();
        const canon = canonicalize(snapshot);
        const hash = await sha256Hex(canon);
        if (hash === _lastHash) {
          return null;
        }
        const ts = Date.now();
        const instId = loadInstanceId();
        let insertedId = null;
        await conn.executeTransaction(async () => {
          await conn.execute("INSERT OR IGNORE INTO events(timestamp, hash, snapshot, tag, instance_id) VALUES (?, ?, ?, NULL, ?)", [ts, hash, canon, instId]);
          const idRows = await conn.execute("SELECT id FROM events WHERE hash = ?", [hash]);
          if (!idRows.length)
            return;
          insertedId = idRows[0].getResultByName("id");
          for (const { url, label } of extractSearchableRows(snapshot)) {
            await conn.execute("INSERT INTO events_search_content(event_id, url, label) VALUES (?, ?, ?)", [insertedId, url, label]);
          }
        });
        if (insertedId !== null) {
          _lastHash = hash;
          log7("appendEvent", { id: insertedId, ts, hashHead: hash.slice(0, 12) });
        }
        return insertedId;
      },
      async tagLatest(kind, label) {
        const conn = await openConnection();
        const finalLabel = label ?? (kind === "session" ? dateLabel() : "Untitled");
        const tagValue = `${kind}:${finalLabel}`;
        await conn.execute(`UPDATE events SET tag = ?
          WHERE id = (SELECT MAX(id) FROM events)`, [tagValue]);
        const idRows = await conn.execute("SELECT id FROM events ORDER BY id DESC LIMIT 1");
        const id = idRows?.[0]?.getResultByName?.("id") ?? null;
        log7("tagLatest", { id, tagValue });
        return id;
      },
      async getTagged(limit = 50) {
        const conn = await openConnection();
        const rows = await conn.execute(`SELECT id, timestamp, hash, snapshot, tag, instance_id
           FROM events
          WHERE tag IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT ?`, [limit]);
        return rows.map(decodeRow);
      },
      async getById(id) {
        const conn = await openConnection();
        const rows = await conn.execute("SELECT id, timestamp, hash, snapshot, tag, instance_id FROM events WHERE id = ?", [id]);
        return rows.length ? decodeRow(rows[0]) : null;
      },
      async getRecent(limit = 50) {
        const conn = await openConnection();
        const rows = await conn.execute(`SELECT id, timestamp, hash, snapshot, tag, instance_id
           FROM events
          ORDER BY timestamp DESC
          LIMIT ?`, [limit]);
        return rows.map(decodeRow);
      },
      async search(query, { taggedOnly = false, limit = 50 } = {}) {
        const conn = await openConnection();
        const trimmed = query.trim();
        if (!trimmed)
          return [];
        const tokens = trimmed.split(/\s+/).filter(Boolean);
        const escapeLike = (s) => s.replace(/([%_\\])/g, "\\$1");
        const conditions = [];
        const params = [];
        for (const tok of tokens) {
          const pat = `%${escapeLike(tok)}%`;
          conditions.push(`(esc.url LIKE ? ESCAPE '\\' OR esc.label LIKE ? ESCAPE '\\')`);
          params.push(pat, pat);
        }
        const sql = `
        SELECT events.id, events.timestamp, events.hash, events.snapshot, events.tag, events.instance_id
          FROM events
          JOIN events_search_content esc ON esc.event_id = events.id
         WHERE ${conditions.join(" AND ")}
           ${taggedOnly ? "AND events.tag IS NOT NULL" : ""}
         GROUP BY events.id
         ORDER BY events.timestamp DESC
         LIMIT ?
      `;
        params.push(limit);
        const rows = await conn.execute(sql, params);
        return rows.map(decodeRow);
      },
      async runRetention({ retainDays, maxRows } = {}) {
        const conn = await openConnection();
        const days = retainDays ?? Services.prefs.getIntPref("pfx.history.retainDays", 30);
        const max = maxRows ?? Services.prefs.getIntPref("pfx.history.maxRows", 1e4);
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        let deleted = 0;
        await conn.executeTransaction(async () => {
          await conn.execute(`DELETE FROM events WHERE tag IS NULL AND timestamp < ?`, [cutoff]);
          const after1 = await conn.execute("SELECT changes() AS c");
          const c1 = after1?.[0]?.getResultByName?.("c") ?? 0;
          deleted += c1;
          const overflow = await conn.execute(`DELETE FROM events
            WHERE tag IS NULL
              AND id IN (
                SELECT id FROM events
                 WHERE tag IS NULL
                 ORDER BY timestamp ASC
                 LIMIT MAX(0, (SELECT COUNT(*) FROM events WHERE tag IS NULL) - ?)
              )`, [max]);
          const after2 = await conn.execute("SELECT changes() AS c");
          const c2 = after2?.[0]?.getResultByName?.("c") ?? 0;
          deleted += c2;
        });
        if (deleted) {
          log7("runRetention", { deleted, retainDays: days, maxRows: max });
        }
        return deleted;
      },
      lastHash() {
        return _lastHash;
      },
      instanceId() {
        return loadInstanceId();
      },
      async close() {
        if (_conn) {
          try {
            await _conn.close();
          } catch {}
          _conn = null;
          _lastHash = null;
        }
      }
    };
  }

  // src/tabs/content-focus.ts
  var FRAME_SCRIPT_SRC = `
"use strict";
(function() {
  const UNSELECTABLE_INPUT_TYPES = new Set([
    "button","checkbox","color","file","hidden","image","radio","reset","submit"
  ]);

  function isSelectable(el) {
    if (!el || typeof el.nodeName !== "string") return false;
    const tag = el.nodeName.toLowerCase();
    if (tag === "input") return !UNSELECTABLE_INPUT_TYPES.has((el.type || "").toLowerCase());
    if (tag === "textarea") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function isEditable(el) {
    if (isSelectable(el)) return true;
    if (!el || typeof el.nodeName !== "string") return false;
    if (el.nodeName.toLowerCase() === "select") return true;
    const role = (typeof el.getAttribute === "function") ? el.getAttribute("role") : null;
    if (role === "textbox" || role === "searchbox" || role === "application") return true;
    return false;
  }

  function deepActiveElement() {
    if (!content || !content.document) return null;
    let a = content.document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) {
      a = a.shadowRoot.activeElement;
    }
    return a;
  }

  let lastReported = null;
  function report() {
    try {
      const editable = isEditable(deepActiveElement());
      if (editable === lastReported) return;
      lastReported = editable;
      sendAsyncMessage("Palefox:FocusState", { editable: editable });
    } catch (_) {}
  }

  // Capture phase + global addEventListener (which targets the message
  // manager's EventTarget, downstream of all content windows in this frame
  // loader — see WebIDL above). Survives navigation between pages.
  addEventListener("focusin",  report, true);
  addEventListener("focusout", report, true);
  addEventListener("click",    report, true);
  addEventListener("DOMContentLoaded", function () {
    lastReported = null;
    report();
  }, true);
  addEventListener("pagehide", function () {
    if (lastReported === false) return;
    lastReported = false;
    try { sendAsyncMessage("Palefox:FocusState", { editable: false }); } catch (_) {}
  }, true);

  addMessageListener("Palefox:FocusProbe", function () {
    lastReported = null;
    report();
  });

  report();
})();
`;
  function makeContentFocus() {
    const log8 = createLogger("contentFocus");
    const editablePerBrowser = new WeakMap;
    const dataUrl = "data:application/javascript;charset=utf-8," + encodeURIComponent(FRAME_SCRIPT_SRC);
    const mm = window.messageManager ?? gBrowser.messageManager;
    if (!mm) {
      log8("init:no-message-manager");
      return {
        contentInputFocused: () => false,
        diag: () => ({ messageCount: 0, lastMessageEditable: null, cachedForCurrent: undefined }),
        destroy: () => {}
      };
    }
    let messageCount = 0;
    let lastMessageEditable = null;
    function onFocusState(msg) {
      messageCount++;
      lastMessageEditable = !!msg.data.editable;
      editablePerBrowser.set(msg.target, !!msg.data.editable);
      log8("focusState:received", { editable: msg.data.editable, count: messageCount });
    }
    mm.addMessageListener("Palefox:FocusState", onFocusState);
    mm.loadFrameScript(dataUrl, true);
    log8("init", { dataUrlSize: dataUrl.length });
    function onTabSelect() {
      try {
        const browser = gBrowser.selectedBrowser;
        browser?.messageManager?.sendAsyncMessage("Palefox:FocusProbe");
      } catch (e) {
        log8("probe:error", { msg: String(e) });
      }
    }
    gBrowser.tabContainer?.addEventListener("TabSelect", onTabSelect);
    function contentInputFocused() {
      try {
        const browser = gBrowser.selectedBrowser;
        if (!browser)
          return false;
        return editablePerBrowser.get(browser) === true;
      } catch {
        return false;
      }
    }
    function destroy() {
      try {
        mm.removeMessageListener("Palefox:FocusState", onFocusState);
        mm.removeDelayedFrameScript?.(dataUrl);
      } catch (e) {
        log8("destroy:error", { msg: String(e) });
      }
      gBrowser.tabContainer?.removeEventListener("TabSelect", onTabSelect);
    }
    function diag() {
      let cachedForCurrent;
      try {
        const browser = gBrowser.selectedBrowser;
        if (browser)
          cachedForCurrent = editablePerBrowser.get(browser);
      } catch {}
      return { messageCount, lastMessageEditable, cachedForCurrent };
    }
    return { contentInputFocused, diag, destroy };
  }

  // src/platform/cross-window-tabs.ts
  function makeCrossWindowTabs() {
    return {
      all() {
        const out = [];
        try {
          const e = Services.wm.getEnumerator("navigator:browser");
          while (e.hasMoreElements()) {
            const w = e.getNext();
            const p = w.Palefox;
            if (!p)
              continue;
            const win = p.windows.current();
            for (const t of win.tabs.list()) {
              out.push({ ...t, windowId: win.windowId });
            }
          }
        } catch (e) {
          console.error("[Palefox.tabs.all] enumerate failed", e);
        }
        return out;
      },
      activate(palefoxId, windowId) {
        try {
          const e = Services.wm.getEnumerator("navigator:browser");
          while (e.hasMoreElements()) {
            const w = e.getNext();
            const p = w.Palefox;
            if (!p)
              continue;
            const win = p.windows.current();
            if (win.windowId !== windowId)
              continue;
            return win.tabs.activate(palefoxId);
          }
        } catch (e) {
          console.error("[Palefox.tabs.activate] failed", e);
        }
        return false;
      }
    };
  }

  // src/platform/history.ts
  function makePersisted(history) {
    function isOfKind(kind) {
      const prefix = `${kind}:`;
      return (e) => typeof e.tag === "string" && e.tag.startsWith(prefix);
    }
    return {
      history: {
        recent(opts) {
          return history.getRecent(opts?.limit ?? 50);
        },
        search(query, opts) {
          return history.search(query, {
            taggedOnly: opts?.taggedOnly ?? false,
            limit: opts?.limit ?? 50
          });
        },
        byId(id) {
          return history.getById(id);
        },
        instanceId() {
          return history.instanceId();
        }
      },
      checkpoints: {
        async list(opts) {
          const all = await history.getTagged(opts?.limit ?? 100);
          return all.filter(isOfKind("checkpoint"));
        },
        async search(query, opts) {
          const matches = await history.search(query, {
            taggedOnly: true,
            limit: opts?.limit ?? 50
          });
          return matches.filter(isOfKind("checkpoint"));
        },
        tag(label) {
          return history.tagLatest("checkpoint", label);
        }
      },
      sessions: {
        async list(opts) {
          const all = await history.getTagged(opts?.limit ?? 100);
          return all.filter(isOfKind("session"));
        },
        async search(query, opts) {
          const matches = await history.search(query, {
            taggedOnly: true,
            limit: opts?.limit ?? 50
          });
          return matches.filter(isOfKind("session"));
        },
        tag(label) {
          return history.tagLatest("session", label);
        }
      }
    };
  }

  // src/platform/scheduler.ts
  var DOMAIN_ORDER = [
    "prefs",
    "windows",
    "tabs",
    "snapshots",
    "sidebar",
    "command"
  ];
  function makeScheduler() {
    const log8 = createLogger("scheduler");
    const reconcilers = new Map;
    const pending = new Map;
    let pendingFlush = null;
    let pendingResolve = null;
    let lastReconcileMs = null;
    let destroyed = false;
    function getDirty(domain) {
      let arr = pending.get(domain);
      if (!arr) {
        arr = [];
        pending.set(domain, arr);
      }
      return arr;
    }
    function runOnce() {
      if (destroyed)
        return;
      const startedAt = performance.now();
      const snapshot = new Map(pending);
      pending.clear();
      for (const domain of DOMAIN_ORDER) {
        const reasons = snapshot.get(domain);
        if (!reasons || reasons.length === 0)
          continue;
        const handlers = reconcilers.get(domain) ?? [];
        for (const r of handlers) {
          try {
            r.run(reasons);
          } catch (e) {
            log8("reconciler:error", { domain, reasons, msg: String(e) });
          }
        }
      }
      lastReconcileMs = performance.now() - startedAt;
      log8("reconcile:done", { ms: lastReconcileMs });
    }
    function schedule() {
      if (pendingFlush || destroyed)
        return;
      pendingFlush = new Promise((resolve) => {
        pendingResolve = resolve;
        queueMicrotask(() => {
          try {
            runOnce();
          } finally {
            const hadCarryover = [...pending.values()].some((arr) => arr.length > 0);
            pendingFlush = null;
            const localResolve = pendingResolve;
            pendingResolve = null;
            if (hadCarryover)
              schedule();
            localResolve?.();
          }
        });
      });
    }
    function register(reconciler) {
      let list = reconcilers.get(reconciler.domain);
      if (!list) {
        list = [];
        reconcilers.set(reconciler.domain, list);
      }
      list.push(reconciler);
      log8("register", { domain: reconciler.domain });
      return () => {
        const arr = reconcilers.get(reconciler.domain);
        if (!arr)
          return;
        const i = arr.indexOf(reconciler);
        if (i >= 0)
          arr.splice(i, 1);
      };
    }
    function markDirty(domain, reason) {
      if (destroyed)
        return;
      getDirty(domain).push(reason);
      schedule();
    }
    async function flush2() {
      while (pendingFlush) {
        await pendingFlush;
      }
    }
    function diag() {
      const out = {};
      for (const d of DOMAIN_ORDER) {
        out[d] = pending.get(d) ?? [];
      }
      return {
        pending: out,
        nextFlushPending: pendingFlush !== null,
        lastReconcileMs
      };
    }
    function destroy() {
      destroyed = true;
      pending.clear();
      reconcilers.clear();
    }
    return { register, markDirty, flush: flush2, diag, destroy };
  }

  // src/platform/tabs-reconciler.ts
  function makeTabsReconciler(deps) {
    const log8 = createLogger("reconciler/tabs");
    const { scheduler } = deps;
    const unregister = scheduler.register({
      domain: "tabs",
      run(reasons) {
        log8("reconcile", { reasons });
      }
    });
    function onTabEvent(e) {
      scheduler.markDirty("tabs", e.type);
    }
    for (const ev of ["TabOpen", "TabClose", "TabMove", "TabSelect", "TabAttrModified", "TabPinned", "TabUnpinned"]) {
      gBrowser.tabContainer.addEventListener(ev, onTabEvent);
    }
    function destroy() {
      for (const ev of ["TabOpen", "TabClose", "TabMove", "TabSelect", "TabAttrModified", "TabPinned", "TabUnpinned"]) {
        gBrowser.tabContainer.removeEventListener(ev, onTabEvent);
      }
      unregister();
    }
    return { destroy };
  }

  // src/firefox/tabs.ts
  function allTabs2() {
    return gBrowser.tabs;
  }
  function selectedTab() {
    return gBrowser.selectedTab;
  }
  function selectTab(tab) {
    gBrowser.selectedTab = tab;
  }
  function pinTab(tab) {
    if (!tab.pinned)
      gBrowser.pinTab(tab);
  }
  function unpinTab(tab) {
    if (tab.pinned)
      gBrowser.unpinTab(tab);
  }
  function togglePinned(tab) {
    if (tab.pinned)
      unpinTab(tab);
    else
      pinTab(tab);
  }
  function removeTab(tab) {
    gBrowser.removeTab(tab);
  }
  function duplicateTab(tab) {
    return gBrowser.duplicateTab(tab);
  }
  function reloadTab(tab) {
    gBrowser.reloadTab(tab);
  }
  function openTab(url) {
    return gBrowser.addTab(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
    });
  }

  // src/platform/window-tabs.ts
  function makeWindowTabs(scheduler) {
    const log8 = createLogger("platform/tabs");
    function resolveTab(ref) {
      if (typeof ref === "number")
        return tabById(ref);
      return ref;
    }
    function project(tab) {
      const td = treeOf.get(tab);
      if (!td)
        return null;
      return {
        id: td.id,
        url: tab.linkedBrowser?.currentURI?.spec ?? "",
        label: tab.label ?? "",
        customName: td.name,
        pinned: !!tab.pinned,
        selected: !!tab.selected,
        hidden: !!tab.hidden,
        parentId: td.parentId,
        depth: depthOf(td)
      };
    }
    function depthOf(td) {
      let d = 0;
      let cur = td;
      while (cur && cur.parentId !== null) {
        d += 1;
        const parent = typeof cur.parentId === "number" ? tabById(cur.parentId) : null;
        if (!parent)
          break;
        cur = treeOf.get(parent);
      }
      return d;
    }
    function list() {
      const out = [];
      for (const tab of allTabs2()) {
        const p = project(tab);
        if (p)
          out.push(p);
      }
      return out;
    }
    function selected() {
      return project(selectedTab());
    }
    function get(ref) {
      const t = resolveTab(ref);
      return t ? project(t) : null;
    }
    function withTab(ref, op, reason) {
      const t = resolveTab(ref);
      if (!t) {
        log8("ref:not-found", { ref: typeof ref === "number" ? ref : "(Tab elem)" });
        return;
      }
      op(t);
      scheduler.markDirty("tabs", reason);
    }
    return {
      list,
      selected,
      get,
      pin: (r) => withTab(r, pinTab, "Palefox.tabs.pin"),
      unpin: (r) => withTab(r, unpinTab, "Palefox.tabs.unpin"),
      togglePinned: (r) => withTab(r, togglePinned, "Palefox.tabs.togglePinned"),
      close: (r) => withTab(r, removeTab, "Palefox.tabs.close"),
      duplicate(r) {
        const t = resolveTab(r);
        if (!t)
          return null;
        const dup = duplicateTab(t);
        scheduler.markDirty("tabs", "Palefox.tabs.duplicate");
        return project(dup);
      },
      reload: (r) => withTab(r, reloadTab, "Palefox.tabs.reload"),
      select: (r) => withTab(r, (t) => {
        state;
        selectTab(t);
      }, "Palefox.tabs.select"),
      activate(r) {
        const t = resolveTab(r);
        if (!t) {
          log8("activate:not-found");
          return false;
        }
        selectTab(t);
        try {
          window.focus();
        } catch {}
        scheduler.markDirty("tabs", "Palefox.tabs.activate");
        return true;
      },
      open(url) {
        const t = openTab(url);
        scheduler.markDirty("tabs", "Palefox.tabs.open");
        return project(t);
      }
    };
  }

  // src/platform/window.ts
  function makePalefoxWindow(scheduler) {
    const windowId = crypto.randomUUID();
    return {
      windowId,
      tabs: makeWindowTabs(scheduler)
    };
  }

  // src/platform/index.ts
  function makePalefox(deps) {
    const scheduler = makeScheduler();
    const tabsReconciler = makeTabsReconciler({ scheduler });
    const win = makePalefoxWindow(scheduler);
    const persisted = makePersisted(deps.history);
    const crossWindowTabs = makeCrossWindowTabs();
    return {
      windows: { current: () => win },
      tabs: crossWindowTabs,
      history: persisted.history,
      sessions: persisted.sessions,
      checkpoints: persisted.checkpoints,
      flush: () => scheduler.flush(),
      diag: () => ({
        scheduler: scheduler.diag(),
        windowId: win.windowId,
        instanceId: deps.history.instanceId()
      }),
      destroy() {
        tabsReconciler.destroy();
        scheduler.destroy();
      }
    };
  }

  // src/tabs/index.ts
  var pfxLog = createLogger("tabs");
  var sidebarMain = document.getElementById("sidebar-main");
  if (!sidebarMain)
    return;
  function clearSelection() {
    for (const r of selection)
      r.removeAttribute("pfx-multi");
    selection.clear();
  }
  function selectRange(toRow) {
    const fromRow = state.cursor || rowOf.get(gBrowser.selectedTab);
    if (!fromRow)
      return;
    const rows = allRows().filter((r) => !r.hidden);
    const fromIdx = rows.indexOf(fromRow);
    const toIdx = rows.indexOf(toRow);
    if (fromIdx < 0 || toIdx < 0)
      return;
    clearSelection();
    const start = Math.min(fromIdx, toIdx);
    const end = Math.max(fromIdx, toIdx);
    for (let i = start;i <= end; i++) {
      selection.add(rows[i]);
      rows[i].setAttribute("pfx-multi", "true");
    }
  }
  function buildPanel() {
    while (state.panel.firstChild !== state.spacer)
      state.panel.firstChild.remove();
    while (state.pinnedContainer.firstChild)
      state.pinnedContainer.firstChild.remove();
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
  var history = makeHistory();
  var contentFocus = makeContentFocus();
  var Palefox = makePalefox({ history });
  window.Palefox = Palefox;
  var scheduleSave = makeSaver(() => ({
    tabs: [...gBrowser.tabs],
    rows: () => allRows(),
    savedTabQueue,
    closedTabs,
    nextTabId: state.nextTabId,
    tabUrl,
    treeData
  }), history);
  var Rows;
  var vim;
  var drag = makeDrag({
    clearSelection,
    scheduleTreeResync: () => Rows.scheduleTreeResync(),
    scheduleSave
  });
  Rows = makeRows({
    setupDrag: drag.setupDrag,
    activateVim: (row) => vim.activateVim(row),
    selectRange,
    clearSelection,
    cloneAsSibling: (tab) => vim.cloneAsSibling(tab),
    startRename: (row) => vim.startRename(row),
    scheduleSave
  });
  var layout = makeLayout({
    sidebarMain,
    rows: Rows
  });
  vim = makeVim({
    rows: Rows,
    layout,
    scheduleSave,
    clearSelection,
    selectRange,
    sidebarMain,
    history,
    contentFocus
  });
  var events = makeEvents({
    rows: Rows,
    vim,
    scheduleSave
  });
  async function loadFromHistory() {
    const recent = await history.getRecent(1);
    if (!recent.length)
      return;
    const env = recent[0].snapshot;
    try {
      if (env.nextTabId != null)
        state.nextTabId = env.nextTabId;
      closedTabs.length = 0;
      closedTabs.push(...env.closedTabs);
      const tabs = allTabs();
      const tabNodes = env.nodes.filter((n) => n.type !== "group").map((s) => ({ ...s }));
      state.lastLoadedNodes = tabNodes.map((s) => ({ ...s }));
      for (const s of tabNodes) {
        if (s.id && s.id >= state.nextTabId)
          state.nextTabId = s.id + 1;
      }
      pfxLog("loadFromHistory", { nextTabId: state.nextTabId, savedNextTabId: env.nextTabId, tabNodes: tabNodes.length, liveTabs: tabs.length, tabNodeIds: tabNodes.map((s) => s.id), liveTabPfxIds: tabs.map((t) => t.getAttribute?.("pfx-id") || 0) });
      const applied = new Set;
      const apply = (tab, s, i) => {
        const id = s.id || state.nextTabId++;
        treeOf.set(tab, {
          id,
          parentId: s.parentId ?? null,
          name: s.name || null,
          state: s.state || null,
          collapsed: !!s.collapsed
        });
        pinTabId(tab, id);
        applied.add(i);
      };
      let li = 0;
      for (let ni = 0;ni < tabNodes.length; ni++) {
        if (li >= tabs.length)
          break;
        const s = tabNodes[ni];
        const live = tabs[li];
        const liveUrl = live.linkedBrowser?.currentURI?.spec || "";
        const pending = liveUrl === "about:blank";
        if (liveUrl === s.url || pending) {
          apply(live, s, ni);
          li++;
          continue;
        }
        let off = 0;
        for (let j = 1;j <= 5 && li + j < tabs.length; j++) {
          const u = tabs[li + j].linkedBrowser?.currentURI?.spec || "";
          if (u === s.url) {
            off = j;
            break;
          }
        }
        if (off) {
          apply(tabs[li + off], s, ni);
          li += off + 1;
        }
      }
      console.log(`palefox-tabs: loaded ${tabNodes.length} saved tab nodes, ` + `matched ${applied.size} to live tabs (of ${tabs.length}).`);
      savedTabQueue.length = 0;
      tabNodes.forEach((s, i) => {
        if (applied.has(i))
          return;
        s._origIdx = i;
        savedTabQueue.push(s);
      });
      loadedNodes = env.nodes;
    } catch (e) {
      console.error("palefox-tabs: loadFromHistory apply error", e);
    }
  }
  var loadedNodes = null;
  function buildFromSaved() {
    if (!loadedNodes || !state.panel)
      return false;
    const groupNodes = loadedNodes.filter((n) => n.type === "group");
    const leadingGroups = [];
    const groupsAfter = new Map;
    for (const g of groupNodes) {
      if (g.afterTabId == null)
        leadingGroups.push(g);
      else {
        const arr = groupsAfter.get(g.afterTabId) || [];
        arr.push(g);
        groupsAfter.set(g.afterTabId, arr);
      }
    }
    const mkGroup = (g) => {
      const row = Rows.createGroupRow(g.name || "", g.level || 0);
      row._group.state = g.state || null;
      row._group.collapsed = !!g.collapsed;
      Rows.syncGroupRow(row);
      return row;
    };
    while (state.panel.firstChild !== state.spacer)
      state.panel.firstChild.remove();
    while (state.pinnedContainer.firstChild)
      state.pinnedContainer.firstChild.remove();
    for (const g of leadingGroups)
      state.panel.insertBefore(mkGroup(g), state.spacer);
    for (const tab of gBrowser.tabs) {
      const row = Rows.createTabRow(tab);
      if (tab.pinned && state.pinnedContainer) {
        state.pinnedContainer.appendChild(row);
      } else {
        state.panel.insertBefore(row, state.spacer);
        const tid = treeData(tab).id;
        const groups = groupsAfter.get(tid);
        if (groups)
          for (const g of groups)
            state.panel.insertBefore(mkGroup(g), state.spacer);
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
    new MutationObserver(() => layout.positionPanel()).observe(sidebarMain, {
      childList: true,
      attributes: true,
      attributeFilter: ["sidebar-launcher-expanded"]
    });
    Services.prefs.addObserver("sidebar.verticalTabs", {
      observe() {
        layout.positionPanel();
      }
    });
    if (!buildFromSaved())
      buildPanel();
    buildContextMenu({
      startRename: vim.startRename,
      toggleCollapse: Rows.toggleCollapse,
      createGroupRow: Rows.createGroupRow,
      setCursor: vim.setCursor,
      updateVisibility: Rows.updateVisibility,
      scheduleSave
    });
    buildGroupContextMenu({
      startRename: vim.startRename,
      toggleCollapse: Rows.toggleCollapse,
      syncGroupRow: Rows.syncGroupRow,
      updateVisibility: Rows.updateVisibility,
      scheduleSave
    });
    vim.createModeline();
    vim.setupVimKeys();
    vim.setupGlobalKeys();
    vim.focusPanel();
    const teardownEvents = events.install();
    state.spacer.addEventListener("click", () => {
      const visible = allRows().filter((r) => !r.hidden);
      if (visible.length)
        vim.activateVim(visible[visible.length - 1]);
    });
    window.addEventListener("unload", teardownEvents, { once: true });
    const sessionTagger = {
      observe(_subject, topic) {
        if (topic === "quit-application") {
          history.tagLatest("session").catch((e) => {
            console.error("palefox-tabs: tagLatest on quit failed", e);
          });
        }
      }
    };
    Services.obs.addObserver(sessionTagger, "quit-application");
    window.addEventListener("unload", () => {
      Services.obs.removeObserver(sessionTagger, "quit-application");
    }, { once: true });
    setTimeout(() => {
      history.runRetention().catch((e) => {
        console.error("palefox-tabs: initial retention pass failed", e);
      });
    }, 30000);
    const retentionTimer = setInterval(() => {
      history.runRetention().catch(() => {});
    }, 10 * 60 * 1000);
    window.addEventListener("unload", () => {
      clearInterval(retentionTimer);
      history.close().catch(() => {});
      contentFocus.destroy();
      Palefox.destroy();
    }, { once: true });
    if (Services.prefs.getBoolPref("pfx.test.exposeAPI", false)) {
      window.pfxTest = {
        state,
        treeOf,
        rowOf,
        cursorId() {
          const r = state.cursor;
          if (!r?._tab)
            return null;
          return treeOf.get(r._tab)?.id ?? null;
        },
        snapshotTree() {
          const out = [];
          for (const t of gBrowser.tabs) {
            const td = treeOf.get(t);
            if (!td)
              continue;
            out.push({
              id: td.id,
              parentId: td.parentId,
              name: td.name,
              collapsed: td.collapsed,
              pinned: !!t.pinned,
              url: t.linkedBrowser?.currentURI?.spec ?? "",
              label: t.label
            });
          }
          return out;
        },
        vim,
        rows: Rows,
        scheduleSave,
        history,
        contentFocus,
        contentInputFocused() {
          return contentFocus.contentInputFocused();
        },
        contentFocusDiag() {
          return contentFocus.diag();
        },
        Palefox
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
})();
