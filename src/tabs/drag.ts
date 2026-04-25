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
import { createLogger } from "./log.ts";
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

const log = createLogger("tabs/drag");

/** Pretty-printer for a row — used in log lines so we can correlate source
 *  vs target across event boundaries without dumping the whole element. */
function rowDesc(row: Row | null | undefined): Record<string, unknown> {
  if (!row) return { row: "null" };
  if (row._tab) {
    return {
      kind: "tab",
      id: treeData(row._tab).id,
      label: row._tab.label,
      level: levelOf(row._tab),
      pinned: !!row._tab.pinned,
      parentId: treeData(row._tab).parentId,
    };
  }
  if (row._group) {
    return {
      kind: "group",
      id: row._group.id,
      name: row._group.name,
      level: row._group.level,
    };
  }
  return { kind: "?" };
}

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

/** Find the parentId for a tab being dropped INTO a group (child / after).
 *  Groups can't be parents (they're labels, not tabs), but the user expects
 *  the dropped tab to appear visually nested inside the group's section —
 *  which means level groupLevel + 1.
 *
 *  Two ways to derive that parentId:
 *    1. Forward walk into the group's subtree — tabs there are already at
 *       lv > groupLevel; their parentId is the level-groupLevel container
 *       we want to inherit.
 *    2. Back walk — find the closest preceding tab at exactly groupLevel.
 *       That tab is the level-groupLevel container; its id is what we want
 *       (source becomes its child at lv = groupLevel + 1).
 *
 *  Falls back to null if neither yields a result (group is detached at
 *  level 0 with no preceding tab — treat source as root). */
