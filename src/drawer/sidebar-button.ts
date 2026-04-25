// Custom sidebar button + context menu.
//
// Replaces Firefox's native #sidebar-button with our own #pfx-sidebar-button:
//   - left-click: toggle compact mode for whichever layout (vertical /
//     horizontal) is currently active
//   - right-click: opens our own #pfx-sidebar-button-menu (we own the
//     popup completely; previous overload-Firefox's-menu approach
//     fought UA popupshowing handlers and made items morph mid-paint)
//
// Items in the menu:
//   - Enable/Disable Compact (label flips per current state)
//   - Collapse/Expand Layout (vertical only — clicks the hidden native
//     button briefly to flip sidebar-launcher-expanded)
//   - Enable/Disable Sidebar (toggles the bookmarks/history sidebar widget
//     via SidebarController/SidebarUI/cmd_toggleSidebar fallback chain)
//   - Horizontal/Vertical Tabs (flips sidebar.verticalTabs pref)
//   - separator
//   - Customize Sidebar (passes through to Firefox's customize-sidebar
//     command so users keep access to the upstream UI)

import { createLogger } from "../tabs/log.ts";
import type { CompactAPI } from "./compact.ts";

declare const Services: {
  prefs: {
    getBoolPref(name: string, def: boolean): boolean;
    setBoolPref(name: string, value: boolean): void;
  };
};

declare const window: Window & {
  SidebarController?: { toggle?: () => void; isOpen?: boolean };
  SidebarUI?: { toggle?: () => void };
};

// =============================================================================
// INTERFACE
// =============================================================================

export type SidebarButtonDeps = {
  readonly sidebarMain: HTMLElement;
  readonly compact: CompactAPI;
};

