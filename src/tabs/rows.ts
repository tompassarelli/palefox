// Row creation, sync, visibility — the rendering layer between Firefox tabs
// and the palefox panel DOM.
//
// Public API is the factory's return value:
//   createTabRow / createGroupRow — element factories with listeners attached
//   syncTabRow / syncGroupRow      — rerender from current state
//   updateVisibility               — apply collapsed-row hiding across panel
//   toggleCollapse                 — flip collapsed flag on a row
//   scheduleTreeResync             — coalesced full-panel sync
//
// Module-private state: a per-window groupCounter (group ids never need to be
// shared across windows or persisted) and the scheduleTreeResync flag.

import { INDENT } from "./constants.ts";
import {
  hasChildren,
  isHorizontal,
  levelOf,
  levelOfRow,
  treeData,
  dataOf,
  allRows,
} from "./helpers.ts";
import { hzDisplay, movingTabs, rowOf, state, treeOf } from "./state.ts";
import type { Group, Row, Tab } from "./types.ts";

declare const gBrowser: any;
declare const document: Document;

// =============================================================================
// INTERFACE
// =============================================================================

export type RowsDeps = {
  // From drag.ts — wires DnD listeners on every row we create.
  readonly setupDrag: (row: Row) => void;
  // From legacy (vim/selection slices not yet extracted).
  readonly activateVim: (row: Row) => void;
  readonly selectRange: (row: Row) => void;
  readonly clearSelection: () => void;
  readonly cloneAsChild: (tab: Tab) => void;
  readonly startRename: (row: Row) => void;
  // From persist factory.
  readonly scheduleSave: () => void;
};

