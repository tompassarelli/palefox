// Tab + group context menus.
//
// Public API:
//   buildContextMenu(deps)       — tab menu (#pfx-tab-menu)
//   buildGroupContextMenu(deps)  — group menu (#pfx-group-menu)
// Both build their menupopup once at init and return the element.
//
// state.contextTab / state.contextGroupRow are set by the row-level
// contextmenu listeners (in rows.ts) before openPopupAtScreen fires, so
// by the time popupshowing runs the relevant target is available.

import { rowOf, state } from "./state.ts";
import { dataOf, hasChildren, levelOfRow, subtreeRows, treeData } from "./helpers.ts";
import type { Row } from "./types.ts";

declare const document: Document;
declare const undoCloseTab: () => void;

// =============================================================================
// INTERFACE
// =============================================================================

export type MenuDeps = {
  /** Begin in-place renaming of the row. From legacy index.ts; will move when
   *  we extract the rename slice. */
  readonly startRename: (row: Row) => void;
  /** Toggle a row's collapsed state in the tree. */
  readonly toggleCollapse: (row: Row) => void;
  /** Build a new group row at a given indent level. */
  readonly createGroupRow: (name: string, level: number) => Row;
  /** Move the vim cursor to the given row. */
  readonly setCursor: (row: Row) => void;
  /** Update collapsed-row visibility throughout the panel. */
  readonly updateVisibility: () => void;
  /** Persist tree state to disk. */
  readonly scheduleSave: () => void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function buildContextMenu(deps: MenuDeps): HTMLElement {
  const {
    startRename, toggleCollapse, createGroupRow, setCursor,
    updateVisibility, scheduleSave,
  } = deps;

  const menu = document.createXULElement("menupopup") as HTMLElement;
  menu.id = "pfx-tab-menu";

  function mi(label: string, handler: () => void): HTMLElement {
    const item = document.createXULElement("menuitem") as HTMLElement;
    item.setAttribute("label", label);
    item.addEventListener("command", handler);
    return item;
  }
  const sep = () => document.createXULElement("menuseparator") as HTMLElement;

  // --- Palefox items ---
  const renameItem = mi("Rename Tab", () => {
    if (state.contextTab) {
      const row = rowOf.get(state.contextTab);
      if (row) startRename(row);
    }
  });
  const collapseItem = mi("Collapse", () => {
    if (!state.contextTab) return;
    const row = rowOf.get(state.contextTab);
    if (row) toggleCollapse(row);
  });
  const createGroupItem = mi("Create Group", () => {
    if (!state.contextTab) return;
    const row = rowOf.get(state.contextTab);
    if (!row) return;
    const grp = createGroupRow("New Group", levelOfRow(row));
    const st = subtreeRows(row);
    st[st.length - 1]!.after(grp);
    setCursor(grp);
    updateVisibility();
    scheduleSave();
    startRename(grp);
  });
  const closeKidsItem = mi("Close Children", () => {
    if (!state.contextTab) return;
    const row = rowOf.get(state.contextTab);
    if (!row) return;
    const kids = subtreeRows(row).slice(1);
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i]!;
      if (k._tab) gBrowser.removeTab(k._tab);
      else k.remove();
    }
  });

  // --- Native actions (call Firefox APIs directly) ---
  const splitViewItem = mi("Add Split View", () => {
    if (!state.contextTab) return;
    TabContextMenu.contextTab = state.contextTab;
    TabContextMenu.contextTabs = [state.contextTab];
    // moveTabsToSplitView only exists on Firefox builds with split view.
    TabContextMenu.moveTabsToSplitView?.();
  });
  const reloadItem = mi("Reload Tab", () => {
    if (state.contextTab) gBrowser.reloadTab(state.contextTab);
  });
  const muteItem = mi("Mute Tab", () => {
    if (state.contextTab) state.contextTab.toggleMuteAudio();
  });
  const pinItem = mi("Pin Tab", () => {
    if (!state.contextTab) return;
    if (state.contextTab.pinned) gBrowser.unpinTab(state.contextTab);
    else gBrowser.pinTab(state.contextTab);
  });
  const duplicateItem = mi("Duplicate Tab", () => {
    if (state.contextTab) gBrowser.duplicateTab(state.contextTab);
  });
  const bookmarkItem = mi("Bookmark Tab", () => {
    if (state.contextTab) PlacesCommandHook.bookmarkTabs?.([state.contextTab]);
  });
  const moveToWindowItem = mi("Move to New Window", () => {
    if (state.contextTab) gBrowser.replaceTabWithWindow(state.contextTab);
  });
  const copyLinkItem = mi("Copy Link", () => {
    if (!state.contextTab) return;
    const url = state.contextTab.linkedBrowser?.currentURI?.spec;
    if (url) {
      const helper = Cc["@mozilla.org/widget/clipboardhelper;1"]!
        .getService(Ci.nsIClipboardHelper) as { copyString(s: string): void };
      helper.copyString(url);
    }
  });
  const closeItem = mi("Close Tab", () => {
    if (state.contextTab) gBrowser.removeTab(state.contextTab);
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
    closeItem, reopenItem,
  );

  menu.addEventListener("popupshowing", () => {
    if (!state.contextTab) return;
    const row = rowOf.get(state.contextTab);
    const has = !!row && hasChildren(row);
    collapseItem.hidden = !has;
    closeKidsItem.hidden = !has;
    if (has && row) {
      const d = dataOf(row);
      collapseItem.setAttribute("label", d?.collapsed ? "Expand" : "Collapse");
    }
    muteItem.setAttribute(
      "label",
      state.contextTab.hasAttribute("muted") ? "Unmute Tab" : "Mute Tab",
    );
    pinItem.setAttribute(
      "label",
      state.contextTab.pinned ? "Unpin Tab" : "Pin Tab",
    );
    splitViewItem.hidden = !!state.contextTab.splitview;
  });

  document.getElementById("mainPopupSet")!.appendChild(menu);
  return menu;
}


