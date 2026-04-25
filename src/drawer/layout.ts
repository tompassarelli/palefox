// Drawer layout — toolbox/urlbar reparenting + width sync + width pref.
//
// Three coupled concerns:
//
// 1. **Expand/collapse**: in vertical-expanded mode, palefox moves
//    #navigator-toolbox into #sidebar-main and wraps #urlbar-container in
//    a fresh `<toolbar id="pfx-urlbar-toolbar">` so Firefox's urlbar
//    breakout-extend logic (which calls `closest("toolbar")`) still works.
//    Collapse undoes both moves.
//
// 2. **Width sync**: while expanded, Firefox's UrlbarInput periodically
//    sets `--urlbar-width` on #urlbar to its own measurement of the
//    surrounding toolbar. We override it with a sidebar-aware value so
//    the urlbar fits the sidebar's actual interior width minus inset.
//    Suspended during breakout-extend (UrlbarInput owns sizing then).
//
// 3. **Width pref**: `pfx.sidebar.width` persists the user's chosen
//    sidebar width. Applied on startup if currently expanded; written
//    via ResizeObserver on every settle.
//
// These are interleaved because the width-sync observers need to be set
// up inside expand() (when the toolbar wrapper exists) and torn down
// inside collapse(). Splitting them would mean threading observer state
// across files — not worth it.

import { createLogger } from "../tabs/log.ts";

declare const Services: {
  prefs: {
    getIntPref(name: string, def: number): number;
    setIntPref(name: string, value: number): void;
  };
};

// =============================================================================
// INTERFACE
// =============================================================================

export type LayoutDeps = {
  readonly sidebarMain: HTMLElement;
  readonly navigatorToolbox: HTMLElement;
  readonly urlbarContainer: HTMLElement;
  readonly navBar: HTMLElement;
  readonly urlbar: HTMLElement | null;
};

