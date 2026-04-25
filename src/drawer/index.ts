// @ts-nocheck
// Legacy port from chrome/JS/palefox-drawer.uc.js — keeping ts-nocheck while
// we incrementally add types. The build wraps the file in IIFE; the inner
// init() function exists so the early-return guard below is valid (top-level
// return is illegal in modules).
//
// What this orchestrator owns:
//   - DOM restructuring (expand/collapse: toolbox in/out of sidebar-main)
//   - Urlbar width sync + breakout fallback
//   - Draggable sidebar overlay
//   - Sidebar width pref persistence
//   - Custom #pfx-sidebar-button + #pfx-sidebar-button-menu (left-click toggles
//     compact, right-click opens our menu)
//   - HTTP not-secure banner
//
// Compact mode lives in src/drawer/compact.ts — fully typed factory exposing
// CompactAPI. We call makeCompact() once and route menu/button events through it.

import { makeCompact, type CompactAPI } from "./compact.ts";
import { makeUrlbar, type UrlbarAPI } from "./urlbar.ts";

function init() {
  // --- Element references ---

  const sidebarMain = document.getElementById("sidebar-main");
  const navigatorToolbox = document.getElementById("navigator-toolbox");
  const urlbarContainer = document.getElementById("urlbar-container");
  const navBar = document.getElementById("nav-bar");
  const urlbar = document.getElementById("urlbar");

  if (!sidebarMain || !navigatorToolbox || !urlbarContainer || !navBar) {
    console.error("palefox-drawer: missing required elements");
    return;
  }

  const sidebarMainElement = sidebarMain.querySelector("sidebar-main");

  // Hide the resize splitter inside sidebar-main's shadow DOM.
  // Shadow root may not exist yet — poll briefly until it does.
  function hideSidebarSplitter() {
    const sr = sidebarMainElement?.shadowRoot;
    if (!sr) return setTimeout(hideSidebarSplitter, 100);
    const s = new CSSStyleSheet();
    s.replaceSync(`
      #sidebar-tools-and-extensions-splitter { display: none !important; }
    `);
    sr.adoptedStyleSheets.push(s);
  }
  hideSidebarSplitter();

  // Save original DOM positions before any moves, for collapse restoration.
  const toolboxParent = navigatorToolbox.parentNode;
  const toolboxNext = navigatorToolbox.nextSibling;
  const urlbarParent = urlbarContainer.parentNode;
  const urlbarNext = urlbarContainer.nextSibling;

  // --- Urlbar width sync ---
  // Firefox (UrlbarInput.mjs) periodically sets --urlbar-width on #urlbar.
  // We override it to account for sidebar padding. Only active when the
  // urlbar is inside the sidebar (expanded layout).

  const gap =
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--pfx-gap")
    ) || 6;

  let urlbarToolbar = null;
  let resizeObs = null;
  let mutationObs = null;
  let updating = false;

  function syncUrlbarWidth() {
    if (!urlbar || updating) return;
    if (urlbar.hasAttribute("breakout-extend")) return;
    updating = true;
    const inset = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--pfx-sidebar-inset")
    ) || 10;
    const w = Math.max(0, sidebarMain.getBoundingClientRect().width - inset * 2);
    urlbar.style.setProperty("--urlbar-width", w + "px");
    updating = false;
  }

  // --- Context menu fix ---
  // sidebar-main's LitElement intercepts contextmenu events. Only block
  // propagation when the toolbox is actually inside the sidebar.
  navigatorToolbox.addEventListener("contextmenu", (e) => {
    if (navigatorToolbox.parentNode === sidebarMain) {
      e.stopPropagation();
    }
  });

  // --- Layout: expand (move toolbox into sidebar) ---

  function expand() {
    sidebarMain.insertBefore(navigatorToolbox, sidebarMainElement);

    // The urlbar breakout requires this.closest("toolbar") to return a
    // <toolbar> (UrlbarInput.mjs:487). Wrap it in a new toolbar.
    urlbarToolbar = document.createXULElement("toolbar");
    urlbarToolbar.id = "pfx-urlbar-toolbar";
    urlbarToolbar.classList.add("browser-toolbar");
    urlbarToolbar.appendChild(urlbarContainer);
    navBar.after(urlbarToolbar);

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

  // --- Layout: collapse (restore toolbox to native horizontal position) ---

  function collapse() {
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
    if (mutationObs) {
      mutationObs.disconnect();
      mutationObs = null;
    }

    // Restore urlbar-container to its original position in #nav-bar
    if (urlbarNext && urlbarNext.parentNode === urlbarParent) {
      urlbarParent.insertBefore(urlbarContainer, urlbarNext);
    } else {
      urlbarParent.appendChild(urlbarContainer);
    }

    if (urlbarToolbar) {
      urlbarToolbar.remove();
      urlbarToolbar = null;
    }

    // Ensure correct order: urlbar-container → spring2 → unified-extensions-button
    const spring2 = document.getElementById("customizableui-special-spring2");
    const extBtn = document.getElementById("unified-extensions-button");
    if (spring2) urlbarContainer.after(spring2);
    if (spring2 && extBtn) spring2.after(extBtn);

    // Restore navigator-toolbox to its original position (before #browser)
    if (toolboxNext && toolboxNext.parentNode === toolboxParent) {
      toolboxParent.insertBefore(navigatorToolbox, toolboxNext);
    } else {
      toolboxParent.appendChild(navigatorToolbox);
    }
  }

  // --- Draggable sidebar overlay ---
  // -moz-window-dragging only works on light DOM XUL elements.
  // The empty tab area is inside a shadow root, so we overlay a
  // transparent light DOM box over it and keep its geometry in sync.
  // Pref: pfx.view.draggable-sidebar (default true, Zen-compatible)

  let dragOverlay = null;
  let dragResizeObs = null;
  let dragMutationObs = null;
  const arrowscrollbox = document.getElementById("tabbrowser-arrowscrollbox");

  function updateDragOverlay() {
    if (!dragOverlay || !arrowscrollbox) return;
    const containerRect = sidebarMain.getBoundingClientRect();
    const asbRect = arrowscrollbox.getBoundingClientRect();

    // Find the last visible tab to calculate where empty space starts
    const tabs = arrowscrollbox.querySelectorAll("tab.tabbrowser-tab");
    const lastTab = tabs.length ? tabs[tabs.length - 1] : null;

    let top;
    if (lastTab) {
      const tabRect = lastTab.getBoundingClientRect();
      top = tabRect.bottom;
    } else {
      top = asbRect.top;
    }

    const bottom = asbRect.bottom;
    const height = Math.max(0, bottom - top);

    dragOverlay.style.left = (asbRect.left - containerRect.left) + "px";
    dragOverlay.style.top = (top - containerRect.top) + "px";
    dragOverlay.style.width = asbRect.width + "px";
    dragOverlay.style.height = height + "px";
    dragOverlay.style.display = height > 0 ? "" : "none";
  }

  function draggableEnable() {
    if (dragOverlay) return;
    dragOverlay = document.createXULElement("box");
    dragOverlay.id = "pfx-drag-overlay";
    sidebarMain.appendChild(dragOverlay);
    if (arrowscrollbox) {
      dragResizeObs = new ResizeObserver(updateDragOverlay);
      dragResizeObs.observe(arrowscrollbox);
      dragMutationObs = new MutationObserver(updateDragOverlay);
      dragMutationObs.observe(arrowscrollbox, { childList: true });
    }
    updateDragOverlay();
  }

  function draggableDisable() {
    if (!dragOverlay) return;
    dragResizeObs?.disconnect();
    dragMutationObs?.disconnect();
    dragResizeObs = null;
    dragMutationObs = null;
    dragOverlay.remove();
    dragOverlay = null;
  }

  const DRAGGABLE_PREF = "pfx.view.draggable-sidebar";

  if (Services.prefs.getBoolPref(DRAGGABLE_PREF, true)) {
    draggableEnable();
  }

  const draggableObserver = {
    observe() {
      if (Services.prefs.getBoolPref(DRAGGABLE_PREF, true)) {
        draggableEnable();
      } else {
        draggableDisable();
      }
    },
  };
  Services.prefs.addObserver(DRAGGABLE_PREF, draggableObserver);

  // --- Sidebar width preference ---

  const WIDTH_PREF = "pfx.sidebar.width";
  const defaultWidth = Services.prefs.getIntPref(WIDTH_PREF, 300);

  // Apply saved width on startup
  if (sidebarMain.hasAttribute("sidebar-launcher-expanded")) {
    sidebarMain.style.width = defaultWidth + "px";
  }

  // Save width when the user resizes the sidebar
  new ResizeObserver(() => {
    if (!sidebarMain.hasAttribute("sidebar-launcher-expanded")) return;
    const w = Math.round(sidebarMain.getBoundingClientRect().width);
    if (w > 0) Services.prefs.setIntPref(WIDTH_PREF, w);
  }).observe(sidebarMain);

  // --- Initialize layout based on current sidebar state ---

  if (sidebarMain.hasAttribute("sidebar-launcher-expanded")) {
    expand();
  }

  // Watch for expand/collapse attribute changes
  new MutationObserver(() => {
    const expanded = sidebarMain.hasAttribute("sidebar-launcher-expanded");
    if (expanded && !urlbarToolbar) {
      expand();
    } else if (!expanded && urlbarToolbar) {
      collapse();
    }
  }).observe(sidebarMain, {
    attributes: true,
    attributeFilter: ["sidebar-launcher-expanded"],
  });

  // === Compact mode (typed factory in ./compact.ts) ===

  const compact: CompactAPI = makeCompact({
    sidebarMain,
    navigatorToolbox,
    urlbar,
  });

  // === Floating urlbar (typed factory in ./urlbar.ts) ===
  // Adds a [pfx-urlbar-floating] decoration on :root when activated by
  // Ctrl+L / Ctrl+K (capture phase, no preventDefault — Firefox still
  // does its own focus dance) or by `o` / `O` palefox keys via the
  // pfx-urlbar-activate CustomEvent. Mouse-click on in-sidebar urlbar
  // keeps native breakout-extend at click point.

  let urlbarApi: UrlbarAPI | null = null;
  if (urlbar) {
    urlbarApi = makeUrlbar({ urlbar });

    document.addEventListener("keydown", (e) => {
      // Ctrl+L on Win/Linux, Cmd+L on macOS. Ctrl+K deliberately NOT bound —
      // too many web apps use it (Slack quick-switcher, etc.) and stealing
      // it on every chrome window is hostile.
      const accel = e.ctrlKey || e.metaKey;
      if (!accel || e.shiftKey || e.altKey) return;
      if (e.key !== "l" && e.key !== "L") return;
      // Don't preventDefault — let Firefox's <key> element fire normally
      // so gURLBar.select() runs. We just add the decoration.
      urlbarApi?.activateFloating("current");
    }, true);
  }

  window.addEventListener("unload", () => {
    Services.prefs.removeObserver(DRAGGABLE_PREF, draggableObserver);
    compact.destroy();
    urlbarApi?.destroy();
  }, { once: true });

  // === Sidebar Button ===
  // Hide the native button, create our own. Avoids fighting XUL command
  // wiring. Left-click: toggle compact mode (dispatches per layout).
  // Right-click: our own custom #pfx-sidebar-button-menu (wired below).

  const sidebarButton = document.getElementById("sidebar-button");
  if (sidebarButton) {
    // Grab the icon style before hiding
    const ogIcon = sidebarButton.querySelector(".toolbarbutton-icon");
    const ogIconStyle = ogIcon ? getComputedStyle(ogIcon).listStyleImage : null;

    sidebarButton.style.display = "none";

    const pfxButton = document.createXULElement("toolbarbutton");
    pfxButton.id = "pfx-sidebar-button";
    pfxButton.className = sidebarButton.className;
    pfxButton.setAttribute(
      "tooltiptext",
      "Toggle compact mode (right-click for more)"
    );
    // Copy CUI attributes so Firefox's popupshowing logic recognizes
    // our button as a real toolbar widget
    for (const attr of [
      "cui-areatype",
      "widget-id",
      "widget-type",
      "removable",
      "overflows",
    ]) {
      if (sidebarButton.hasAttribute(attr)) {
        pfxButton.setAttribute(attr, sidebarButton.getAttribute(attr));
      }
    }
    if (ogIconStyle) {
      pfxButton.style.listStyleImage = ogIconStyle;
    }
    sidebarButton.after(pfxButton);

    pfxButton.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      compact.toggle();
    });

    // Custom context menu — owned by us, not overloaded onto Firefox's
    // toolbar-context-menu. The previous overloading approach fought
    // Firefox's UA popupshowing handler over which items were visible,
    // which caused the menu to morph between paints (clicks landed on
    // the wrong items). We own this menupopup completely.
    const pfxMenu = document.createXULElement("menupopup");
    pfxMenu.id = "pfx-sidebar-button-menu";

    function mi(id, label, onCommand) {
      const item = document.createXULElement("menuitem");
      item.id = id;
      item.setAttribute("label", label);
      item.addEventListener("command", onCommand);
      return item;
    }

    const compactItem = mi("pfx-toggle-compact", "Enable Compact",
      () => compact.toggle());

    // Vertical mode only — toggles sidebar-launcher-expanded by clicking
    // the (display:none'd) native button while it's briefly un-hidden.
    const collapseItem = mi("pfx-collapse-layout", "Collapse Layout", () => {
      try {
        const prevDisplay = sidebarButton.style.display;
        sidebarButton.style.display = "";
        sidebarButton.click();
        sidebarButton.style.display = prevDisplay;
      } catch (e) {
        console.error("[PFX:drawer] collapse layout failed", e);
      }
    });

    // Both modes — toggles the bookmarks/history sidebar widget.
    const sidebarItem = mi("pfx-toggle-sidebar", "Enable Sidebar", () => {
      try {
        const win = window;
        if (win.SidebarController?.toggle) { win.SidebarController.toggle(); return; }
        if (win.SidebarUI?.toggle) { win.SidebarUI.toggle(); return; }
        const cmd = document.getElementById("cmd_toggleSidebar");
        if (cmd?.doCommand) { cmd.doCommand(); return; }
        console.error("[PFX:drawer] no sidebar-toggle API available");
      } catch (e) { console.error("[PFX:drawer] sidebar toggle failed", e); }
    });

    const layoutItem = mi("pfx-toggle-tab-layout", "Horizontal Tabs", () => {
      const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
      Services.prefs.setBoolPref("sidebar.verticalTabs", !vertical);
    });

    // Customize Sidebar passthrough — invokes Firefox's command directly
    // so users still have access to the upstream UI.
    const customizeItem = mi("pfx-customize-sidebar", "Customize Sidebar", () => {
      try {
        const native = document.getElementById("toolbar-context-customize-sidebar");
        native?.doCommand?.() ?? native?.click?.();
      } catch (e) { console.error("palefox: customize sidebar failed", e); }
    });

    pfxMenu.append(
      compactItem,
      collapseItem,
      sidebarItem,
      layoutItem,
      document.createXULElement("menuseparator"),
      customizeItem,
    );

    // Append to mainPopupSet so it's at the document root (rendered in
    // the top layer like all chrome popups).
    const popupSet = document.getElementById("mainPopupSet");
    popupSet?.appendChild(pfxMenu);

    // Wire the button to our menu. Firefox's context-menu plumbing reads
    // the `context` attribute and opens the named popup on right-click.
    pfxButton.setAttribute("context", "pfx-sidebar-button-menu");

    // Update labels / hidden state on every open. With our own menu there's
    // no fight with Firefox's UA handler — popupshowing fires, we update,
    // menu paints with the right labels, click hits the right item.
    pfxMenu.addEventListener("popupshowing", () => {
      const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
      const isCompact = vertical ? compact.isCompactVertical() : compact.isCompactHorizontal();
      compactItem.setAttribute("label",
        isCompact ? "Disable Compact" : "Enable Compact");

      collapseItem.hidden = !vertical;
      if (vertical) {
        const expanded = sidebarMain.hasAttribute("sidebar-launcher-expanded");
        collapseItem.setAttribute("label",
          expanded ? "Collapse Layout" : "Expand Layout");
      }

      const sidebarOpen = window.SidebarController?.isOpen
        ?? (!sidebarMain.hidden
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
    });

    pfxMenu.addEventListener("popuphidden", () => {
      // Reconcile the active surface so it can hide if the cursor isn't
      // on it and no other guard is active.
      compact.reconcile("pfxMenu:popuphidden");
      compact.reconcileHorizontal("pfxMenu:popuphidden");
    });
  }

  // === HTTP Not-Secure Warning ===
  // Shows a banner after 2s on insecure pages. Hides immediately
  // when the page becomes secure (e.g. redirect to HTTPS).

  const identityBox = document.getElementById("identity-box");
  let insecureTimer = null;
  let insecureBanner = null;

  function showInsecureBanner() {
    if (insecureBanner) return;
    insecureBanner = document.createXULElement("hbox");
    insecureBanner.id = "pfx-insecure-banner";
    insecureBanner.setAttribute("align", "center");
    insecureBanner.setAttribute("pack", "center");
    insecureBanner.textContent = "\uD83E\uDD8A Palefox - HTTP Alert: Not Secure";
    const browser = document.getElementById("browser");
    browser.parentNode.insertBefore(insecureBanner, browser);
  }

  function hideInsecureBanner() {
    clearTimeout(insecureTimer);
    insecureTimer = null;
    if (insecureBanner) {
      insecureBanner.remove();
      insecureBanner = null;
    }
  }

  function checkInsecure() {
    const uri = gBrowser.selectedBrowser?.currentURI?.spec || "";
    const isInternal = uri.startsWith("about:") || uri.startsWith("chrome:");
    const isCustomizing = document.documentElement.hasAttribute("customizing");
    const isInsecure = identityBox?.classList.contains("notSecure")
      && !isInternal && !isCustomizing;
    if (isInsecure && !insecureTimer && !insecureBanner) {
      insecureTimer = setTimeout(showInsecureBanner, 2000);
    } else if (!isInsecure) {
      hideInsecureBanner();
    }
  }

  if (identityBox) {
    new MutationObserver(checkInsecure).observe(identityBox, {
      attributes: true,
      attributeFilter: ["class"],
    });
    // Also check on tab switch
    gBrowser.tabContainer.addEventListener("TabSelect", checkInsecure);
  }

  console.log("palefox-drawer: initialized");
}

init();
