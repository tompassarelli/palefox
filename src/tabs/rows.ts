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
import { createLogger } from "./log.ts";
import { hzDisplay, movingTabs, rowOf, state, treeOf } from "./state.ts";
import type { Group, Row, Tab } from "./types.ts";

declare const document: Document;
declare const window: any;

const log = createLogger("tabs/rows");

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
  readonly cloneAsSibling: (tab: Tab) => void;
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
    cloneAsSibling, startRename, scheduleSave,
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

    const chevron = document.createXULElement("image") as HTMLElement;
    chevron.className = "pfx-tab-chevron";

    row.append(icon, label, chevron);
    row._tab = tab;
    rowOf.set(tab, row);

    row.addEventListener("click", (e) => {
      const me = e as MouseEvent;
      if (me.button === 0) {
        if (me.shiftKey) {
          selectRange(row);
        } else {
          // In horizontal mode, a collapsed root cell shows the last-selected
          // member of its tree (hzDisplay). Click should resume that tab and
          // park the vim cursor on it so the tree expands around it.
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
      const me = e as MouseEvent;
      if (me.button === 0) {
        e.stopPropagation();
        cloneAsSibling(tab);
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
    row.addEventListener("contextmenu", (e) => {
      const me = e as MouseEvent;
      e.preventDefault();
      e.stopPropagation();
      state.contextGroupRow = row;
      const menu = document.getElementById("pfx-group-menu") as any;
      menu?.openPopupAtScreen(me.screenX, me.screenY, true);
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
   *  Container height is pinned to row 1 so children overlay content.
   *  Pinned and panel are separate grid containers — process each one with
   *  its own column counter. */
  function updateHorizontalGrid(): void {
    if (!isHorizontal()) return;
    const containers = [state.pinnedContainer, state.panel].filter(Boolean) as HTMLElement[];
    for (const container of containers) {
      const rowsInContainer = [
        ...container.querySelectorAll<HTMLElement>(".pfx-tab-row, .pfx-group-row"),
      ] as Row[];
      let col = 0;
      let rowInCol = 0;
      let selectedCol = 0;
      for (const row of rowsInContainer) {
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
      if (col > 0) {
        const tracks: string[] = [];
        for (let i = 1; i <= col; i++) {
          tracks.push(i === selectedCol ? "minmax(200px, 200px)" : "minmax(0, 200px)");
        }
        container.style.gridTemplateColumns = tracks.join(" ");
      } else {
        container.style.gridTemplateColumns = "";
      }
    }
    // Pin each grid container's height to its first row so children overlay
    // instead of expanding the toolbar.
    requestAnimationFrame(() => {
      if (!isHorizontal()) return;
      for (const container of containers) {
        const firstRow = container.querySelector<HTMLElement>(
          ".pfx-tab-row:not([hidden]), .pfx-group-row:not([hidden])",
        );
        if (firstRow) {
          container.style.maxHeight = (firstRow.offsetHeight + 2) + "px";
        }
      }
      // Backstop: whenever popouts are visible, the urlbar's popover="manual"
      // top-layer placement steals priority over them. Demote it; restore on
      // close. This duplicates vim's setUrlbarTopLayer call to handle paths
      // (e.g. cursor on pinned root) where vim's expand path didn't fire.
      const totalPopouts =
        (state.panel?.querySelectorAll("[pfx-popout-child]").length ?? 0)
        + (state.pinnedContainer?.querySelectorAll("[pfx-popout-child]").length ?? 0);
      const urlbar = document.getElementById("urlbar");
      if (urlbar) {
        const before = {
          hasPopover: urlbar.hasAttribute("popover"),
          matchesOpen: (() => {
            try { return (urlbar as any).matches(":popover-open"); } catch { return null; }
          })(),
        };
        if (totalPopouts > 0 && urlbar.hasAttribute("popover")) {
          urlbar.removeAttribute("popover");
        }
        log("hzGrid:urlbar", { totalPopouts, before, hasPopoverAfter: urlbar.hasAttribute("popover") });
      }
      // Popouts: lift to position:fixed AND promote into the HTML top layer
      // via popover="manual". The urlbar uses the same trick, and top layer
      // beats every z-index in the document — that's why our previous z:9999
      // attempt didn't work.
      for (const container of containers) {
        const allRowsInContainer = container.querySelectorAll<HTMLElement>(
          ".pfx-tab-row, .pfx-group-row",
        );
        for (const p of allRowsInContainer) {
          if (p.style.position === "fixed") {
            p.style.position = "";
            p.style.left = "";
            p.style.top = "";
            p.style.width = "";
            p.style.zIndex = "";
          }
        }
        const popouts = [...container.querySelectorAll<HTMLElement>("[pfx-popout-child]")];
        if (popouts.length) {
          void container.offsetHeight;
          const rects = popouts.map(p => p.getBoundingClientRect());
          for (let i = 0; i < popouts.length; i++) {
            const p = popouts[i]!;
            const r = rects[i]!;
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
      // Diagnostic log — keep so future regressions are easy to chase.
      const popout = state.panel?.querySelector<HTMLElement>("[pfx-popout-child]");
      if (popout) {
        const cs = (el: Element | null) => {
          if (!el) return null;
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            position: s.position, zIndex: s.zIndex, overflow: s.overflow,
            rect: { x: Math.round(r.left), y: Math.round(r.top),
                    w: Math.round(r.width), h: Math.round(r.height) },
          };
        };
        log("hzGrid:stacking", {
          popout: cs(popout),
          panel: cs(state.panel),
          tabsToolbar: cs(document.getElementById("TabsToolbar")),
          navBar: cs(document.getElementById("nav-bar")),
          urlbar: cs(document.getElementById("urlbar")),
        });
      }
    });
  }

  function clearHorizontalGrid(): void {
    for (const container of [state.pinnedContainer, state.panel]) {
      if (!container) continue;
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
