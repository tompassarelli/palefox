// Drag and drop — DOM event handlers + the executeDrop coordinator that moves
// tabs in Firefox's tab strip and our panel together.
//
// Public API (factory-returned):
//   setupDrag(row)                 — wire dragstart/over/leave/drop on a row
//   setupPinnedContainerDrop(c)    — drop handler for whitespace in pinned area
//   setupPanelDrop(p)              — drop handler for whitespace in tree panel
//
// Internal state (the four drop-cycle fields below) is closure-private — only
// one drag is in flight per window, so a single closure is correct here.
//
// Dependencies are passed via the factory so this file stays a leaf module,
// no reaching into legacy globals. Most deps are tree helpers that haven't
// been extracted yet; once helpers.ts exists they'll move from deps to imports.

import { INDENT } from "./constants.ts";
import {
  state,
  rowOf,
  selection,
  movingTabs,
} from "./state.ts";
import {
  allRows,
  dataOf,
  levelOf,
  levelOfRow,
  subtreeRows,
  tabById,
  treeData,
} from "./helpers.ts";
import type { Row, Tab } from "./types.ts";

declare const gBrowser: any;
declare const document: Document;

// =============================================================================
// INTERFACE
// =============================================================================

export type DropPosition =
  | "before"
  | "after"
  | "child"
  | "into-empty-pinned"
  | "into-empty-panel";

export type DragDeps = {
  /** Clear the multi-select highlight after a drop completes. From legacy. */
  readonly clearSelection: () => void;
  /** Coalesced full-panel resync — fires after the move animation settles. */
  readonly scheduleTreeResync: () => void;
  /** Persist tree state to disk. */
  readonly scheduleSave: () => void;
};

