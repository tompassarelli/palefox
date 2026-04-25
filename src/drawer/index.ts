// @ts-nocheck
// Legacy port from chrome/JS/palefox-drawer.uc.js — keeping ts-nocheck while
// we incrementally add types. The build wraps the file in IIFE; the inner
// init() function exists so the early-return guard below is valid (top-level
// return is illegal in modules).

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

  // === Compact Mode ===
  //
  // Ported from Zen Browser's ZenCompactMode.mjs, adapted for non-fork.
  //
  // STATE MODEL (inverted from naive show/hide):
  //   data-pfx-compact present → sidebar hidden by CSS default
  //   pfx-has-hover present    → sidebar visible (overrides hidden)
  //   No pfx-has-hover         → sidebar hidden
  //
  // This eliminates race conditions: enabling compact mode just sets
  // data-pfx-compact. The sidebar is immediately hidden because
  // pfx-has-hover is absent. Nothing can "undo" a hide — showing
  // requires explicitly ADDING pfx-has-hover.
  //
  // FLOW:
  //   hover strip mouseenter → setHover(true) → sidebar slides in
  //   sidebar mouseover      → setHover(true) + cancel any pending hide
  //   sidebar mouseleave     → flash(300ms) → setHover(false) → slides out
  //
  // ZEN FEATURES WE SKIP (fork-specific, not applicable):
  //   - zen-user-show: manual sidebar pin (we don't have this UX)
  //   - zen-has-empty-tab: auto-show on new tab
  //   - zen-compact-animating: animation spam guard
  //   - floating urlbar handling (_hasHoveredUrlbar)
  //   - macOS window button bounds checks
  //   - supress-primary-adjustment: Zen layout engine flag
  //   - screen edge detection (_getCrossedEdge): we use hover strip instead
  //   - _isTabBeingDragged flag: we use querySelector in isGuarded() instead

  const COMPACT_PREF = "pfx.sidebar.compact";
  const DEBUG_PREF   = "pfx.debug";

  // How long the sidebar lingers after mouseleave before hiding.
  // Zen uses a pref (zen.view.compact.sidebar-keep-hover.duration).
  // We hardcode 300ms — fast enough to feel responsive, long enough
  // to not flicker when the mouse briefly crosses the sidebar edge.
  const KEEP_HOVER_DURATION = 300;

  function dbg(event, data = {}) {
    if (!Services.prefs.getBoolPref(DEBUG_PREF, false)) return;
    console.log("[PFX:drawer]", event, {
      compact:      sidebarMain.hasAttribute("data-pfx-compact"),
      hover:        sidebarMain.hasAttribute("pfx-has-hover"),
      openPopups:   _openPopups,
      flashPending: flashTimer !== null,
      guarded:      isGuarded(),
      ...data,
    });
  }

  let hoverStrip = null;
  let flashTimer = null;
  let urlbarCompactObserver = null;

  // Blocks hover-triggered show during and immediately after compactToggle().
  // Held until the sidebar's CSS transform transition completes (~250ms).
  // Zen equivalent: _ignoreNextHover (ZenCompactMode.mjs:623)
  let _ignoreNextHover = false;

  // Other scripts can dismiss the sidebar by dispatching "pfx-dismiss"
  sidebarMain.addEventListener("pfx-dismiss", () => {
    _ignoreNextHover = true;
    setHover(false);
    clearFlash();
    setTimeout(() => { _ignoreNextHover = false; }, KEEP_HOVER_DURATION + 100);
  });

  // Guards: conditions that should prevent the sidebar from hiding.
  // Popup counter mirrors Firefox's browser-sidebar.js _hoverBlockerCount.
  // Uses composedPath()[0] to pierce shadow DOM. Excludes tooltips (fire
  // constantly) and tab-preview-panel (fires mismatched events).
  let _openPopups = 0;
  function _isIgnoredPopup(e) {
    const el = e.composedPath?.()[0] ?? e.target;
    return el.localName === "tooltip" || el.id === "tab-preview-panel";
  }
  document.addEventListener("popupshown", (e) => {
    if (_isIgnoredPopup(e)) return;
    _openPopups++;
    dbg("popupshown", { id: e.target.id, tag: e.target.localName, _openPopups });
  });
  document.addEventListener("popuphidden", (e) => {
    if (_isIgnoredPopup(e)) return;
    _openPopups = Math.max(0, _openPopups - 1);
    dbg("popuphidden", { id: e.target.id, tag: e.target.localName, _openPopups });
  });

  function isGuarded() {
    if (_openPopups > 0) return true;
    if (urlbar?.hasAttribute("breakout-extend")) return true;
    if (document.querySelector("toolbarbutton[open='true']")) return true;
    if (document.querySelector(".tabbrowser-tab[multiselected]")) return true;
    if (document.querySelector("[pfx-dragging]")) return true;
    return false;
  }

  // Set/remove the visibility attribute. CSS reacts to this:
  //   [data-pfx-compact]:not([pfx-has-hover]) → hidden
  //   [data-pfx-compact][pfx-has-hover]       → visible
  // Zen equivalent: _setElementExpandAttribute (ZenCompactMode.mjs:693)
  // Zen's version is generic (any element, any attribute, handles
  // implicit hover, toolbar panel state). Ours is trivial because
  // we have one sidebar and one attribute.
  function setHover(value) {
    dbg("setHover", { value });
    if (value && _ignoreNextHover) {
      // Zen pattern (animateCompactMode:455): actively force-hide when
      // _ignoreNextHover is set, rather than just early-returning from callers.
      // Defensive catch for any show path that bypasses per-caller guards.
      sidebarMain.removeAttribute("pfx-has-hover");
      return;
    }
    if (value) {
      sidebarMain.setAttribute("pfx-has-hover", "true");
    } else {
      sidebarMain.removeAttribute("pfx-has-hover");
    }
  }

  // Keep sidebar visible for `duration` ms, then hide.
  // If called again while already flashing, resets the timer without
  // re-triggering the show (avoids visual glitch from redundant show).
  // Zen equivalent: flashElement (ZenCompactMode.mjs:672)
  // Zen's version is generic (any element, any attribute, keyed by ID).
  // Ours is hardcoded to the sidebar since it's our only flashable element.
  function flashSidebar(duration) {
    if (flashTimer) {
      clearTimeout(flashTimer);
      dbg("flashSidebar:extend", { duration });
    } else {
      dbg("flashSidebar:show", { duration });
      requestAnimationFrame(() => setHover(true));
    }
    flashTimer = setTimeout(() => {
      requestAnimationFrame(() => {
        if (isGuarded()) {
          dbg("flashSidebar:hide-blocked");
        } else {
          setHover(false);
        }
        flashTimer = null;
      });
    }, duration);
  }

  function clearFlash() {
    clearTimeout(flashTimer);
    flashTimer = null;
  }

  // Mouse enters sidebar. Verify hover is real, then show.
  // Zen equivalent: onEnter (ZenCompactMode.mjs:762)
  //
  // setTimeout(0): Zen calls this HOVER_HACK_DELAY (default 0ms).
  // Defers to next tick so we can verify :hover — on Linux/Wayland,
  // spurious mouseover events fire during tab drags (Mozilla bug 1818517).
  // The :hover check catches these false positives.
  //
  // event.target.closest("panel"): Zen check — ignore mouseover from
  // popup panels (context menus, dropdowns) that overlap the sidebar.
  //
  // requestAnimationFrame: Zen batches all DOM writes to rAF to avoid
  // layout thrashing. We follow the same pattern.
  function onSidebarEnter(event) {
    setTimeout(() => {
      if (!event.target.matches(":hover")) return;
      if (event.target.closest("panel")) return;
      clearFlash();
      requestAnimationFrame(() => {
        if (_ignoreNextHover) return;
        if (sidebarMain.hasAttribute("pfx-has-hover")) return;
        setHover(true);
      });
    }, 0);
  }

  // Mouse leaves sidebar. Verify leave is real, then schedule hide.
  // Zen equivalent: onLeave (ZenCompactMode.mjs:788)
  //
  // setTimeout(0) + :hover check: same false-positive guard as onEnter.
  //
  // flashSidebar instead of immediate hide: the sidebar lingers for
  // KEEP_HOVER_DURATION ms. If the mouse re-enters during this window,
  // onSidebarEnter calls clearFlash() and the hide is cancelled.
  // This prevents flicker when the mouse briefly crosses the edge.
  //
  // Zen skips: macOS window button bounds check, floating urlbar check,
  // supress-primary-adjustment, dragleave handling. All fork-specific.
  function onSidebarLeave(event) {
    setTimeout(() => {
      if (event.target.matches(":hover")) return;
      if (_ignoreNextHover) return;
      if (isGuarded()) return;
      flashSidebar(KEEP_HOVER_DURATION);
    }, 0);
  }

  function compactEnable() {
    dbg("compactEnable");
    // Setting this attribute without pfx-has-hover causes CSS to
    // immediately hide the sidebar. No race condition possible.
    sidebarMain.setAttribute("data-pfx-compact", "");

    // The urlbar has popover="manual" which places it in the CSS top layer.
    // Top layer elements are immune to ancestor transforms. Remove popover
    // so the urlbar moves with the sidebar's transform. We restore it
    // dynamically during breakout so the dropdown renders above everything.
    if (urlbar && !urlbarCompactObserver) {
      urlbar.removeAttribute("popover");
      urlbarCompactObserver = new MutationObserver(() => {
        if (!sidebarMain.hasAttribute("data-pfx-compact")) return;
        if (urlbar.hasAttribute("breakout-extend")) {
          dbg("urlbar:breakout-open");
          urlbar.setAttribute("popover", "manual");
          if (!urlbar.matches(":popover-open")) urlbar.showPopover();
        } else {
          dbg("urlbar:breakout-close");
          urlbar.removeAttribute("popover");
          // Breakout closed — if mouse isn't over the sidebar, hide it.
          // Fixes: click urlbar → click away → sidebar stays stuck visible
          // (the earlier mouseleave was blocked by the breakout guard).
          if (!sidebarMain.matches(":hover")) {
            flashSidebar(KEEP_HOVER_DURATION);
          }
        }
      });
      urlbarCompactObserver.observe(urlbar, { attributes: true, attributeFilter: ["breakout-extend"] });
    }

    // Hover strip: invisible box at left edge, sits behind the sidebar
    // (z-index 9 < sidebar's 10). When sidebar has pointer-events:none
    // (hidden state), mouse events pass through to the strip.
    // Zen uses screen edge detection instead (mouseleave on documentElement,
    // _getCrossedEdge). Our approach is simpler — a physical DOM element.
    if (!hoverStrip) {
      hoverStrip = document.createXULElement("box");
      hoverStrip.id = "pfx-hover-strip";
      sidebarMain.parentNode.appendChild(hoverStrip);
      hoverStrip.addEventListener("mouseenter", () => {
        // Synchronous guard — checked before queuing rAF, because rAF fires
        // after setTimeout(0), by which point _ignoreNextHover may be reset.
        if (_ignoreNextHover) return;
        clearFlash();
        requestAnimationFrame(() => {
          if (!_ignoreNextHover) setHover(true);
        });
      });
    }

    sidebarMain.addEventListener("mouseover", onSidebarEnter);
    sidebarMain.addEventListener("mouseleave", onSidebarLeave);
  }

  function compactDisable() {
    dbg("compactDisable");
    clearFlash();
    sidebarMain.removeAttribute("data-pfx-compact");
    sidebarMain.removeAttribute("pfx-has-hover");

    // Disconnect the urlbar breakout observer — must happen before
    // restoring popover so it doesn't fire on the attribute change below.
    urlbarCompactObserver?.disconnect();
    urlbarCompactObserver = null;

    // Restore popover so the urlbar returns to the top layer
    if (urlbar) {
      urlbar.setAttribute("popover", "manual");
      if (!urlbar.matches(":popover-open")) urlbar.showPopover();
    }

    if (hoverStrip) {
      hoverStrip.remove();
      hoverStrip = null;
    }

    sidebarMain.removeEventListener("mouseover", onSidebarEnter);
    sidebarMain.removeEventListener("mouseleave", onSidebarLeave);
  }

  function compactToggle() {
    const active = sidebarMain.hasAttribute("data-pfx-compact");
    dbg("compactToggle", { wasActive: active });
    if (active) {
      compactDisable();
      Services.prefs.setBoolPref(COMPACT_PREF, false);
    } else {
      _ignoreNextHover = true;
      compactEnable();
      Services.prefs.setBoolPref(COMPACT_PREF, true);
      // Clear after the CSS hide transition completes (transform, 250ms).
      //
      // Cannot use mouseleave: adding data-pfx-compact applies pointer-events:none
      // immediately (not after the animation), firing a synthetic mouseleave on the
      // sidebar. That clears _ignoreNextHover before the hover strip's mouseenter
      // guard fires, letting the sidebar immediately re-open.
      //
      // Zen clears _ignoreNextHover inside animateCompactMode().then() — after the
      // animation promise resolves. Our equivalent: transitionend on "transform".
      const clearIgnore = () => { _ignoreNextHover = false; };
      const safetyTimer = setTimeout(clearIgnore, 400);
      sidebarMain.addEventListener("transitionend", function onTransitionEnd(e) {
        if (e.target !== sidebarMain || e.propertyName !== "transform") return;
        sidebarMain.removeEventListener("transitionend", onTransitionEnd);
        clearTimeout(safetyTimer);
        clearIgnore();
      });
    }
  }

  // Initialize from pref on startup
  if (Services.prefs.getBoolPref(COMPACT_PREF, false)) {
    compactEnable();
  }

  // Live-toggle via about:config without restart
  const compactObserver = {
    observe() {
      const enabled = Services.prefs.getBoolPref(COMPACT_PREF, false);
      const active = sidebarMain.hasAttribute("data-pfx-compact");
      if (enabled && !active) compactEnable();
      else if (!enabled && active) compactDisable();
    },
  };
  Services.prefs.addObserver(COMPACT_PREF, compactObserver);

  // Remove pref observers when this window closes so they don't fire
  // against dead DOM nodes after the window is gone.
  window.addEventListener("unload", () => {
    Services.prefs.removeObserver(DRAGGABLE_PREF, draggableObserver);
    Services.prefs.removeObserver(COMPACT_PREF, compactObserver);
  }, { once: true });

  // Clear stale hover when window minimizes/maximizes/restores.
  // The mouse may no longer be over the sidebar after the state change.
  // Zen equivalent: sizemodechange listener (ZenCompactMode.mjs:93)
  window.addEventListener("sizemodechange", () => {
    if (
      sidebarMain.hasAttribute("pfx-has-hover") &&
      !sidebarMain.matches(":hover")
    ) {
      setHover(false);
      clearFlash();
    }
  });

  // === Sidebar Button ===
  // Left-click: toggle compact mode
  // Right-click: context menu with "Collapse Layout"

  // === Sidebar Button ===
  // Hide the native button, create our own. Avoids fighting XUL command
  // wiring. Our button uses the native #toolbar-context-menu (overloaded
  // with our items) so the user gets the full original menu plus ours.

  const sidebarButton = document.getElementById("sidebar-button");
  if (sidebarButton) {
    // Grab the icon style before hiding
    const ogIcon = sidebarButton.querySelector(".toolbarbutton-icon");
    const ogIconStyle = ogIcon ? getComputedStyle(ogIcon).listStyleImage : null;

    sidebarButton.style.display = "none";

    const pfxButton = document.createXULElement("toolbarbutton");
    pfxButton.id = "pfx-sidebar-button";
    pfxButton.className = sidebarButton.className;
    pfxButton.setAttribute("tooltiptext", "Toggle compact mode (right-click for more)");
    pfxButton.setAttribute("context", "toolbar-context-menu");
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

    // Left-click: toggle compact mode
    pfxButton.addEventListener("click", (e) => {
      if (e.button === 0) compactToggle();
    });

    // Overload #toolbar-context-menu with our items
    const toolbarMenu = document.getElementById("toolbar-context-menu");
    if (toolbarMenu) {
      const compactItem = document.createXULElement("menuitem");
      compactItem.id = "pfx-toggle-compact";
      compactItem.hidden = true;
      compactItem.addEventListener("command", () => compactToggle());

      const collapseItem = document.createXULElement("menuitem");
      collapseItem.id = "pfx-collapse-layout";
      collapseItem.setAttribute("label", "Collapse Layout");
      collapseItem.hidden = true;
      collapseItem.addEventListener("command", () => {
        // The native sidebar-button is display:none, so .click() and
        // .doCommand() don't propagate through Firefox's UI plumbing. Call
        // the sidebar API directly. SidebarController is the modern revamp
        // API; SidebarUI is the legacy fallback.
        try {
          const win = window;
          if (win.SidebarController) {
            // toggleExpanded handles vertical-tabs launcher; toggle handles
            // the bookmarks/history widget show/hide. Try whichever exists.
            if (typeof win.SidebarController.toggleExpanded === "function") {
              win.SidebarController.toggleExpanded();
              return;
            }
            if (typeof win.SidebarController.toggle === "function") {
              win.SidebarController.toggle();
              return;
            }
          }
          if (win.SidebarUI && typeof win.SidebarUI.toggle === "function") {
            win.SidebarUI.toggle();
            return;
          }
          // Last resort: fire the global command directly.
          const cmd = document.getElementById("cmd_toggleSidebar");
          if (cmd && typeof cmd.doCommand === "function") {
            cmd.doCommand();
            return;
          }
          sidebarButton.click();
        } catch (e) {
          console.error("palefox: sidebar toggle failed", e);
        }
      });

      const layoutItem = document.createXULElement("menuitem");
      layoutItem.id = "pfx-toggle-tab-layout";
      layoutItem.hidden = true;
      layoutItem.addEventListener("command", () => {
        const vertical = Services.prefs.getBoolPref(
          "sidebar.verticalTabs",
          true
        );
        Services.prefs.setBoolPref("sidebar.verticalTabs", !vertical);
      });

      const vertTabsItem = document.getElementById(
        "toolbar-context-toggle-vertical-tabs"
      );
      if (vertTabsItem) {
        vertTabsItem.after(compactItem, collapseItem, layoutItem);
      } else {
        toolbarMenu.append(compactItem, collapseItem, layoutItem);
      }

      // Native menu items to show/hide for our custom button
      const customizeSidebar = document.getElementById(
        "toolbar-context-customize-sidebar"
      );
      const toggleVertTabs = document.getElementById(
        "toolbar-context-toggle-vertical-tabs"
      );
      const revampSep = document.getElementById("sidebarRevampSeparator");
      const pinToOverflow = document.getElementById(
        "toolbar-context-move-to-panel"
      );
      const removeFromToolbar = document.getElementById(
        "toolbar-context-remove-from-toolbar"
      );

      // Use popupshown so we run AFTER Firefox's popupshowing logic
      toolbarMenu.addEventListener("popupshown", () => {
        const isPfx = !!toolbarMenu.triggerNode?.closest(
          "#sidebar-button, #pfx-sidebar-button"
        );
        compactItem.hidden = !isPfx;
        collapseItem.hidden = !isPfx;
        layoutItem.hidden = !isPfx;
        if (isPfx) {
          const isCompact = sidebarMain.hasAttribute("data-pfx-compact");
          compactItem.setAttribute(
            "label",
            isCompact ? "Disable Compact" : "Enable Compact"
          );
          // Force-show native sidebar items Firefox hid for our button
          if (customizeSidebar) customizeSidebar.hidden = false;
          if (toggleVertTabs) toggleVertTabs.hidden = true; // replaced by layoutItem
          if (revampSep) revampSep.hidden = true;
          if (pinToOverflow) pinToOverflow.hidden = true;
          if (removeFromToolbar) removeFromToolbar.hidden = true;

          const vertical = Services.prefs.getBoolPref(
            "sidebar.verticalTabs",
            true
          );
          layoutItem.setAttribute(
            "label",
            vertical ? "Horizontal Tabs" : "Vertical Tabs"
          );

          // Ground-truth check: is the sidebar actually rendered? The
          // sidebar-launcher-expanded attribute tracks the vertical-tabs
          // drawer state. In horizontal mode the bookmarks/history sidebar
          // lives outside #sidebar-main, so use SidebarController.isOpen
          // (the modern revamp API) when it's available.
          const sidebarActive = vertical
            ? sidebarMain.hasAttribute("sidebar-launcher-expanded")
            : (window.SidebarController?.isOpen
               ?? (!sidebarMain.hidden
                   && sidebarMain.getBoundingClientRect().width > 0));
          const labels = vertical
            ? { on: "Collapse Layout", off: "Expand Layout" }
            : { on: "Disable Sidebar", off: "Enable Sidebar" };
          collapseItem.setAttribute(
            "label",
            sidebarActive ? labels.on : labels.off
          );
        }
      });
    }
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
