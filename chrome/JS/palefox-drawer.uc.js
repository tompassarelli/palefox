// ==UserScript==
// @name           Palefox Drawer
// @description    Manages sidebar layout, compact mode, and toolbar positioning
// @include        main
// ==/UserScript==

(() => {
  // src/drawer/index.ts
  function init() {
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
    function hideSidebarSplitter() {
      const sr = sidebarMainElement?.shadowRoot;
      if (!sr)
        return setTimeout(hideSidebarSplitter, 100);
      const s = new CSSStyleSheet;
      s.replaceSync(`
      #sidebar-tools-and-extensions-splitter { display: none !important; }
    `);
      sr.adoptedStyleSheets.push(s);
    }
    hideSidebarSplitter();
    const toolboxParent = navigatorToolbox.parentNode;
    const toolboxNext = navigatorToolbox.nextSibling;
    const urlbarParent = urlbarContainer.parentNode;
    const urlbarNext = urlbarContainer.nextSibling;
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pfx-gap")) || 6;
    let urlbarToolbar = null;
    let resizeObs = null;
    let mutationObs = null;
    let updating = false;
    function syncUrlbarWidth() {
      if (!urlbar || updating)
        return;
      if (urlbar.hasAttribute("breakout-extend"))
        return;
      updating = true;
      const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pfx-sidebar-inset")) || 10;
      const w = Math.max(0, sidebarMain.getBoundingClientRect().width - inset * 2);
      urlbar.style.setProperty("--urlbar-width", w + "px");
      updating = false;
    }
    navigatorToolbox.addEventListener("contextmenu", (e) => {
      if (navigatorToolbox.parentNode === sidebarMain) {
        e.stopPropagation();
      }
    });
    function expand() {
      sidebarMain.insertBefore(navigatorToolbox, sidebarMainElement);
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
          attributeFilter: ["style"]
        });
      }
    }
    function collapse() {
      if (resizeObs) {
        resizeObs.disconnect();
        resizeObs = null;
      }
      if (mutationObs) {
        mutationObs.disconnect();
        mutationObs = null;
      }
      if (urlbarNext && urlbarNext.parentNode === urlbarParent) {
        urlbarParent.insertBefore(urlbarContainer, urlbarNext);
      } else {
        urlbarParent.appendChild(urlbarContainer);
      }
      if (urlbarToolbar) {
        urlbarToolbar.remove();
        urlbarToolbar = null;
      }
      const spring2 = document.getElementById("customizableui-special-spring2");
      const extBtn = document.getElementById("unified-extensions-button");
      if (spring2)
        urlbarContainer.after(spring2);
      if (spring2 && extBtn)
        spring2.after(extBtn);
      if (toolboxNext && toolboxNext.parentNode === toolboxParent) {
        toolboxParent.insertBefore(navigatorToolbox, toolboxNext);
      } else {
        toolboxParent.appendChild(navigatorToolbox);
      }
    }
    let dragOverlay = null;
    let dragResizeObs = null;
    let dragMutationObs = null;
    const arrowscrollbox = document.getElementById("tabbrowser-arrowscrollbox");
    function updateDragOverlay() {
      if (!dragOverlay || !arrowscrollbox)
        return;
      const containerRect = sidebarMain.getBoundingClientRect();
      const asbRect = arrowscrollbox.getBoundingClientRect();
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
      dragOverlay.style.left = asbRect.left - containerRect.left + "px";
      dragOverlay.style.top = top - containerRect.top + "px";
      dragOverlay.style.width = asbRect.width + "px";
      dragOverlay.style.height = height + "px";
      dragOverlay.style.display = height > 0 ? "" : "none";
    }
    function draggableEnable() {
      if (dragOverlay)
        return;
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
      if (!dragOverlay)
        return;
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
      }
    };
    Services.prefs.addObserver(DRAGGABLE_PREF, draggableObserver);
    const WIDTH_PREF = "pfx.sidebar.width";
    const defaultWidth = Services.prefs.getIntPref(WIDTH_PREF, 300);
    if (sidebarMain.hasAttribute("sidebar-launcher-expanded")) {
      sidebarMain.style.width = defaultWidth + "px";
    }
    new ResizeObserver(() => {
      if (!sidebarMain.hasAttribute("sidebar-launcher-expanded"))
        return;
      const w = Math.round(sidebarMain.getBoundingClientRect().width);
      if (w > 0)
        Services.prefs.setIntPref(WIDTH_PREF, w);
    }).observe(sidebarMain);
    if (sidebarMain.hasAttribute("sidebar-launcher-expanded")) {
      expand();
    }
    new MutationObserver(() => {
      const expanded = sidebarMain.hasAttribute("sidebar-launcher-expanded");
      if (expanded && !urlbarToolbar) {
        expand();
      } else if (!expanded && urlbarToolbar) {
        collapse();
      }
    }).observe(sidebarMain, {
      attributes: true,
      attributeFilter: ["sidebar-launcher-expanded"]
    });
    const COMPACT_PREF = "pfx.sidebar.compact";
    const DEBUG_PREF = "pfx.debug";
    const KEEP_HOVER_DURATION = 300;
    function dbg(event, data = {}) {
      if (!Services.prefs.getBoolPref(DEBUG_PREF, false))
        return;
      console.log("[PFX:drawer]", event, {
        compact: sidebarMain.hasAttribute("data-pfx-compact"),
        hover: sidebarMain.hasAttribute("pfx-has-hover"),
        openPopups: _openPopups,
        flashPending: flashTimer !== null,
        guarded: isGuarded(),
        ...data
      });
    }
    let hoverStrip = null;
    let flashTimer = null;
    let urlbarCompactObserver = null;
    let _ignoreNextHover = false;
    sidebarMain.addEventListener("pfx-dismiss", () => {
      _ignoreNextHover = true;
      setHover(false);
      clearFlash();
      setTimeout(() => {
        _ignoreNextHover = false;
      }, KEEP_HOVER_DURATION + 100);
    });
    let _openPopups = 0;
    function _isIgnoredPopup(e) {
      const el = e.composedPath?.()[0] ?? e.target;
      return el.localName === "tooltip" || el.id === "tab-preview-panel";
    }
    document.addEventListener("popupshown", (e) => {
      if (_isIgnoredPopup(e))
        return;
      _openPopups++;
      dbg("popupshown", { id: e.target.id, tag: e.target.localName, _openPopups });
    });
    document.addEventListener("popuphidden", (e) => {
      if (_isIgnoredPopup(e))
        return;
      _openPopups = Math.max(0, _openPopups - 1);
      dbg("popuphidden", { id: e.target.id, tag: e.target.localName, _openPopups });
    });
    function isGuarded() {
      if (_openPopups > 0)
        return true;
      if (urlbar?.hasAttribute("breakout-extend"))
        return true;
      if (document.querySelector("toolbarbutton[open='true']"))
        return true;
      if (document.querySelector(".tabbrowser-tab[multiselected]"))
        return true;
      if (document.querySelector("[pfx-dragging]"))
        return true;
      return false;
    }
    function setHover(value) {
      dbg("setHover", { value });
      if (value && _ignoreNextHover) {
        sidebarMain.removeAttribute("pfx-has-hover");
        return;
      }
      if (value) {
        sidebarMain.setAttribute("pfx-has-hover", "true");
      } else {
        sidebarMain.removeAttribute("pfx-has-hover");
      }
    }
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
    function onSidebarEnter(event) {
      setTimeout(() => {
        if (!event.target.matches(":hover"))
          return;
        if (event.target.closest("panel"))
          return;
        clearFlash();
        requestAnimationFrame(() => {
          if (_ignoreNextHover)
            return;
          if (sidebarMain.hasAttribute("pfx-has-hover"))
            return;
          setHover(true);
        });
      }, 0);
    }
    function onSidebarLeave(event) {
      setTimeout(() => {
        if (event.target.matches(":hover"))
          return;
        if (_ignoreNextHover)
          return;
        if (isGuarded())
          return;
        flashSidebar(KEEP_HOVER_DURATION);
      }, 0);
    }
    function compactEnable() {
      dbg("compactEnable");
      sidebarMain.setAttribute("data-pfx-compact", "");
      if (urlbar && !urlbarCompactObserver) {
        urlbar.removeAttribute("popover");
        urlbarCompactObserver = new MutationObserver(() => {
          if (!sidebarMain.hasAttribute("data-pfx-compact"))
            return;
          if (urlbar.hasAttribute("breakout-extend")) {
            dbg("urlbar:breakout-open");
            urlbar.setAttribute("popover", "manual");
            if (!urlbar.matches(":popover-open"))
              urlbar.showPopover();
          } else {
            dbg("urlbar:breakout-close");
            urlbar.removeAttribute("popover");
            if (!sidebarMain.matches(":hover")) {
              flashSidebar(KEEP_HOVER_DURATION);
            }
          }
        });
        urlbarCompactObserver.observe(urlbar, { attributes: true, attributeFilter: ["breakout-extend"] });
      }
      if (!hoverStrip) {
        hoverStrip = document.createXULElement("box");
        hoverStrip.id = "pfx-hover-strip";
        sidebarMain.parentNode.appendChild(hoverStrip);
        hoverStrip.addEventListener("mouseenter", () => {
          if (_ignoreNextHover)
            return;
          clearFlash();
          requestAnimationFrame(() => {
            if (!_ignoreNextHover)
              setHover(true);
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
      urlbarCompactObserver?.disconnect();
      urlbarCompactObserver = null;
      if (urlbar) {
        urlbar.setAttribute("popover", "manual");
        if (!urlbar.matches(":popover-open"))
          urlbar.showPopover();
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
        const clearIgnore = () => {
          _ignoreNextHover = false;
        };
        const safetyTimer = setTimeout(clearIgnore, 400);
        sidebarMain.addEventListener("transitionend", function onTransitionEnd(e) {
          if (e.target !== sidebarMain || e.propertyName !== "transform")
            return;
          sidebarMain.removeEventListener("transitionend", onTransitionEnd);
          clearTimeout(safetyTimer);
          clearIgnore();
        });
      }
    }
    if (Services.prefs.getBoolPref(COMPACT_PREF, false)) {
      compactEnable();
    }
    const compactObserver = {
      observe() {
        const enabled = Services.prefs.getBoolPref(COMPACT_PREF, false);
        const active = sidebarMain.hasAttribute("data-pfx-compact");
        if (enabled && !active)
          compactEnable();
        else if (!enabled && active)
          compactDisable();
      }
    };
    Services.prefs.addObserver(COMPACT_PREF, compactObserver);
    window.addEventListener("unload", () => {
      Services.prefs.removeObserver(DRAGGABLE_PREF, draggableObserver);
      Services.prefs.removeObserver(COMPACT_PREF, compactObserver);
    }, { once: true });
    window.addEventListener("sizemodechange", () => {
      if (sidebarMain.hasAttribute("pfx-has-hover") && !sidebarMain.matches(":hover")) {
        setHover(false);
        clearFlash();
      }
    });
    const sidebarButton = document.getElementById("sidebar-button");
    if (sidebarButton) {
      const ogIcon = sidebarButton.querySelector(".toolbarbutton-icon");
      const ogIconStyle = ogIcon ? getComputedStyle(ogIcon).listStyleImage : null;
      sidebarButton.style.display = "none";
      const pfxButton = document.createXULElement("toolbarbutton");
      pfxButton.id = "pfx-sidebar-button";
      pfxButton.className = sidebarButton.className;
      pfxButton.setAttribute("tooltiptext", "Toggle compact mode (right-click for more)");
      pfxButton.setAttribute("context", "toolbar-context-menu");
      for (const attr of [
        "cui-areatype",
        "widget-id",
        "widget-type",
        "removable",
        "overflows"
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
        if (e.button === 0)
          compactToggle();
      });
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
          try {
            const win = window;
            if (win.SidebarController) {
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
          const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
          Services.prefs.setBoolPref("sidebar.verticalTabs", !vertical);
        });
        const vertTabsItem = document.getElementById("toolbar-context-toggle-vertical-tabs");
        if (vertTabsItem) {
          vertTabsItem.after(compactItem, collapseItem, layoutItem);
        } else {
          toolbarMenu.append(compactItem, collapseItem, layoutItem);
        }
        const customizeSidebar = document.getElementById("toolbar-context-customize-sidebar");
        const toggleVertTabs = document.getElementById("toolbar-context-toggle-vertical-tabs");
        const revampSep = document.getElementById("sidebarRevampSeparator");
        const pinToOverflow = document.getElementById("toolbar-context-move-to-panel");
        const removeFromToolbar = document.getElementById("toolbar-context-remove-from-toolbar");
        toolbarMenu.addEventListener("popupshown", () => {
          const isPfx = !!toolbarMenu.triggerNode?.closest("#sidebar-button, #pfx-sidebar-button");
          compactItem.hidden = !isPfx;
          collapseItem.hidden = !isPfx;
          layoutItem.hidden = !isPfx;
          if (isPfx) {
            const isCompact = sidebarMain.hasAttribute("data-pfx-compact");
            compactItem.setAttribute("label", isCompact ? "Disable Compact" : "Enable Compact");
            if (customizeSidebar)
              customizeSidebar.hidden = false;
            if (toggleVertTabs)
              toggleVertTabs.hidden = true;
            if (revampSep)
              revampSep.hidden = true;
            if (pinToOverflow)
              pinToOverflow.hidden = true;
            if (removeFromToolbar)
              removeFromToolbar.hidden = true;
            const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
            layoutItem.setAttribute("label", vertical ? "Horizontal Tabs" : "Vertical Tabs");
            const sidebarActive = vertical ? sidebarMain.hasAttribute("sidebar-launcher-expanded") : window.SidebarController?.isOpen ?? (!sidebarMain.hidden && sidebarMain.getBoundingClientRect().width > 0);
            const labels = vertical ? { on: "Collapse Layout", off: "Expand Layout" } : { on: "Disable Sidebar", off: "Enable Sidebar" };
            collapseItem.setAttribute("label", sidebarActive ? labels.on : labels.off);
          }
        });
      }
    }
    const identityBox = document.getElementById("identity-box");
    let insecureTimer = null;
    let insecureBanner = null;
    function showInsecureBanner() {
      if (insecureBanner)
        return;
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
      const isInsecure = identityBox?.classList.contains("notSecure") && !isInternal && !isCustomizing;
      if (isInsecure && !insecureTimer && !insecureBanner) {
        insecureTimer = setTimeout(showInsecureBanner, 2000);
      } else if (!isInsecure) {
        hideInsecureBanner();
      }
    }
    if (identityBox) {
      new MutationObserver(checkInsecure).observe(identityBox, {
        attributes: true,
        attributeFilter: ["class"]
      });
      gBrowser.tabContainer.addEventListener("TabSelect", checkInsecure);
    }
    console.log("palefox-drawer: initialized");
  }
  init();
})();