function findGroupContextParent(group: Row): number | null {
  const groupLevel = group._group?.level ?? 0;

  // Forward: any tab inside the group's visual subtree (lv > groupLevel).
  let next = group.nextElementSibling;
  while (next && next !== state.spacer) {
    if (next._tab) {
      const lv = levelOf(next._tab);
      if (lv <= groupLevel) break; // exited the group's subtree
      const result = treeData(next._tab).parentId;
      log("findGroupContextParent:forward", {
        groupLevel,
        foundTab: next._tab.label,
        foundLevel: lv,
        resultParentId: result,
      });
      return result;
    }
    next = next.nextElementSibling;
  }

  // Backward: tab at exactly groupLevel — return its id (source is child).
  let prev = group.previousElementSibling;
  while (prev) {
    if (prev._tab && levelOf(prev._tab) === groupLevel) {
      const result = treeData(prev._tab).id;
      log("findGroupContextParent:backward", {
        groupLevel,
        foundTab: prev._tab.label,
        foundLevel: groupLevel,
        resultParentId: result,
      });
      return result;
    }
    prev = prev.previousElementSibling;
  }
  log("findGroupContextParent:fallback", { groupLevel, resultParentId: null });
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
      log("dragstart", { source: rowDesc(row) });
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
      log("dragend/row", {
        listenerOnRow: rowDesc(row),
        sourceWas: dragSource ? rowDesc(dragSource) : "already-null",
        dropTargetWas: dropTarget instanceof HTMLElement && (dropTarget as Row)._tab
          ? rowDesc(dropTarget as Row)
          : dropTarget instanceof HTMLElement && (dropTarget as Row)._group
          ? rowDesc(dropTarget as Row)
          : (dropTarget as any) === state.panel ? "panel"
          : (dropTarget as any) === state.pinnedContainer ? "pinnedContainer"
          : "other",
        dropPositionWas: dropPosition,
      });
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
      // Only log on group targets (where the drag-onto-group bug lives) or
      // on transitions to keep the log tight during rapid-fire dragover.
      if (row._group) {
        log("dragover/group", {
          target: rowDesc(row),
          source: rowDesc(dragSource),
          position: dropPosition,
        });
      }
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
      // Log entry FIRST — before any early-return — so we can see if drop is
      // even firing on the row. The dragSource/source-equals-row gates come after.
      log("drop/row:fired", {
        listenerOnRow: rowDesc(row),
        eventTarget: (e.target as Element)?.className || (e.target as Element)?.tagName,
        hasDragSource: !!dragSource,
        sourceEqualsRow: dragSource === row,
      });
      e.preventDefault();
      if (!dragSource) {
        log("drop/row:abort", { reason: "no-dragSource" });
        return;
      }
      if (dragSource === row) {
        log("drop/row:abort", { reason: "source-equals-row" });
        return;
      }
      if (subtreeRows(dragSource).includes(row)) {
        log("drop/row:abort", { reason: "row-in-source-subtree" });
        return;
      }
      log("drop/row:proceeding", {
        target: rowDesc(row),
        source: rowDesc(dragSource),
        position: dropPosition,
      });
      if (dropPosition && dropPosition !== "into-empty-pinned" && dropPosition !== "into-empty-panel") {
        executeDrop(dragSource, row, dropPosition);
      } else {
        log("drop/row:abort", { reason: "no-or-empty-zone-position", dropPosition });
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
      log("drop/pinnedContainer:fired", {
        eventTarget: (e.target as Element)?.id || (e.target as Element)?.className || (e.target as Element)?.tagName,
        hasDragSource: !!dragSource,
        srcPinned: !!dragSource?._tab?.pinned,
      });
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
      log("drop/panel:fired", {
        eventTarget: (e.target as Element)?.id || (e.target as Element)?.className || (e.target as Element)?.tagName,
        eventTargetIsPanel: e.target === p,
        eventTargetIsSpacer: e.target === state.spacer,
        hasDragSource: !!dragSource,
      });
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
    if (!dataOf(tgtRow)) {
      log("executeDrop:abort", { reason: "no-tgt-data", target: rowDesc(tgtRow) });
      return;
    }

    const srcPinned = !!srcRow._tab?.pinned;
    const tgtPinned = !!tgtRow._tab?.pinned;
    const isCrossContainer = srcPinned !== tgtPinned;

    log("executeDrop:enter", {
      source: rowDesc(srcRow),
      target: rowDesc(tgtRow),
      position,
      srcPinned, tgtPinned, isCrossContainer,
      tgtLevel,
    });

    let movedRows: Row[];
    if (isCrossContainer) {
      movedRows = srcRow._tab ? [srcRow] : [];
    } else if (selection.size > 1 && selection.has(srcRow)) {
      movedRows = [...allRows()].filter(r => selection.has(r));
    } else {
      movedRows = subtreeRows(srcRow);
    }
    if (!movedRows.length) {
      log("executeDrop:abort", { reason: "no-movedRows" });
      return;
    }

    const srcLevel = levelOfRow(movedRows[0]!);
    const newSrcLevel = (position === "child" && !tgtPinned) ? tgtLevel + 1 : tgtLevel;
    const delta = newSrcLevel - srcLevel;

    log("executeDrop:plan", {
      movedRowsCount: movedRows.length,
      movedRowsKinds: movedRows.map(r => r._tab ? "tab" : r._group ? "group" : "?"),
      srcLevel, newSrcLevel, delta,
    });

    let newParentForSource: number | null = null;
    let parentBranch: string;
    if (!tgtPinned) {
      if (tgtRow._tab) {
        parentBranch = position === "child" ? "tab/child→tgtId" : "tab/sibling→tgtParentId";
        newParentForSource = position === "child"
          ? treeData(tgtRow._tab).id
          : treeData(tgtRow._tab).parentId;
      } else if (tgtRow._group) {
        parentBranch = "group→findGroupContextParent";
        newParentForSource = findGroupContextParent(tgtRow);
      } else {
        parentBranch = "no-tab-no-group→null";
      }
    } else {
      parentBranch = "pinned→null";
    }
    log("executeDrop:newParent", { branch: parentBranch, newParentForSource });

    // Update parentId for top-level moved tabs; descendants keep their existing
    // parentId pointers (they follow the source in the subtree).
    const movedSet = new Set(movedRows);
    let parentIdMutations = 0;
    for (const r of movedRows) {
      if (!r._tab) {
        if (r._group) r._group.level = Math.max(0, (r._group.level || 0) + delta);
        continue;
      }
      const td = treeData(r._tab);
      const parent = tabById(td.parentId ?? 0);
      if (!parent || !movedSet.has(rowOf.get(parent)!)) {
        const oldPid = td.parentId;
        td.parentId = newParentForSource;
        parentIdMutations++;
        log("executeDrop:mutate", {
          tab: r._tab.label,
          tabId: td.id,
          oldParentId: oldPid,
          newParentId: newParentForSource,
        });
      }
    }
    log("executeDrop:mutations", { parentIdMutations });

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
    let idxBranch: string;
    if (tgtRow._group) {
      const anchorTab = position === "before"
        ? findClosestTabBefore(tgtRow)
        : findLastTabInGroupOrBefore(tgtRow);
      if (anchorTab) {
        targetIdx = tabsArr.indexOf(anchorTab) + 1;
        idxBranch = `group/${position}→after-anchor(${anchorTab.label || "?"}@${tabsArr.indexOf(anchorTab)})`;
      } else {
        targetIdx = tabsArr.length;
        idxBranch = `group/${position}→no-anchor→end(${tabsArr.length})`;
      }
    } else if (position === "before") {
      targetIdx = tabsArr.indexOf(tgtRow._tab!);
      idxBranch = `tab/before→${targetIdx}`;
    } else {
      const tgtSubtreeTab = [...subtreeRows(tgtRow)].reverse().find(r => r._tab)?._tab;
      targetIdx = (tgtSubtreeTab ? tabsArr.indexOf(tgtSubtreeTab) : tabsArr.indexOf(tgtRow._tab!)) + 1;
      idxBranch = `tab/${position}→after-${tgtSubtreeTab ? "subtreeLast" : "self"}→${targetIdx}`;
    }
    if (targetIdx < 0) {
      idxBranch += `→clamp(${tabsArr.length})`;
      targetIdx = tabsArr.length;
    }
    log("executeDrop:targetIdx", { idxBranch, targetIdx, tabsLen: tabsArr.length });

    // Mark every tab we're about to move so TabMove handlers and syncTabRow
    // skip busy-sync / tree-resync while Firefox's move animation runs. One
    // final clean resync happens below after all moves settle.
    for (const t of movedTabs) movingTabs.add(t);

    let insertIdx = targetIdx;
    let actualMoves = 0;
    for (const t of movedTabs) {
      const currentIdx = [...gBrowser.tabs].indexOf(t);
      if (currentIdx < 0) continue;
      if (currentIdx < insertIdx) insertIdx--;
      if (currentIdx !== insertIdx) {
        log("executeDrop:moveTabTo", {
          tab: t.label, currentIdx, insertIdx,
        });
        gBrowser.moveTabTo(t, { tabIndex: insertIdx });
        actualMoves++;
      }
      insertIdx++;
    }
    log("executeDrop:moveSummary", { actualMoves, totalTabs: movedTabs.length });

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
      log("executeDrop:groupDOMMove", { groupRowsCount: groupRows.length });
    }

    clearSelection();

    requestAnimationFrame(() => {
      for (const t of movedTabs) movingTabs.delete(t);
      for (const t of movedTabs) {
        const row = rowOf.get(t);
        if (row) row.toggleAttribute("busy", t.hasAttribute("busy"));
      }
      // Final state for verification.
      log("executeDrop:settled", {
        sourceFinal: rowDesc(srcRow),
        sourceParentInTree: srcRow._tab ? treeData(srcRow._tab).parentId : null,
        sourceLevelDerived: srcRow._tab ? levelOf(srcRow._tab) : null,
        sourceDOMParent: srcRow.parentNode === state.panel ? "panel"
          : srcRow.parentNode === state.pinnedContainer ? "pinnedContainer"
          : "?",
        sourcePrevSibling: rowDesc((srcRow.previousElementSibling || null) as Row | null),
        sourceNextSibling: rowDesc((srcRow.nextElementSibling || null) as Row | null),
      });
      scheduleTreeResync();
      scheduleSave();
    });
  }

  return { setupDrag, setupPinnedContainerDrop, setupPanelDrop };
}