export type DragAPI = {
  readonly setupDrag: (row: Row) => void;
  readonly setupPinnedContainerDrop: (container: HTMLElement) => void;
  readonly setupPanelDrop: (panel: HTMLElement) => void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/** Find the parentId for a tab being dropped onto a group. Groups can't be
 *  parents (they're labels, not tabs), so we mirror whatever a sibling tab
 *  at the same visual level as the group already uses for its parentId.
 *  Looks forward into the group's subtree first (the existing "tabs in this
 *  group"), then walks back outside the group. Falls back to null (root). */
function findGroupContextParent(group: Row): number | null {
  const groupLevel = group._group?.level ?? 0;
  // Forward: tabs visually inside the group at the group's level.
  let next = group.nextElementSibling;
  while (next && next !== state.spacer) {
    if (next._tab) {
      const lv = levelOf(next._tab);
      if (lv < groupLevel) break;
      if (lv === groupLevel) return treeData(next._tab).parentId;
    }
    next = next.nextElementSibling;
  }
  // Backward: tabs above the group at the group's level.
  let prev = group.previousElementSibling;
  while (prev) {
    if (prev._tab && levelOf(prev._tab) === groupLevel) {
      return treeData(prev._tab).parentId;
    }
    prev = prev.previousElementSibling;
  }
  return null;
}

/** Closest preceding tab in DOM. Skips groups. */
function findClosestTabBefore(row: Row): Tab | null {
  let prev = row.previousElementSibling;
  while (prev) {
    if (prev._tab) return prev._tab;
    prev = prev.previousElementSibling;
  }
  return null;
}

/** Last tab inside the group's visual subtree, or — if the group has no
 *  tabs in its subtree — the closest preceding tab before the group. */
function findLastTabInGroupOrBefore(group: Row): Tab | null {
  const subtreeTabs = subtreeRows(group)
    .slice(1) // skip the group row itself
    .filter(r => r._tab)
    .map(r => r._tab!);
  if (subtreeTabs.length) return subtreeTabs[subtreeTabs.length - 1]!;
  return findClosestTabBefore(group);
}


export function makeDrag(deps: DragDeps): DragAPI {
  const { clearSelection, scheduleTreeResync, scheduleSave } = deps;

  // Closure-private drag/drop cycle state.
  let dragSource: Row | null = null;
  let dropIndicator: HTMLElement | null = null;
  let dropTarget: Row | HTMLElement | null = null;
  let dropPosition: DropPosition | null = null;

  function setupDrag(row: Row): void {
    row.draggable = true;

    row.addEventListener("dragstart", (e) => {
      // Don't drag if clicking the close button.
      const t = e.target as HTMLElement;
      if (t.classList?.contains("pfx-tab-close")) {
        e.preventDefault();
        return;
      }
      dragSource = row;
      const dt = (e as DragEvent).dataTransfer!;
      dt.effectAllowed = "move";
      dt.setData("text/plain", "");
      row.setAttribute("pfx-dragging", "true");
      // Reveal an empty pinned drop zone so unpinned tabs can be pinned by
      // dropping into the area at the top of the sidebar.
      if (state.pinnedContainer && !row._tab?.pinned
          && !state.pinnedContainer.querySelector(".pfx-tab-row")) {
        state.pinnedContainer.hidden = false;
        state.pinnedContainer.setAttribute("pfx-empty-zone", "true");
      }
      // Symmetric: dragging a pinned tab and the tree panel has no rows —
      // reveal a "drop to unpin" zone in the panel.
      if (state.panel && row._tab?.pinned
          && !state.panel.querySelector(".pfx-tab-row, .pfx-group-row")) {
        state.panel.setAttribute("pfx-empty-zone", "true");
      }
    });

    row.addEventListener("dragend", () => {
      dragSource?.removeAttribute("pfx-dragging");
      dragSource = null;
      clearDropIndicator();
      // Restore hidden state on the empty pinned drop zone if still empty.
      if (state.pinnedContainer?.hasAttribute("pfx-empty-zone")) {
        state.pinnedContainer.removeAttribute("pfx-empty-zone");
        if (!state.pinnedContainer.querySelector(".pfx-tab-row")) {
          state.pinnedContainer.hidden = true;
        }
      }
      state.panel?.removeAttribute("pfx-empty-zone");
    });

    row.addEventListener("dragover", (e) => {
      if (!dragSource || dragSource === row) return;
      // Don't allow drop onto own subtree.
      if (subtreeRows(dragSource).includes(row)) return;
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = "move";

      const tgtPinned = !!row._tab?.pinned;
      if (tgtPinned) {
        // Target is pinned — horizontal layout, before/after only.
        // (Pinned tabs can't have children.)
        const rect = row.getBoundingClientRect();
        const x = (e as MouseEvent).clientX - rect.left;
        dropPosition = x < rect.width / 2 ? "before" : "after";
      } else {
        const rect = row.getBoundingClientRect();
        const y = (e as MouseEvent).clientY - rect.top;
        const zone = rect.height / 3;
        if (y < zone) dropPosition = "before";
        else if (y > zone * 2) dropPosition = "after";
        else dropPosition = "child";
      }
      dropTarget = row;
      showDropIndicator(row, dropPosition);
    });

    row.addEventListener("dragleave", (e) => {
      // Only clear if leaving the row entirely (not entering a child).
      const related = (e as DragEvent).relatedTarget as Node | null;
      if (!row.contains(related)) {
        if (dropTarget === row) clearDropIndicator();
      }
    });

    row.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!dragSource || dragSource === row) return;
      if (subtreeRows(dragSource).includes(row)) return;
      if (dropPosition && dropPosition !== "into-empty-pinned" && dropPosition !== "into-empty-panel") {
        executeDrop(dragSource, row, dropPosition);
      }
      clearDropIndicator();
    });
  }

  // Drop handlers on the pinned container itself, for two cases:
  //   1. The container is empty (no rows to drag-over): pin the source.
  //   2. Drop in trailing whitespace after the last pinned row: pin and append.
  function setupPinnedContainerDrop(container: HTMLElement): void {
    container.addEventListener("dragover", (e) => {
      if (!dragSource || dragSource._tab?.pinned) return;
      // Only handle drops landing directly on the container, not on a child row.
      if (e.target !== container) return;
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = "move";
      const lastRow = container.querySelector<HTMLElement>(".pfx-tab-row:last-of-type") as Row | null;
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
      if (!tab) { clearDropIndicator(); return; }
      if (dropTarget === container) {
        // Empty pinned container: just pin. onTabPinned moves the row.
        gBrowser.pinTab(tab);
      } else if ((dropTarget as Row | null)?._tab && dropPosition) {
        executeDrop(dragSource, dropTarget as Row, dropPosition);
      }
      clearDropIndicator();
    });
  }

  // Drop handler on the tree panel itself (not its rows). Handles:
  //   - Pinned-tab drag dropped on panel whitespace → unpin and append.
  //   - Unpinned-tab drag dropped on panel whitespace → move to end at root.
  //   - Empty panel (only spacer present): unpin into empty panel.
  function setupPanelDrop(p: HTMLElement): void {
    p.addEventListener("dragover", (e) => {
      if (!dragSource) return;
      // Only handle if the dragover landed on the panel itself or the spacer.
      if (e.target !== p && e.target !== state.spacer) return;

      // For unpinned drags, find the last root-level row that isn't part of
      // the source's own subtree — that's the anchor for an "after" drop.
      // For pinned drags, any last row works as an anchor (executeDrop will
      // unpin first, then place the row).
      const srcPinned = !!dragSource._tab?.pinned;
      let anchor: Row | null = null;
      if (srcPinned) {
        anchor = p.querySelector<HTMLElement>(
          ".pfx-tab-row:last-of-type, .pfx-group-row:last-of-type",
        ) as Row | null;
      } else {
        const srcSubtree = new Set(subtreeRows(dragSource));
        const rows = [...p.querySelectorAll<HTMLElement>(".pfx-tab-row, .pfx-group-row")] as Row[];
        for (let i = rows.length - 1; i >= 0; i--) {
          const candidate = rows[i]!;
          if (levelOfRow(candidate) === 0 && !srcSubtree.has(candidate)) {
            anchor = candidate;
            break;
          }
        }
      }

      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = "move";
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
      if (e.target !== p && e.target !== state.spacer && dropTarget !== p) return;
      e.preventDefault();
      const tab = dragSource._tab;
      if (!tab) { clearDropIndicator(); return; }
      if (dropTarget === p) {
        // Empty panel + pinned source: just unpin. onTabUnpinned routes the row.
        if (tab.pinned) gBrowser.unpinTab(tab);
      } else if (dropTarget && (dropTarget as Row)._tab || (dropTarget as Row)?._group) {
        // Anchor row may be a tab OR a group — both are valid drop targets
        // when dropping into panel whitespace at the bottom of the list.
        if (dropPosition) executeDrop(dragSource, dropTarget as Row, dropPosition);
      }
      clearDropIndicator();
    });
  }

  function showDropIndicator(targetRow: Row, position: DropPosition): void {
    if (!dropIndicator) {
      dropIndicator = document.createXULElement("box") as HTMLElement;
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
      st[st.length - 1]!.after(dropIndicator);
      dropIndicator.style.marginInlineStart = (levelOfRow(targetRow) * INDENT + 8) + "px";
    }
  }

  function clearDropIndicator(): void {
    dropIndicator?.remove();
    dropTarget = null;
    dropPosition = null;
  }

  function executeDrop(srcRow: Row, tgtRow: Row, position: DropPosition): void {
    const tgtLevel = levelOfRow(tgtRow);
    if (!dataOf(tgtRow)) return;

    const srcPinned = !!srcRow._tab?.pinned;
    const tgtPinned = !!tgtRow._tab?.pinned;
    const isCrossContainer = srcPinned !== tgtPinned;

    // Collect rows to move. Cross-container drags only carry the source tab
    // itself — pinned tabs can't have children, and dragging a pinned tab
    // out shouldn't drag siblings with it.
    let movedRows: Row[];
    if (isCrossContainer) {
      movedRows = srcRow._tab ? [srcRow] : [];
    } else if (selection.size > 1 && selection.has(srcRow)) {
      movedRows = [...allRows()].filter(r => selection.has(r));
    } else {
      movedRows = subtreeRows(srcRow);
    }
    if (!movedRows.length) return;

    const srcLevel = levelOfRow(movedRows[0]!);
    const newSrcLevel = (position === "child" && !tgtPinned) ? tgtLevel + 1 : tgtLevel;
    const delta = newSrcLevel - srcLevel;

    // Resolve source's new parentId. Three cases:
    //   - pinned target: null (pinned tabs have no parent in our tree)
    //   - tab target:    standard child/sibling logic from tgtRow._tab
    //   - group target:  groups can't be parentIds (they're labels, not tabs).
    //                    We borrow the parentId of any nearby tab at the same
    //                    level as the group — that gives us a sibling of the
    //                    tabs visually "in" the group.
    let newParentForSource: number | null = null;
    if (!tgtPinned) {
      if (tgtRow._tab) {
        newParentForSource = position === "child"
          ? treeData(tgtRow._tab).id
          : treeData(tgtRow._tab).parentId;
      } else if (tgtRow._group) {
        newParentForSource = findGroupContextParent(tgtRow);
      }
    }

    // Update parentId for top-level moved tabs; descendants keep their existing
    // parentId pointers (they follow the source in the subtree).
    const movedSet = new Set(movedRows);
    for (const r of movedRows) {
      if (!r._tab) {
        if (r._group) r._group.level = Math.max(0, (r._group.level || 0) + delta);
        continue;
      }
      const td = treeData(r._tab);
      const parent = tabById(td.parentId ?? 0);
      if (!parent || !movedSet.has(rowOf.get(parent)!)) {
        td.parentId = newParentForSource;
      }
    }

    const movedTabs = movedRows.filter(r => r._tab).map(r => r._tab!);

    // Cross-container: apply pin/unpin BEFORE computing targetIdx, since
    // pinTab/unpinTab moves the tab in gBrowser.tabs. Our onTabPinned/
    // onTabUnpinned handlers will route the row to the right container.
    if (isCrossContainer) {
      for (const t of movedTabs) {
        if (tgtPinned && !t.pinned) gBrowser.pinTab(t);
        else if (!tgtPinned && t.pinned) gBrowser.unpinTab(t);
      }
    }

    // Move Firefox tabs via gBrowser.moveTabTo so our panel and Firefox's tab
    // strip stay aligned. TabMove handlers reorder palefox rows in response.
    // Groups have no Firefox counterpart; we move them via DOM below.
    const tabsArr = [...gBrowser.tabs] as Tab[];

    // Compute target index in Firefox's tab list.
    let targetIdx: number;
    if (tgtRow._group) {
      // Group target — anchor is "last tab in group's visual subtree" for
      // after/child, or "last tab BEFORE the group" for before. If neither
      // exists, fall back to end of tab list.
      const anchorTab = position === "before"
        ? findClosestTabBefore(tgtRow)
        : findLastTabInGroupOrBefore(tgtRow);
      if (anchorTab) {
        targetIdx = tabsArr.indexOf(anchorTab) + 1;
        if (position === "before" && anchorTab) {
          // For "before", we still want source landing immediately before the
          // group — which is right after anchorTab. (If anchorTab has subtree
          // tabs ending right before the group, this still works because
          // placeRowInFirefoxOrder anchors against the subtree's last row.)
        }
      } else {
        targetIdx = tabsArr.length;
      }
    } else if (position === "before") {
      targetIdx = tabsArr.indexOf(tgtRow._tab!);
    } else {
      // "child" and "after": insert right after tgt's subtree's last Firefox tab.
      const tgtSubtreeTab = [...subtreeRows(tgtRow)].reverse().find(r => r._tab)?._tab;
      targetIdx = (tgtSubtreeTab ? tabsArr.indexOf(tgtSubtreeTab) : tabsArr.indexOf(tgtRow._tab!)) + 1;
    }
    if (targetIdx < 0) targetIdx = tabsArr.length;

    // Mark every tab we're about to move so TabMove handlers and syncTabRow
    // skip busy-sync / tree-resync while Firefox's move animation runs. One
    // final clean resync happens below after all moves settle.
    for (const t of movedTabs) movingTabs.add(t);

    // moveTabTo each moved tab, adjusting indices as we go so the group lands
    // contiguously in the right spot.
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
        const anchorRows = st.filter(r => !movedRows.includes(r));
        const anchor = anchorRows.length ? anchorRows[anchorRows.length - 1]! : tgtRow;
        anchor.after(...groupRows);
      }
    }

    clearSelection();

    // After the browser has had a frame to settle its move animation (and any
    // transient `busy` attributes), clear the moving set and do one clean
    // resync + save. requestAnimationFrame is cheap and reliable.
    requestAnimationFrame(() => {
      for (const t of movedTabs) movingTabs.delete(t);
      // Also explicitly clear any lingering `busy` attribute on our rows
      // (Firefox may have cleared it on the tab but TabAttrModified for the
      // back-to-back toggle is unreliable for pending/lazy tabs).
      for (const t of movedTabs) {
        const row = rowOf.get(t);
        if (row) row.toggleAttribute("busy", t.hasAttribute("busy"));
      }
      scheduleTreeResync();
      scheduleSave();
    });
  }

  return { setupDrag, setupPinnedContainerDrop, setupPanelDrop };
}
