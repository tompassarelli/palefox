// Panel layout — switches the tab panel between vertical (in sidebar) and
// horizontal (replacing native tab strip) modes, plus the urlbar top-layer
// dance and the toolbox-height tracking that compact mode reads.
//
// Public API (factory-returned):
//   positionPanel()           — full re-layout pass; idempotent
//   isVertical()              — current mode read from sidebar.verticalTabs
//   setUrlbarTopLayer(bool)   — pull urlbar in/out of the top layer

import { allRows, isHorizontal } from "./helpers.ts";
import { state } from "./state.ts";
import type { RowsAPI } from "./rows.ts";

declare const document: Document;
declare const Services: any;

// =============================================================================
// INTERFACE
// =============================================================================

export type LayoutDeps = {
  /** The native #sidebar-main element. Module-load time guarantees this
   *  exists (legacy returns early if not), so we type it non-null. */
  readonly sidebarMain: HTMLElement;
  /** Row-rendering API — for grid clear/visibility refresh + the polymorphic
   *  syncAnyRow on mode switches. */
  readonly rows: RowsAPI;
};

export type LayoutAPI = {
  readonly positionPanel: () => void;
  readonly isVertical: () => boolean;
  readonly setUrlbarTopLayer: (inTopLayer: boolean) => void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makeLayout(deps: LayoutDeps): LayoutAPI {
  const { sidebarMain, rows } = deps;

  // Module-private state.
  let toolboxResizeObs: ResizeObserver | null = null;
  let alignSpacer: HTMLElement | null = null;

  function isVertical(): boolean {
    return Services.prefs.getBoolPref("sidebar.verticalTabs", true);
  }

  /** Content-alignment spacer: in horizontal mode the tab strip starts at the
   *  window's left edge. Inset it by 10px so tabs don't butt against the edge. */
  function setupHorizontalAlignSpacer(): void {
    const target = document.getElementById("TabsToolbar-customization-target");
    if (!target) return;
    if (!alignSpacer) {
      alignSpacer = document.createXULElement("box") as HTMLElement;
      alignSpacer.id = "pfx-content-alignment-spacer";
      alignSpacer.style.flex = "0 0 auto";
      alignSpacer.style.width = "10px";
    }
    if (target.firstChild !== alignSpacer) target.prepend(alignSpacer);
  }

  function teardownHorizontalAlignSpacer(): void {
    alignSpacer?.remove();
  }

  /** The urlbar uses popover="manual" to draw above content. In split view
   *  that "above" includes tree popouts. We can't beat the top layer with
   *  z-index — only fix is to pull urlbar OUT of top layer while a popout is
   *  visible, then restore it on collapse. */
  function setUrlbarTopLayer(inTopLayer: boolean): void {
    const urlbar = document.getElementById("urlbar");
    if (!urlbar) return;
    // palefox-drawer owns popover state when compact mode is active.
    if (sidebarMain.hasAttribute("data-pfx-compact")) return;
    if (inTopLayer && !urlbar.hasAttribute("popover")) {
      urlbar.setAttribute("popover", "manual");
      try { (urlbar as any).showPopover(); } catch (_) {}
    } else if (!inTopLayer && urlbar.hasAttribute("popover")) {
      urlbar.removeAttribute("popover");
    }
  }

  function positionPanel(): void {
    if (!state.panel) return;

    const vertical = isVertical();
    state.panel.toggleAttribute("pfx-horizontal", !vertical);
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
        if (toolbox.nextElementSibling !== state.pinnedContainer) toolbox.after(state.pinnedContainer);
        if (state.pinnedContainer.nextElementSibling !== state.panel) state.pinnedContainer.after(state.panel);
      } else if (
        state.pinnedContainer
        && (state.panel.parentNode !== sidebarMain
            || sidebarMain.firstElementChild !== state.pinnedContainer)
      ) {
        sidebarMain.prepend(state.panel);
        sidebarMain.prepend(state.pinnedContainer);
      }
      teardownHorizontalAlignSpacer();
      // If horizontal mode had a popout open, urlbar may be without popover.
      setUrlbarTopLayer(true);
    } else {
      state.panel.removeAttribute("pfx-icons-only");
      const tabbrowserTabs = document.getElementById("tabbrowser-tabs");
      if (tabbrowserTabs && tabbrowserTabs.nextElementSibling !== state.panel) {
        tabbrowserTabs.after(state.panel);
      }
      setupHorizontalAlignSpacer();
    }

    // Track toolbox height for compact mode offset when toolbox is above sidebar.
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

    // Re-sync all rows when switching modes.
    if (vertical) rows.clearHorizontalGrid();
    for (const row of allRows()) rows.syncAnyRow(row);
    rows.updateVisibility(); // calls rows.updateHorizontalGrid() if horizontal
  }

  return { positionPanel, isVertical, setUrlbarTopLayer };
}