export type SidebarButtonAPI = {
  destroy(): void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makeSidebarButton(deps: SidebarButtonDeps): SidebarButtonAPI {
  const log = createLogger("drawer/sidebar-button");
  const { sidebarMain, compact } = deps;
  const xul = (tag: string): HTMLElement =>
    (document as Document & { createXULElement(t: string): HTMLElement }).createXULElement(tag);

  const sidebarButton = document.getElementById("sidebar-button");
  if (!sidebarButton) {
    log("init:no-sidebar-button");
    return { destroy: () => {} };
  }

  // Snapshot the icon style before hiding the native button.
  const ogIcon = sidebarButton.querySelector(".toolbarbutton-icon");
  const ogIconStyle = ogIcon ? getComputedStyle(ogIcon).listStyleImage : null;

  sidebarButton.style.display = "none";

  const pfxButton = xul("toolbarbutton");
  pfxButton.id = "pfx-sidebar-button";
  pfxButton.className = sidebarButton.className;
  pfxButton.setAttribute(
    "tooltiptext",
    "Toggle compact mode (right-click for more)",
  );
  // Copy CUI attributes so Firefox's popupshowing logic recognizes our
  // button as a real toolbar widget.
  for (const attr of [
    "cui-areatype",
    "widget-id",
    "widget-type",
    "removable",
    "overflows",
  ]) {
    if (sidebarButton.hasAttribute(attr)) {
      pfxButton.setAttribute(attr, sidebarButton.getAttribute(attr) ?? "");
    }
  }
  if (ogIconStyle) pfxButton.style.listStyleImage = ogIconStyle;
  sidebarButton.after(pfxButton);

  function onClick(e: Event): void {
    if ((e as MouseEvent).button !== 0) return;
    compact.toggle();
  }
  pfxButton.addEventListener("click", onClick);

  // --- Custom context menu ---
  const pfxMenu = xul("menupopup");
  pfxMenu.id = "pfx-sidebar-button-menu";

  function mi(id: string, label: string, onCommand: () => void): HTMLElement {
    const item = xul("menuitem");
    item.id = id;
    item.setAttribute("label", label);
    item.addEventListener("command", onCommand);
    return item;
  }

  const compactItem = mi("pfx-toggle-compact", "Enable Compact",
    () => compact.toggle());

  const collapseItem = mi("pfx-collapse-layout", "Collapse Layout", () => {
    try {
      const prevDisplay = sidebarButton!.style.display;
      sidebarButton!.style.display = "";
      (sidebarButton as HTMLElement).click();
      sidebarButton!.style.display = prevDisplay;
    } catch (e) {
      console.error("[PFX:drawer] collapse layout failed", e);
    }
  });

  const sidebarItem = mi("pfx-toggle-sidebar", "Enable Sidebar", () => {
    try {
      if (window.SidebarController?.toggle) { window.SidebarController.toggle(); return; }
      if (window.SidebarUI?.toggle) { window.SidebarUI.toggle(); return; }
      const cmd = document.getElementById("cmd_toggleSidebar") as (HTMLElement & { doCommand?: () => void }) | null;
      if (cmd?.doCommand) { cmd.doCommand(); return; }
      console.error("[PFX:drawer] no sidebar-toggle API available");
    } catch (e) { console.error("[PFX:drawer] sidebar toggle failed", e); }
  });

  const layoutItem = mi("pfx-toggle-tab-layout", "Horizontal Tabs", () => {
    const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
    Services.prefs.setBoolPref("sidebar.verticalTabs", !vertical);
  });

  const customizeItem = mi("pfx-customize-sidebar", "Customize Sidebar", () => {
    try {
      const native = document.getElementById("toolbar-context-customize-sidebar") as (HTMLElement & { doCommand?: () => void }) | null;
      native?.doCommand?.();
      if (!native?.doCommand) native?.click?.();
    } catch (e) { console.error("palefox: customize sidebar failed", e); }
  });

  pfxMenu.append(
    compactItem,
    collapseItem,
    sidebarItem,
    layoutItem,
    xul("menuseparator"),
    customizeItem,
  );

  // Append to mainPopupSet so it's at the document root (rendered in the
  // top layer like all chrome popups).
  const popupSet = document.getElementById("mainPopupSet");
  popupSet?.appendChild(pfxMenu);

  // Wire the button to our menu. Firefox's context-menu plumbing reads
  // the `context` attribute and opens the named popup on right-click.
  pfxButton.setAttribute("context", "pfx-sidebar-button-menu");

  // Update labels / hidden state on every open. With our own menu
  // there's no fight with Firefox's UA handler.
  function onPopupShowing(): void {
    const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
    const isCompact = vertical ? compact.isCompactVertical() : compact.isCompactHorizontal();
    compactItem.setAttribute("label",
      isCompact ? "Disable Compact" : "Enable Compact");

    (collapseItem as HTMLElement & { hidden: boolean }).hidden = !vertical;
    if (vertical) {
      const expanded = sidebarMain.hasAttribute("sidebar-launcher-expanded");
      collapseItem.setAttribute("label",
        expanded ? "Collapse Layout" : "Expand Layout");
    }

    const sidebarOpen = window.SidebarController?.isOpen
      ?? (!(sidebarMain as HTMLElement & { hidden: boolean }).hidden
          && sidebarMain.getBoundingClientRect().width > 0);
    sidebarItem.setAttribute("label",
      sidebarOpen ? "Disable Sidebar" : "Enable Sidebar");

    layoutItem.setAttribute("label",
      vertical ? "Horizontal Tabs" : "Vertical Tabs");

    // Pin the active surface visible while our menu is open. The popup
    // counter inside compact does this implicitly, but mouseleave +
    // flash callbacks can race with popupshown — explicit pin makes
    // "menu open ⇒ visible" a deterministic invariant.
    if (compact.isCompactVertical()) compact.pinSidebar();
    if (compact.isCompactHorizontal()) compact.pinToolbox();
  }
  pfxMenu.addEventListener("popupshowing", onPopupShowing);

  function onPopupHidden(): void {
    compact.reconcile("pfxMenu:popuphidden");
    compact.reconcileHorizontal("pfxMenu:popuphidden");
  }
  pfxMenu.addEventListener("popuphidden", onPopupHidden);

  function destroy(): void {
    pfxButton.removeEventListener("click", onClick);
    pfxMenu.removeEventListener("popupshowing", onPopupShowing);
    pfxMenu.removeEventListener("popuphidden", onPopupHidden);
    pfxMenu.remove();
    pfxButton.remove();
    sidebarButton!.style.display = "";
  }

  return { destroy };
}
