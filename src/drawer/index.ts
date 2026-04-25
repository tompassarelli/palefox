// Drawer orchestrator — wires up the typed factories that own each
// chrome-restructuring concern, and runs the Ctrl+L floating-urlbar
// keymap. No feature code lives here; if you find yourself adding
// non-wiring logic, peel it into a new factory file.
//
// Owned subsystems (each has its own factory):
//
//   - layout.ts        DOM reparenting (toolbox in/out of sidebar-main),
//                      urlbar width sync, sidebar width pref persistence
//   - drag-overlay.ts  -moz-window-dragging overlay over empty sidebar space
//   - banner.ts        HTTP not-secure warning
//   - compact.ts       autohide state machine for vertical AND horizontal
//   - urlbar.ts        floating urlbar + Ctrl+J/K suggestion nav
//   - sidebar-button.ts  custom #pfx-sidebar-button + context menu
//
// Each factory returns at minimum a `destroy()` method. We aggregate them
// and wire window.unload to call all destroyers.

import { makeBanner, type BannerAPI } from "./banner.ts";
import { makeCompact, type CompactAPI } from "./compact.ts";
import { makeDragOverlay, type DragOverlayAPI } from "./drag-overlay.ts";
import { makeLayout, type LayoutAPI } from "./layout.ts";
import { makeSidebarButton, type SidebarButtonAPI } from "./sidebar-button.ts";
import { makeUrlbar, type UrlbarAPI } from "./urlbar.ts";

declare const window: Window;

function init(): void {
  const sidebarMain = document.getElementById("sidebar-main");
  const navigatorToolbox = document.getElementById("navigator-toolbox");
  const urlbarContainer = document.getElementById("urlbar-container");
  const navBar = document.getElementById("nav-bar");
  const urlbar = document.getElementById("urlbar");

  if (!sidebarMain || !navigatorToolbox || !urlbarContainer || !navBar) {
    console.error("palefox-drawer: missing required elements");
    return;
  }

  const layout: LayoutAPI = makeLayout({
    sidebarMain,
    navigatorToolbox,
    urlbarContainer,
    navBar,
    urlbar,
  });

  const dragOverlay: DragOverlayAPI = makeDragOverlay({ sidebarMain });

  const compact: CompactAPI = makeCompact({
    sidebarMain,
    navigatorToolbox,
    urlbar,
  });

  let urlbarApi: UrlbarAPI | null = null;
  if (urlbar) {
    urlbarApi = makeUrlbar({ urlbar });

    // Ctrl+L on Win/Linux, Cmd+L on macOS. Ctrl+K deliberately NOT bound —
    // too many web apps use it (Slack quick-switcher, etc.) and stealing
    // it on every chrome window is hostile.
    document.addEventListener("keydown", (e) => {
      const accel = e.ctrlKey || e.metaKey;
      if (!accel || e.shiftKey || e.altKey) return;
      if (e.key !== "l" && e.key !== "L") return;
      // Don't preventDefault — let Firefox's <key> element fire normally
      // so gURLBar.select() runs. We just add the floating decoration.
      urlbarApi?.activateFloating("current");
    }, true);
  }

  const sidebarButton: SidebarButtonAPI = makeSidebarButton({
    sidebarMain,
    compact,
  });

  const banner: BannerAPI = makeBanner();

  window.addEventListener("unload", () => {
    layout.destroy();
    dragOverlay.destroy();
    compact.destroy();
    urlbarApi?.destroy();
    sidebarButton.destroy();
    banner.destroy();
  }, { once: true });

  console.log("palefox-drawer: initialized");
}

init();