export type LayoutAPI = {
  /** True iff palefox has the toolbox parented inside the sidebar. */
  isExpanded(): boolean;
  /** Tear down all observers + listeners (collapse stays in place — the
   *  user's session wants whatever layout was active). */
  destroy(): void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

const WIDTH_PREF = "pfx.sidebar.width";

export function makeLayout(deps: LayoutDeps): LayoutAPI {
  const log = createLogger("drawer/layout");
  const { sidebarMain, navigatorToolbox, urlbarContainer, navBar, urlbar } = deps;
  const sidebarMainElement = sidebarMain.querySelector("sidebar-main");

  // Save original DOM positions before any moves, for collapse restoration.
  const toolboxParent = navigatorToolbox.parentNode;
  const toolboxNext = navigatorToolbox.nextSibling;
  const urlbarParent = urlbarContainer.parentNode;
  const urlbarNext = urlbarContainer.nextSibling;

  let urlbarToolbar: HTMLElement | null = null;
  let resizeObs: ResizeObserver | null = null;
  let mutationObs: MutationObserver | null = null;
  let updating = false;

  // Hide the resize splitter inside sidebar-main's shadow DOM.
  // Shadow root may not exist yet — poll briefly until it does.
  function hideSidebarSplitter(): void {
    const sr = (sidebarMainElement as { shadowRoot?: ShadowRoot } | null)?.shadowRoot;
    if (!sr) {
      setTimeout(hideSidebarSplitter, 100);
      return;
    }
    const s = new CSSStyleSheet();
    s.replaceSync(`
      #sidebar-tools-and-extensions-splitter { display: none !important; }
    `);
    (sr as ShadowRoot & { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets.push(s);
  }

  function syncUrlbarWidth(): void {
    if (!urlbar || updating) return;
    if (urlbar.hasAttribute("breakout-extend")) return;
    updating = true;
    const inset = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--pfx-sidebar-inset"),
    ) || 10;
    const w = Math.max(0, sidebarMain.getBoundingClientRect().width - inset * 2);
    urlbar.style.setProperty("--urlbar-width", w + "px");
    updating = false;
  }

  function expand(): void {
    if (urlbarToolbar) return;
    log("expand");
    if (sidebarMainElement) sidebarMain.insertBefore(navigatorToolbox, sidebarMainElement);

    // The urlbar breakout requires this.closest("toolbar") to return a
    // <toolbar> (UrlbarInput.mjs:487). Wrap it in a new toolbar.
    const tb = (document as Document & { createXULElement(t: string): HTMLElement }).createXULElement("toolbar");
    tb.id = "pfx-urlbar-toolbar";
    tb.classList.add("browser-toolbar");
    tb.appendChild(urlbarContainer);
    navBar.after(tb);
    urlbarToolbar = tb;

    if (urlbar) {
      resizeObs = new ResizeObserver(syncUrlbarWidth);
      resizeObs.observe(sidebarMain);
      mutationObs = new MutationObserver(syncUrlbarWidth);
      mutationObs.observe(urlbar, {
        attributes: true,
        attributeFilter: ["style"],
      });
    }
  }

  function collapse(): void {
    if (!urlbarToolbar) return;
    log("collapse");
    resizeObs?.disconnect();
    mutationObs?.disconnect();
    resizeObs = null;
    mutationObs = null;

    if (urlbarNext && urlbarNext.parentNode === urlbarParent) {
      urlbarParent!.insertBefore(urlbarContainer, urlbarNext);
    } else {
      urlbarParent!.appendChild(urlbarContainer);
    }

    urlbarToolbar.remove();
    urlbarToolbar = null;

    // Ensure correct order: urlbar-container → spring2 → unified-extensions-button
    const spring2 = document.getElementById("customizableui-special-spring2");
    const extBtn = document.getElementById("unified-extensions-button");
    if (spring2) urlbarContainer.after(spring2);
    if (spring2 && extBtn) spring2.after(extBtn);

    if (toolboxNext && toolboxNext.parentNode === toolboxParent) {
      toolboxParent!.insertBefore(navigatorToolbox, toolboxNext);
    } else {
      toolboxParent!.appendChild(navigatorToolbox);
    }
  }

  // Context-menu fix — sidebar-main's LitElement intercepts contextmenu
  // events. Only block propagation when the toolbox is actually inside
  // the sidebar.
  function onContextMenu(e: Event): void {
    if (navigatorToolbox.parentNode === sidebarMain) {
      e.stopPropagation();
    }
  }
  navigatorToolbox.addEventListener("contextmenu", onContextMenu);

  // Initial layout state.
  hideSidebarSplitter();
  if (sidebarMain.hasAttribute("sidebar-launcher-expanded")) expand();

  // Watch for expand/collapse attribute changes.
  const expandObserver = new MutationObserver(() => {
    const expanded = sidebarMain.hasAttribute("sidebar-launcher-expanded");
    if (expanded && !urlbarToolbar) expand();
    else if (!expanded && urlbarToolbar) collapse();
  });
  expandObserver.observe(sidebarMain, {
    attributes: true,
    attributeFilter: ["sidebar-launcher-expanded"],
  });

  // --- Width pref ---
  const defaultWidth = Services.prefs.getIntPref(WIDTH_PREF, 300);
  if (sidebarMain.hasAttribute("sidebar-launcher-expanded")) {
    sidebarMain.style.width = defaultWidth + "px";
  }

  const widthObs = new ResizeObserver(() => {
    if (!sidebarMain.hasAttribute("sidebar-launcher-expanded")) return;
    const w = Math.round(sidebarMain.getBoundingClientRect().width);
    if (w > 0) {
      try { Services.prefs.setIntPref(WIDTH_PREF, w); } catch {}
    }
  });
  widthObs.observe(sidebarMain);

  function destroy(): void {
    expandObserver.disconnect();
    widthObs.disconnect();
    resizeObs?.disconnect();
    mutationObs?.disconnect();
    navigatorToolbox.removeEventListener("contextmenu", onContextMenu);
  }

  return {
    isExpanded: () => urlbarToolbar !== null,
    destroy,
  };
}