// =============================================================================
// GROUP CONTEXT MENU
// =============================================================================

export type GroupMenuDeps = {
  readonly startRename: (row: Row) => void;
  /** Toggle a row's collapsed state in the tree. */
  readonly toggleCollapse: (row: Row) => void;
  /** Polymorphic row sync — used after decrementing nested group levels. */
  readonly syncGroupRow: (row: Row) => void;
  readonly updateVisibility: () => void;
  readonly scheduleSave: () => void;
};

/** Build the group-row context menu. Operates on state.contextGroupRow,
 *  which the row's contextmenu listener sets before openPopupAtScreen. */
export function buildGroupContextMenu(deps: GroupMenuDeps): HTMLElement {
  const { startRename, toggleCollapse, syncGroupRow, updateVisibility, scheduleSave } = deps;

  const menu = document.createXULElement("menupopup") as HTMLElement;
  menu.id = "pfx-group-menu";

  function mi(label: string, handler: () => void): HTMLElement {
    const item = document.createXULElement("menuitem") as HTMLElement;
    item.setAttribute("label", label);
    item.addEventListener("command", handler);
    return item;
  }
  const sep = () => document.createXULElement("menuseparator") as HTMLElement;

  const renameItem = mi("Rename Group", () => {
    if (state.contextGroupRow) startRename(state.contextGroupRow);
  });

  const collapseItem = mi("Collapse", () => {
    if (state.contextGroupRow) toggleCollapse(state.contextGroupRow);
  });

  const closeGroupItem = mi("Close Group", () => {
    const row = state.contextGroupRow;
    if (!row || !row._group) return;
    const myLevel = row._group.level || 0;
    const groupId = row._group.id;
    // Reparent tabs whose parentId points at this group to null — otherwise
    // levelOf would treat them as orphans (group lookup fails) and silently
    // drop them to root anyway, but doing it explicitly keeps the saved
    // tree consistent.
    for (const tab of gBrowser.tabs) {
      const td = treeData(tab);
      if (td.parentId === groupId) td.parentId = null;
    }
    // Decrement nested groups in the visual subtree by one level.
    let next = row.nextElementSibling;
    while (next && next !== state.spacer) {
      const lv = levelOfRow(next);
      if (lv <= myLevel) break;
      if (next._group) {
        next._group.level = Math.max(0, (next._group.level || 0) - 1);
        syncGroupRow(next as Row);
      }
      next = next.nextElementSibling;
    }
    row.remove();
    updateVisibility();
    scheduleSave();
  });

  const closeTabsItem = mi("Close Tabs in Group", () => {
    const row = state.contextGroupRow;
    if (!row) return;
    const tabsInGroup = subtreeRows(row)
      .slice(1) // skip the group row itself
      .filter(r => r._tab)
      .map(r => r._tab!);
    // Close in reverse so index shifts don't matter.
    for (let i = tabsInGroup.length - 1; i >= 0; i--) {
      gBrowser.removeTab(tabsInGroup[i]);
    }
  });

  const moveToWindowItem = mi("Move Tabs to New Window", () => {
    const row = state.contextGroupRow;
    if (!row) return;
    const tabsInGroup = subtreeRows(row)
      .slice(1)
      .filter(r => r._tab)
      .map(r => r._tab!);
    if (!tabsInGroup.length) return;
    if (typeof gBrowser.replaceTabsWithWindow === "function") {
      gBrowser.replaceTabsWithWindow(tabsInGroup);
    } else {
      // Fallback: lift the first tab to a new window.
      gBrowser.replaceTabWithWindow(tabsInGroup[0]);
    }
  });

  menu.append(
    renameItem, collapseItem, closeTabsItem,
    sep(),
    closeGroupItem, moveToWindowItem,
  );

  menu.addEventListener("popupshowing", () => {
    const row = state.contextGroupRow;
    if (!row || !row._group) return;
    const has = hasChildren(row);
    collapseItem.hidden = !has;
    if (has) {
      collapseItem.setAttribute("label",
        row._group.collapsed ? "Expand" : "Collapse",
      );
    }
    closeTabsItem.hidden = !has;
    moveToWindowItem.hidden = !has;
  });

  document.getElementById("mainPopupSet")!.appendChild(menu);
  return menu;
}
