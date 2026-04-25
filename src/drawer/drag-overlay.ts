// Draggable sidebar overlay.
//
// `-moz-window-dragging: drag` only works on light DOM XUL elements. The
// empty tab area is inside a shadow root, so we overlay a transparent
// light-DOM box over the empty space and keep its geometry in sync via
// ResizeObserver + MutationObserver on tabbrowser-arrowscrollbox.
//
// Pref-driven on/off (`pfx.view.draggable-sidebar`, default true).

import { createLogger } from "../tabs/log.ts";

declare const Services: {
  prefs: {
    getBoolPref(name: string, def: boolean): boolean;
    addObserver(name: string, observer: { observe: (s: unknown, t: string, d: string) => void }): void;
    removeObserver(name: string, observer: { observe: (s: unknown, t: string, d: string) => void }): void;
  };
};

// =============================================================================
// INTERFACE
// =============================================================================

export type DragOverlayDeps = {
  readonly sidebarMain: HTMLElement;
};

export type DragOverlayAPI = {
  destroy(): void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

const PREF = "pfx.view.draggable-sidebar";

export function makeDragOverlay(deps: DragOverlayDeps): DragOverlayAPI {
  const log = createLogger("drawer/drag-overlay");
  const { sidebarMain } = deps;
  const arrowscrollbox = document.getElementById("tabbrowser-arrowscrollbox");

  let overlay: HTMLElement | null = null;
  let resizeObs: ResizeObserver | null = null;
  let mutationObs: MutationObserver | null = null;

  function update(): void {
    if (!overlay || !arrowscrollbox) return;
    const containerRect = sidebarMain.getBoundingClientRect();
    const asbRect = arrowscrollbox.getBoundingClientRect();

    const tabs = arrowscrollbox.querySelectorAll("tab.tabbrowser-tab");
    const lastTab = tabs.length ? tabs[tabs.length - 1] : null;

    let top: number;
    if (lastTab) {
      top = (lastTab as HTMLElement).getBoundingClientRect().bottom;
    } else {
      top = asbRect.top;
    }

    const bottom = asbRect.bottom;
    const height = Math.max(0, bottom - top);

    overlay.style.left = (asbRect.left - containerRect.left) + "px";
    overlay.style.top = (top - containerRect.top) + "px";
    overlay.style.width = asbRect.width + "px";
    overlay.style.height = height + "px";
    overlay.style.display = height > 0 ? "" : "none";
  }

  function enable(): void {
    if (overlay) return;
    const el = (document as Document & { createXULElement(t: string): HTMLElement }).createXULElement("box");
    el.id = "pfx-drag-overlay";
    sidebarMain.appendChild(el);
    overlay = el;
    if (arrowscrollbox) {
      resizeObs = new ResizeObserver(update);
      resizeObs.observe(arrowscrollbox);
      mutationObs = new MutationObserver(update);
      mutationObs.observe(arrowscrollbox, { childList: true });
    }
    update();
    log("enable");
  }

  function disable(): void {
    if (!overlay) return;
    resizeObs?.disconnect();
    mutationObs?.disconnect();
    resizeObs = null;
    mutationObs = null;
    overlay.remove();
    overlay = null;
    log("disable");
  }

  // Initial state from pref.
  if (Services.prefs.getBoolPref(PREF, true)) enable();

  const observer = {
    observe(): void {
      if (Services.prefs.getBoolPref(PREF, true)) enable();
      else disable();
    },
  };
  Services.prefs.addObserver(PREF, observer);

  function destroy(): void {
    try { Services.prefs.removeObserver(PREF, observer); } catch {}
    disable();
  }

  return { destroy };
}