export type RowsAPI = {
  readonly createTabRow: (tab: Tab) => Row;
  readonly syncTabRow: (tab: Tab) => void;
  readonly createGroupRow: (name: string, level?: number) => Row;
  readonly syncGroupRow: (row: Row) => void;
  /** Polymorphic sync: dispatches to syncTabRow or syncGroupRow based on
   *  which discriminator (`_tab` / `_group`) is set on the row. */
  readonly syncAnyRow: (row: Row) => void;
  readonly updateVisibility: () => void;
  readonly updateHorizontalGrid: () => void;
  readonly clearHorizontalGrid: () => void;
  readonly toggleCollapse: (row: Row) => void;
  readonly scheduleTreeResync: () => void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makeRows(deps: RowsDeps): RowsAPI {
  const {
    setupDrag, activateVim, selectRange, clearSelection,
    cloneAsChild, startRename, scheduleSave,
  } = deps;

  // Module-private state.
  let groupCounter = 0;
  let resyncPending = false;

  // ------- tab rows -------

  function createTabRow(tab: Tab): Row {
    const row = document.createXULElement("hbox") as Row;
    row.className = "pfx-tab-row";
    row.setAttribute("align", "center");

    const icon = document.createXULElement("image") as HTMLElement;
    icon.className = "pfx-tab-icon";

    const label = document.createXULElement("label") as HTMLElement;
    label.className = "pfx-tab-label";
    label.setAttribute("crop", "end");
    label.setAttribute("flex", "1");

    const close = document.createXULElement("image") as HTMLElement;
    close.className = "pfx-tab-close";

    row.append(icon, label, close);
    row._tab = tab;
    rowOf.set(tab, row);

    row.addEventListener("click", (e) => {
      const me = e as MouseEvent;
      if (me.button === 0) {
        if (me.target === close) {
          gBrowser.removeTab(tab);
        } else if (me.shiftKey) {
          selectRange(row);
        } else {
          clearSelection();
          gBrowser.selectedTab = tab;
          activateVim(row);
        }
      } else if (me.button === 1) {
        e.preventDefault();
        gBrowser.removeTab(tab);
      }
    });

    row.addEventListener("dblclick", (e) => {
      const me = e as MouseEvent;
      if (me.button === 0 && me.target !== close) {
        e.stopPropagation();
        cloneAsChild(tab);
      }
    });

    row.addEventListener("contextmenu", (e) => {
      const me = e as MouseEvent;
      e.preventDefault();
      e.stopPropagation();
      state.contextTab = tab;
      const menu = document.getElementById("pfx-tab-menu") as any;
      menu?.openPopupAtScreen(me.screenX, me.screenY, true);
    });

    setupDrag(row);
    syncTabRow(tab);
    return row;
  }

  function syncTabRow(tab: Tab): void {
    const row = rowOf.get(tab);
    if (!row) return;
    const td = treeData(tab);

    // In horizontal mode, a collapsed root may show a different tab's visuals.
    const showTab = hzDisplay.get(row) || tab;
    const showTd = showTab === tab ? td : treeData(showTab);

    const img = showTab.getAttribute("image");
    const iconEl = row.querySelector<HTMLElement>(".pfx-tab-icon");
    iconEl?.setAttribute(
      "src",
      img || "chrome://global/skin/icons/defaultFavicon.svg",
    );
    row.querySelector<HTMLElement>(".pfx-tab-label")?.setAttribute(
      "value",
      showTd.name || showTab.label || "New Tab",
    );

    row.toggleAttribute("selected", tab.selected);
    // Skip `busy` sync while we're moving this tab — Firefox toggles busy
    // during its move animation and would otherwise fade the row's icon.
    if (!movingTabs.has(tab)) {
      row.toggleAttribute("busy", tab.hasAttribute("busy"));
    }
    row.toggleAttribute("pinned", tab.pinned);
    row.toggleAttribute(
      "pfx-collapsed",
      !!td.collapsed && hasChildren(row),
    );

    row.style.paddingInlineStart = (levelOf(tab) * INDENT + 8) + "px";
  }

  // ------- group rows -------

  function createGroupRow(name: string, level: number = 0): Row {
    const group: Group = {
      id: `g${++groupCounter}`,
      type: "group",
      name: name || "New Group",
      level,
      state: null,
      collapsed: false,
    };

    const row = document.createXULElement("hbox") as Row;
    row.className = "pfx-group-row";
    row.setAttribute("align", "center");
    row._group = group;

    const marker = document.createXULElement("label") as HTMLElement;
    marker.className = "pfx-group-marker";
    marker.setAttribute("value", "●");

    const label = document.createXULElement("label") as HTMLElement;
    label.className = "pfx-tab-label";
    label.setAttribute("crop", "end");
    label.setAttribute("flex", "1");
    label.setAttribute("value", group.name);

    row.append(marker, label);

    row.addEventListener("click", (e) => {
      if ((e as MouseEvent).button === 0) activateVim(row);
    });
    row.addEventListener("dblclick", (e) => {
      if ((e as MouseEvent).button === 0) {
        e.stopPropagation();
        startRename(row);
      }
    });

    setupDrag(row);
    syncGroupRow(row);
    return row;
  }

  function syncGroupRow(row: Row): void {
    const g = row._group;
    if (!g) return;

    const label = row.querySelector<HTMLElement>(".pfx-tab-label");
    const statePrefix = g.state === "todo"
      ? "[ ] "
      : g.state === "wip"
        ? "[-] "
        : g.state === "done"
          ? "[x] "
          : "";
    label?.setAttribute("value", statePrefix + g.name);

    row.toggleAttribute(
      "pfx-collapsed",
      !!g.collapsed && hasChildren(row),
    );
    row.style.paddingInlineStart = (g.level * INDENT + 8) + "px";
  }

  // ------- visibility / collapse -------

  function updateVisibility(): void {
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

  /** Assign grid-column / grid-row so each top-level tree forms a column.
   *  Child rows (grid-row > 1) pop out below the tab bar via overflow:visible.
   *  Panel height is pinned to row 1 so children overlay content. */
  function updateHorizontalGrid(): void {
    if (!isHorizontal() || !state.panel) return;
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
      const tracks: string[] = [];
      for (let i = 1; i <= col; i++) {
        tracks.push(i === selectedCol ? "minmax(200px, 200px)" : "minmax(0, 200px)");
      }
      state.panel.style.gridTemplateColumns = tracks.join(" ");
    } else {
      state.panel.style.gridTemplateColumns = "";
    }
    // Pin panel height to first row so children overlay instead of expanding.
    requestAnimationFrame(() => {
      if (!isHorizontal() || !state.panel) return;
      const firstRow = state.panel.querySelector<HTMLElement>(
        ".pfx-tab-row:not([hidden]), .pfx-group-row:not([hidden])",
      );
      if (firstRow) {
        state.panel.style.maxHeight = (firstRow.offsetHeight + 2) + "px";
      }
    });
  }

  function clearHorizontalGrid(): void {
    if (!state.panel) return;
    state.panel.style.maxHeight = "";
    for (const row of allRows()) {
      row.style.gridColumn = "";
      row.style.gridRow = "";
      row.removeAttribute("pfx-popout-child");
    }
  }

  function toggleCollapse(row: Row): void {
    const d = dataOf(row);
    if (!d || !hasChildren(row)) return;
    d.collapsed = !d.collapsed;
    if (row._tab) syncTabRow(row._tab);
    else syncGroupRow(row);
    updateVisibility();
    scheduleSave();
  }

  // Debounced full-panel sync: coalesces multiple applies in one microtask.
  function scheduleTreeResync(): void {
    if (resyncPending) return;
    resyncPending = true;
    Promise.resolve().then(() => {
      resyncPending = false;
      for (const t of gBrowser.tabs as Iterable<Tab>) {
        if (rowOf.get(t)) syncTabRow(t);
      }
      updateVisibility();
    });
  }

  function syncAnyRow(row: Row): void {
    if (row._tab) syncTabRow(row._tab);
    else if (row._group) syncGroupRow(row);
  }

  return {
    createTabRow, syncTabRow,
    createGroupRow, syncGroupRow,
    syncAnyRow,
    updateVisibility, updateHorizontalGrid, clearHorizontalGrid,
    toggleCollapse, scheduleTreeResync,
  };
}
