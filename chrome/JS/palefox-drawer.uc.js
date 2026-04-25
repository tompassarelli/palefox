// ==UserScript==
// @name           Palefox Drawer
// @description    Manages sidebar layout, compact mode, and toolbar positioning
// @include        main
// ==/UserScript==

(() => {
  // src/tabs/log.ts
  var LOG_FILENAME = "palefox-debug.log";
  var LOG_MAX_BYTES = 5 * 1024 * 1024;
  var _logPath = null;
  var _rotateChecked = false;
  function logPath() {
    if (_logPath)
      return _logPath;
    _logPath = PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, LOG_FILENAME);
    return _logPath;
  }
  function maybeRotate() {
    if (_rotateChecked)
      return;
    _rotateChecked = true;
    IOUtils.stat(logPath()).then((info) => {
      if (info.size > LOG_MAX_BYTES) {
        return IOUtils.write(logPath(), new Uint8Array(0), { mode: "overwrite" });
      }
    }).catch(() => {});
  }
  var _lines = [];
  var _flushPending = false;
  function flush() {
    const batch = _lines.splice(0);
    if (!batch.length) {
      _flushPending = false;
      return;
    }
    const blob = new TextEncoder().encode(batch.join(`
`) + `
`);
    const path = logPath();
    IOUtils.write(path, blob, { mode: "appendOrCreate" }).then(() => {
      if (_lines.length)
        flush();
      else
        _flushPending = false;
    }).catch((e) => {
      console.error("[PFX:log] write failed", e);
      _flushPending = false;
    });
  }
  function createLogger(tag) {
    const consolePrefix = `[PFX:${tag}]`;
    return (event, data = {}) => {
      if (!Services.prefs.getBoolPref("pfx.debug", false))
        return;
      maybeRotate();
      console.log(consolePrefix, event, data);
      _lines.push(`${Date.now()} [${tag}] ${event} ${JSON.stringify(data)}`);
      if (!_flushPending) {
        _flushPending = true;
        Promise.resolve().then(flush);
      }
    };
  }

  // src/drawer/compact.ts
  function makeCompact(deps) {
    const { sidebarMain, navigatorToolbox, urlbar } = deps;
    const COMPACT_PREF = "pfx.sidebar.compact";
    const HORIZONTAL_COMPACT_PREF = "pfx.toolbar.compact";
    const KEEP_HOVER_DURATION = 150;
    const OFFSCREEN_SHOW_DURATION = 1000;
    const FLASH_DURATION = 800;
    const COLLAPSE_PROTECTION_DURATION = 280;
    function hoverHackDelay() {
      return Services.prefs.getIntPref("pfx.compact.hoverHackDelay", 0);
    }
    const log = createLogger("compact");
    function dbg(event, data = {}) {
      log(event, {
        compact: sidebarMain.hasAttribute("data-pfx-compact"),
        compactHz: document.documentElement.hasAttribute("data-pfx-compact-horizontal"),
        hover: sidebarMain.hasAttribute("pfx-has-hover"),
        hoverHz: navigatorToolbox.hasAttribute("pfx-has-hover"),
        openPopups: _openPopups,
        flashPending: flashTimer !== null,
        ...data
      });
    }
    let hoverStrip = null;
    let flashTimer = null;
    let urlbarCompactObserver = null;
    let _collapseProtectedUntil = 0;
    let hideWatchdogTimer = null;
    let hoverStripTop = null;
    let _hzFlashTimer = null;
    let urlbarCompactObserverHz = null;
    let _collapseProtectedHzUntil = 0;
    let hideWatchdogTimerHz = null;
    let _ignoreNextHover = false;
    let _openPopups = 0;
    function _isIgnoredPopup(e) {
      const path = e.composedPath?.();
      const el = path?.[0] ?? e.target;
      return el.localName === "tooltip" || el.id === "tab-preview-panel";
    }
    function onPopupShown(e) {
      if (_isIgnoredPopup(e))
        return;
      _openPopups++;
      const t = e.target;
      dbg("popupshown", { id: t.id, tag: t.localName, _openPopups });
    }
    function onPopupHidden(e) {
      if (_isIgnoredPopup(e))
        return;
      _openPopups = Math.max(0, _openPopups - 1);
      const t = e.target;
      dbg("popuphidden", { id: t.id, tag: t.localName, _openPopups });
    }
    function reconcileCounterIfStale() {
      if (_openPopups <= 0)
        return;
      const live = document.querySelector("panel[panelopen='true'], panel[open='true'], " + "menupopup[state='open'], menupopup[state='showing'], " + "menupopup[open='true']");
      if (!live) {
        dbg("reconcileCounterIfStale:reset", { stale: _openPopups });
        _openPopups = 0;
      }
    }
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
      dbg("setHover", {
        value,
        collapseProtectedRemaining: Math.max(0, _collapseProtectedUntil - Date.now())
      });
      if (value && _ignoreNextHover) {
        sidebarMain.removeAttribute("pfx-has-hover");
        return;
      }
      if (value) {
        const collapseRemaining = _collapseProtectedUntil - Date.now();
        if (collapseRemaining > 0) {
          dbg("setHover:revealDropped", { collapseRemaining });
          return;
        }
        sidebarMain.setAttribute("pfx-has-hover", "true");
        return;
      }
      if (sidebarMain.hasAttribute("pfx-has-hover")) {
        sidebarMain.removeAttribute("pfx-has-hover");
        _collapseProtectedUntil = Date.now() + COLLAPSE_PROTECTION_DURATION;
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
          reconcileCounterIfStale();
          if (isGuarded()) {
            dbg("flashSidebar:hide-blocked");
            scheduleHideWatchdog();
          } else {
            setHover(false);
          }
          flashTimer = null;
        });
      }, duration);
    }
    function clearFlash() {
      if (flashTimer)
        clearTimeout(flashTimer);
      flashTimer = null;
    }
    function reconcileCompactState(trigger) {
      if (!sidebarMain.hasAttribute("data-pfx-compact"))
        return;
      const before = {
        hover: sidebarMain.hasAttribute("pfx-has-hover"),
        flashPending: flashTimer !== null,
        _ignoreNextHover,
        _openPopups
      };
      _ignoreNextHover = false;
      reconcileCounterIfStale();
      const cursorOver = sidebarMain.matches(":hover") || (hoverStrip?.matches(":hover") ?? false);
      const guarded = isGuarded();
      if (guarded || cursorOver) {
        if (!sidebarMain.hasAttribute("pfx-has-hover")) {
          sidebarMain.setAttribute("pfx-has-hover", "true");
        }
        scheduleHideWatchdog();
      } else if (flashTimer !== null) {
        dbg("reconcileCompactState:flashPending");
      } else {
        setHover(false);
        cancelHideWatchdog();
      }
      dbg("reconcileCompactState", {
        trigger,
        before,
        cursorOver,
        guarded,
        after: {
          hover: sidebarMain.hasAttribute("pfx-has-hover"),
          flashPending: flashTimer !== null,
          _ignoreNextHover
        }
      });
    }
    function scheduleHideWatchdog() {
      if (hideWatchdogTimer)
        return;
      hideWatchdogTimer = setTimeout(() => {
        hideWatchdogTimer = null;
        reconcileCompactState("hide-watchdog-1s");
      }, 1000);
    }
    function cancelHideWatchdog() {
      if (hideWatchdogTimer) {
        clearTimeout(hideWatchdogTimer);
        hideWatchdogTimer = null;
      }
    }
    function setToolboxHover(value) {
      dbg("setToolboxHover", { value });
      if (value && _ignoreNextHover) {
        navigatorToolbox.removeAttribute("pfx-has-hover");
        return;
      }
      if (value) {
        if (Date.now() < _collapseProtectedHzUntil) {
          dbg("setToolboxHover:revealDropped");
          return;
        }
        navigatorToolbox.setAttribute("pfx-has-hover", "true");
        return;
      }
      if (navigatorToolbox.hasAttribute("pfx-has-hover")) {
        navigatorToolbox.removeAttribute("pfx-has-hover");
        _collapseProtectedHzUntil = Date.now() + COLLAPSE_PROTECTION_DURATION;
      }
    }
    function flashToolbox(duration) {
      if (_hzFlashTimer) {
        clearTimeout(_hzFlashTimer);
        dbg("flashToolbox:extend", { duration });
      } else {
        dbg("flashToolbox:show", { duration });
        requestAnimationFrame(() => setToolboxHover(true));
      }
      _hzFlashTimer = setTimeout(() => {
        requestAnimationFrame(() => {
          reconcileCounterIfStale();
          if (isGuarded()) {
            dbg("flashToolbox:hide-blocked");
            scheduleHideWatchdogHz();
          } else {
            setToolboxHover(false);
          }
          _hzFlashTimer = null;
        });
      }, duration);
    }
    function clearFlashToolbox() {
      if (_hzFlashTimer)
        clearTimeout(_hzFlashTimer);
      _hzFlashTimer = null;
    }
    function reconcileCompactStateHorizontal(trigger) {
      if (!document.documentElement.hasAttribute("data-pfx-compact-horizontal"))
        return;
      const before = {
        hover: navigatorToolbox.hasAttribute("pfx-has-hover"),
        flashPending: _hzFlashTimer !== null,
        _ignoreNextHover,
        _openPopups
      };
      _ignoreNextHover = false;
      reconcileCounterIfStale();
      const cursorOver = navigatorToolbox.matches(":hover") || (hoverStripTop?.matches(":hover") ?? false);
      const guarded = isGuarded();
      if (guarded || cursorOver) {
        if (!navigatorToolbox.hasAttribute("pfx-has-hover")) {
          navigatorToolbox.setAttribute("pfx-has-hover", "true");
        }
        scheduleHideWatchdogHz();
      } else if (_hzFlashTimer !== null) {
        dbg("reconcileCompactStateHorizontal:flashPending");
      } else {
        setToolboxHover(false);
        cancelHideWatchdogHz();
      }
      dbg("reconcileCompactStateHorizontal", {
        trigger,
        before,
        cursorOver,
        guarded,
        after: {
          hover: navigatorToolbox.hasAttribute("pfx-has-hover"),
          flashPending: _hzFlashTimer !== null,
          _ignoreNextHover
        }
      });
    }
    function scheduleHideWatchdogHz() {
      if (hideWatchdogTimerHz)
        return;
      hideWatchdogTimerHz = setTimeout(() => {
        hideWatchdogTimerHz = null;
        reconcileCompactStateHorizontal("hide-watchdog-1s-hz");
      }, 1000);
    }
    function cancelHideWatchdogHz() {
      if (hideWatchdogTimerHz) {
        clearTimeout(hideWatchdogTimerHz);
        hideWatchdogTimerHz = null;
      }
    }
    function onSidebarEnter(event) {
      const target = event.target;
      const targetId = target.id || target.localName;
      dbg("onSidebarEnter:entry", { targetId, _ignoreNextHover, flashPending: flashTimer !== null });
      setTimeout(() => {
        if (!target.matches(":hover")) {
          dbg("onSidebarEnter:abort", { reason: "not-hovered-after-tick", targetId });
          return;
        }
        if (target.closest("panel")) {
          dbg("onSidebarEnter:abort", { reason: "from-panel", targetId });
          return;
        }
        clearFlash();
        if (_collapseProtectedUntil > Date.now()) {
          dbg("onSidebarEnter:cancel-collapse-protection", {
            remainingMs: _collapseProtectedUntil - Date.now()
          });
          _collapseProtectedUntil = 0;
        }
        requestAnimationFrame(() => {
          if (_ignoreNextHover) {
            dbg("onSidebarEnter:abort", { reason: "ignore-next-hover-rAF", targetId });
            return;
          }
          if (sidebarMain.hasAttribute("pfx-has-hover")) {
            dbg("onSidebarEnter:abort", { reason: "already-has-hover", targetId });
            return;
          }
          dbg("onSidebarEnter:show", { targetId });
          setHover(true);
        });
      }, hoverHackDelay());
    }
    function onSidebarLeave(event) {
      const target = event.target;
      const targetId = target.id || target.localName;
      const exitedWindow = !event.relatedTarget;
      const lingerMs = exitedWindow ? OFFSCREEN_SHOW_DURATION : KEEP_HOVER_DURATION;
      dbg("onSidebarLeave:entry", { targetId, _ignoreNextHover, exitedWindow, lingerMs });
      setTimeout(() => {
        if (target.matches(":hover")) {
          dbg("onSidebarLeave:abort", { reason: "still-hovered-after-tick", targetId });
          return;
        }
        if (_ignoreNextHover) {
          dbg("onSidebarLeave:abort", { reason: "ignore-next-hover", targetId });
          return;
        }
        if (isGuarded()) {
          dbg("onSidebarLeave:abort", { reason: "guarded", targetId });
          return;
        }
        dbg("onSidebarLeave:flash", { targetId, duration: lingerMs });
        flashSidebar(lingerMs);
      }, hoverHackDelay());
    }
    function onDocMouseLeave(e) {
      if (!sidebarMain.hasAttribute("data-pfx-compact"))
        return;
      if (sidebarMain.hasAttribute("pfx-has-hover"))
        return;
      if (_ignoreNextHover)
        return;
      const triggerWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--pfx-compact-trigger-width") || "8", 10);
      const onLeft = Services.prefs.getBoolPref("sidebar.position_start", true);
      const nearEdge = onLeft ? e.clientX <= triggerWidth * 3 : e.clientX >= window.innerWidth - triggerWidth * 3;
      if (!nearEdge)
        return;
      dbg("onDocMouseLeave:show", { clientX: e.clientX, onLeft });
      flashSidebar(OFFSCREEN_SHOW_DURATION);
    }
    function onToolboxEnter(event) {
      const target = event.target;
      setTimeout(() => {
        if (!target.matches(":hover"))
          return;
        if (target.closest("panel"))
          return;
        clearFlashToolbox();
        if (_collapseProtectedHzUntil > Date.now()) {
          _collapseProtectedHzUntil = 0;
        }
        requestAnimationFrame(() => {
          if (_ignoreNextHover)
            return;
          if (navigatorToolbox.hasAttribute("pfx-has-hover"))
            return;
          setToolboxHover(true);
        });
      }, hoverHackDelay());
    }
    function onToolboxLeave(event) {
      const target = event.target;
      const exitedWindow = !event.relatedTarget;
      const lingerMs = exitedWindow ? OFFSCREEN_SHOW_DURATION : KEEP_HOVER_DURATION;
      setTimeout(() => {
        if (target.matches(":hover"))
          return;
        if (_ignoreNextHover)
          return;
        if (isGuarded())
          return;
        flashToolbox(lingerMs);
      }, hoverHackDelay());
    }
    function onDocMouseLeaveTop(e) {
      if (!document.documentElement.hasAttribute("data-pfx-compact-horizontal"))
        return;
      if (navigatorToolbox.hasAttribute("pfx-has-hover"))
        return;
      if (_ignoreNextHover)
        return;
      const triggerHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--pfx-compact-trigger-width") || "8", 10);
      if (e.clientY > triggerHeight * 3)
        return;
      dbg("onDocMouseLeaveTop:show", { clientY: e.clientY });
      flashToolbox(OFFSCREEN_SHOW_DURATION);
    }
    function compactEnable() {
      dbg("compactEnable");
      sidebarMain.setAttribute("data-pfx-compact", "");
      if (urlbar && !urlbarCompactObserver) {
        urlbar.removeAttribute("popover");
        urlbarCompactObserver = new MutationObserver(() => {
          if (!sidebarMain.hasAttribute("data-pfx-compact"))
            return;
          if (document.documentElement.hasAttribute("pfx-urlbar-floating"))
            return;
          if (urlbar.hasAttribute("breakout-extend")) {
            dbg("urlbar:breakout-open");
            urlbar.setAttribute("popover", "manual");
            if (!urlbar.matches(":popover-open"))
              urlbar.showPopover();
          } else {
            dbg("urlbar:breakout-close");
            urlbar.removeAttribute("popover");
            const cursorOver = sidebarMain.matches(":hover") || (hoverStrip?.matches(":hover") ?? false);
            if (cursorOver) {
              dbg("urlbar:breakout-close:keep-open");
            } else {
              dbg("urlbar:breakout-close:close");
              clearFlash();
              cancelHideWatchdog();
              if (sidebarMain.hasAttribute("pfx-has-hover")) {
                sidebarMain.removeAttribute("pfx-has-hover");
              }
              _collapseProtectedUntil = Date.now() + COLLAPSE_PROTECTION_DURATION;
            }
          }
        });
        urlbarCompactObserver.observe(urlbar, {
          attributes: true,
          attributeFilter: ["breakout-extend"]
        });
      }
      if (!hoverStrip || !hoverStrip.isConnected) {
        hoverStrip = document.createXULElement("box");
        hoverStrip.id = "pfx-hover-strip";
        sidebarMain.parentNode.appendChild(hoverStrip);
        hoverStrip.addEventListener("mouseenter", () => {
          dbg("hoverStrip:mouseenter", {
            _ignoreNextHover,
            flashPending: flashTimer !== null,
            hasHover: sidebarMain.hasAttribute("pfx-has-hover")
          });
          if (_ignoreNextHover) {
            dbg("hoverStrip:abort", { reason: "ignore-next-hover-sync" });
            return;
          }
          flashSidebar(OFFSCREEN_SHOW_DURATION);
        });
      }
      sidebarMain.addEventListener("mouseover", onSidebarEnter);
      sidebarMain.addEventListener("mouseleave", onSidebarLeave);
      document.documentElement.addEventListener("mouseleave", onDocMouseLeave);
    }
    function compactDisable() {
      dbg("compactDisable");
      clearFlash();
      cancelHideWatchdog();
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
      document.documentElement.removeEventListener("mouseleave", onDocMouseLeave);
    }
    function compactEnableHorizontal() {
      if (document.documentElement.hasAttribute("data-pfx-compact-horizontal"))
        return;
      dbg("compactEnableHorizontal");
      document.documentElement.setAttribute("data-pfx-compact-horizontal", "");
      if (urlbar && !urlbarCompactObserverHz) {
        urlbar.removeAttribute("popover");
        urlbarCompactObserverHz = new MutationObserver(() => {
          if (!document.documentElement.hasAttribute("data-pfx-compact-horizontal"))
            return;
          if (urlbar.hasAttribute("breakout-extend")) {
            urlbar.setAttribute("popover", "manual");
            if (!urlbar.matches(":popover-open"))
              urlbar.showPopover();
          } else {
            urlbar.removeAttribute("popover");
          }
        });
        urlbarCompactObserverHz.observe(urlbar, {
          attributes: true,
          attributeFilter: ["breakout-extend"]
        });
      }
      if (!hoverStripTop || !hoverStripTop.isConnected) {
        hoverStripTop = document.createXULElement("box");
        hoverStripTop.id = "pfx-hover-strip-top";
        document.documentElement.appendChild(hoverStripTop);
        hoverStripTop.addEventListener("mouseenter", () => {
          if (_ignoreNextHover)
            return;
          flashToolbox(OFFSCREEN_SHOW_DURATION);
        });
      }
      navigatorToolbox.addEventListener("mouseover", onToolboxEnter);
      navigatorToolbox.addEventListener("mouseleave", onToolboxLeave);
      document.documentElement.addEventListener("mouseleave", onDocMouseLeaveTop);
    }
    function compactDisableHorizontal() {
      if (!document.documentElement.hasAttribute("data-pfx-compact-horizontal"))
        return;
      dbg("compactDisableHorizontal");
      clearFlashToolbox();
      cancelHideWatchdogHz();
      document.documentElement.removeAttribute("data-pfx-compact-horizontal");
      navigatorToolbox.removeAttribute("pfx-has-hover");
      urlbarCompactObserverHz?.disconnect();
      urlbarCompactObserverHz = null;
      if (urlbar) {
        urlbar.setAttribute("popover", "manual");
        if (!urlbar.matches(":popover-open"))
          urlbar.showPopover();
      }
      if (hoverStripTop) {
        hoverStripTop.remove();
        hoverStripTop = null;
      }
      navigatorToolbox.removeEventListener("mouseover", onToolboxEnter);
      navigatorToolbox.removeEventListener("mouseleave", onToolboxLeave);
      document.documentElement.removeEventListener("mouseleave", onDocMouseLeaveTop);
    }
    function compactToggle() {
      const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
      if (vertical) {
        const active = sidebarMain.hasAttribute("data-pfx-compact");
        dbg("compactToggle:vertical", { wasActive: active });
        if (active) {
          compactDisable();
          Services.prefs.setBoolPref(COMPACT_PREF, false);
        } else {
          _ignoreNextHover = true;
          compactEnable();
          Services.prefs.setBoolPref(COMPACT_PREF, true);
          const safetyTimer = setTimeout(() => reconcileCompactState("safety-timer-400ms"), 400);
          sidebarMain.addEventListener("transitionend", function onTransitionEnd(e) {
            if (e.target !== sidebarMain || e.propertyName !== "transform")
              return;
            sidebarMain.removeEventListener("transitionend", onTransitionEnd);
            clearTimeout(safetyTimer);
            reconcileCompactState("transitionend-transform");
          });
        }
      } else {
        const active = document.documentElement.hasAttribute("data-pfx-compact-horizontal");
        dbg("compactToggle:horizontal", { wasActive: active });
        if (active) {
          compactDisableHorizontal();
          Services.prefs.setBoolPref(HORIZONTAL_COMPACT_PREF, false);
        } else {
          _ignoreNextHover = true;
          compactEnableHorizontal();
          Services.prefs.setBoolPref(HORIZONTAL_COMPACT_PREF, true);
          const safetyTimer = setTimeout(() => reconcileCompactStateHorizontal("safety-timer-400ms-hz"), 400);
          navigatorToolbox.addEventListener("transitionend", function onTransitionEnd(e) {
            if (e.target !== navigatorToolbox || e.propertyName !== "transform")
              return;
            navigatorToolbox.removeEventListener("transitionend", onTransitionEnd);
            clearTimeout(safetyTimer);
            reconcileCompactStateHorizontal("transitionend-transform-hz");
          });
        }
      }
    }
    function applyCompactForCurrentMode() {
      const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
      if (vertical) {
        if (Services.prefs.getBoolPref(COMPACT_PREF, false) && !sidebarMain.hasAttribute("data-pfx-compact")) {
          compactEnable();
        }
      } else {
        if (Services.prefs.getBoolPref(HORIZONTAL_COMPACT_PREF, false) && !document.documentElement.hasAttribute("data-pfx-compact-horizontal")) {
          compactEnableHorizontal();
        }
      }
    }
    const compactObserver = {
      observe() {
        const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
        if (!vertical)
          return;
        const enabled = Services.prefs.getBoolPref(COMPACT_PREF, false);
        const active = sidebarMain.hasAttribute("data-pfx-compact");
        if (enabled && !active)
          compactEnable();
        else if (!enabled && active)
          compactDisable();
      }
    };
    const compactObserverHz = {
      observe() {
        const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
        if (vertical)
          return;
        const enabled = Services.prefs.getBoolPref(HORIZONTAL_COMPACT_PREF, false);
        const active = document.documentElement.hasAttribute("data-pfx-compact-horizontal");
        if (enabled && !active)
          compactEnableHorizontal();
        else if (!enabled && active)
          compactDisableHorizontal();
      }
    };
    const verticalTabsObserver = {
      observe() {
        const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
        dbg("verticalTabs:change", { vertical });
        if (vertical)
          compactDisableHorizontal();
        else
          compactDisable();
        applyCompactForCurrentMode();
      }
    };
    function onPfxDismiss() {
      _ignoreNextHover = true;
      setHover(false);
      clearFlash();
      setTimeout(() => {
        _ignoreNextHover = false;
      }, KEEP_HOVER_DURATION + 100);
    }
    function onPfxFlash() {
      if (!sidebarMain.hasAttribute("data-pfx-compact"))
        return;
      flashSidebar(FLASH_DURATION);
    }
    function onSizemodeChange() {
      reconcileCompactState("sizemodechange");
    }
    function onWindowBlur(e) {
      if (e.target !== window)
        return;
      reconcileCompactState("window-blur");
    }
    document.addEventListener("popupshown", onPopupShown);
    document.addEventListener("popuphidden", onPopupHidden);
    sidebarMain.addEventListener("pfx-dismiss", onPfxDismiss);
    sidebarMain.addEventListener("pfx-flash", onPfxFlash);
    window.addEventListener("sizemodechange", onSizemodeChange);
    window.addEventListener("blur", onWindowBlur);
    Services.prefs.addObserver(COMPACT_PREF, compactObserver);
    Services.prefs.addObserver(HORIZONTAL_COMPACT_PREF, compactObserverHz);
    Services.prefs.addObserver("sidebar.verticalTabs", verticalTabsObserver);
    applyCompactForCurrentMode();
    function pinSidebar() {
      sidebarMain.setAttribute("pfx-has-hover", "true");
      clearFlash();
    }
    function pinToolbox() {
      navigatorToolbox.setAttribute("pfx-has-hover", "true");
      clearFlashToolbox();
    }
    function destroy() {
      document.removeEventListener("popupshown", onPopupShown);
      document.removeEventListener("popuphidden", onPopupHidden);
      sidebarMain.removeEventListener("pfx-dismiss", onPfxDismiss);
      sidebarMain.removeEventListener("pfx-flash", onPfxFlash);
      window.removeEventListener("sizemodechange", onSizemodeChange);
      window.removeEventListener("blur", onWindowBlur);
      Services.prefs.removeObserver(COMPACT_PREF, compactObserver);
      Services.prefs.removeObserver(HORIZONTAL_COMPACT_PREF, compactObserverHz);
      Services.prefs.removeObserver("sidebar.verticalTabs", verticalTabsObserver);
      cancelHideWatchdog();
      cancelHideWatchdogHz();
      clearFlash();
      clearFlashToolbox();
    }
    return {
      toggle: compactToggle,
      reconcile: reconcileCompactState,
      reconcileHorizontal: reconcileCompactStateHorizontal,
      pinSidebar,
      pinToolbox,
      isCompactVertical: () => sidebarMain.hasAttribute("data-pfx-compact"),
      isCompactHorizontal: () => document.documentElement.hasAttribute("data-pfx-compact-horizontal"),
      destroy
    };
  }

  // src/drawer/urlbar.ts
  function makeUrlbar(deps) {
    const { urlbar } = deps;
    const root = document.documentElement;
    const log = createLogger("urlbar");
    let activated = false;
    let intent = "current";
    let backdrop = null;
    function activateFloating(newIntent) {
      intent = newIntent;
      if (activated) {
        log("activateFloating:re-arm", { intent });
        root.setAttribute("pfx-urlbar-intent", intent === "newTab" ? "new-tab" : "current");
        return;
      }
      activated = true;
      log("activateFloating", { intent });
      root.setAttribute("pfx-urlbar-floating", "");
      root.setAttribute("pfx-urlbar-intent", intent === "newTab" ? "new-tab" : "current");
      if (!backdrop) {
        backdrop = document.createElement("div");
        backdrop.id = "pfx-urlbar-backdrop";
        backdrop.addEventListener("mousedown", () => deactivateFloating());
        root.appendChild(backdrop);
      }
      try {
        if (urlbar.getAttribute("popover") !== "manual") {
          urlbar.setAttribute("popover", "manual");
        }
        if (!urlbar.matches(":popover-open")) {
          urlbar.showPopover?.();
        }
        window.gURLBar?.focus?.();
        window.gURLBar?.select?.();
      } catch (e) {
        log("activateFloating:error", { msg: String(e) });
      }
    }
    function deactivateFloating() {
      if (!activated)
        return;
      activated = false;
      log("deactivateFloating");
      root.removeAttribute("pfx-urlbar-floating");
      root.removeAttribute("pfx-urlbar-intent");
      backdrop?.remove();
      backdrop = null;
      const compactVertical = !!document.querySelector("#sidebar-main[data-pfx-compact]");
      const compactHorizontal = root.hasAttribute("data-pfx-compact-horizontal");
      const compactOn = compactVertical || compactHorizontal;
      const breakout = urlbar.hasAttribute("breakout-extend");
      if (compactOn && !breakout) {
        try {
          if (urlbar.matches(":popover-open")) {
            urlbar.hidePopover?.();
          }
          urlbar.removeAttribute("popover");
        } catch (e) {
          log("deactivateFloating:popover-sync-error", { msg: String(e) });
        }
      }
    }
    function isFloating() {
      return activated;
    }
    function onFocusOut(_e) {
      if (!activated)
        return;
      setTimeout(() => {
        if (!activated)
          return;
        const a = document.activeElement;
        if (a && (a === urlbar || urlbar.contains(a)))
          return;
        deactivateFloating();
      }, 0);
    }
    function onKeydown(e) {
      const accel = e.ctrlKey || e.metaKey;
      if (accel && !e.shiftKey && !e.altKey) {
        const k = e.key;
        if (k === "j" || k === "k") {
          const view = window.gURLBar?.view;
          if (view?.selectBy) {
            e.preventDefault();
            e.stopImmediatePropagation();
            try {
              view.selectBy(k === "j" ? 1 : -1);
            } catch (err) {
              log("selectBy:error", { msg: String(err) });
            }
            return;
          }
        }
      }
      if (!activated)
        return;
      if (e.key === "Escape") {
        setTimeout(deactivateFloating, 0);
        return;
      }
      if (e.key === "Enter") {
        if (intent === "newTab" && !e.altKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          log("intercept:newTab-enter");
          const target = e.target;
          target.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            altKey: true,
            bubbles: true,
            cancelable: true,
            view: window
          }));
        }
        setTimeout(deactivateFloating, 0);
      }
    }
    function onActivateRequest(e) {
      const detail = e.detail;
      activateFloating(detail?.intent === "newTab" ? "newTab" : "current");
    }
    function onDeactivateRequest(_e) {
      deactivateFloating();
    }
    urlbar.addEventListener("focusout", onFocusOut, true);
    urlbar.addEventListener("keydown", onKeydown, true);
    document.addEventListener("pfx-urlbar-activate", onActivateRequest);
    document.addEventListener("pfx-urlbar-deactivate", onDeactivateRequest);
    function destroy() {
      urlbar.removeEventListener("focusout", onFocusOut, true);
      urlbar.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("pfx-urlbar-activate", onActivateRequest);
      document.removeEventListener("pfx-urlbar-deactivate", onDeactivateRequest);
      deactivateFloating();
    }
    return { activateFloating, deactivateFloating, isFloating, destroy };
  }

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
    const compact = makeCompact({
      sidebarMain,
      navigatorToolbox,
      urlbar
    });
    let urlbarApi = null;
    if (urlbar) {
      urlbarApi = makeUrlbar({ urlbar });
      document.addEventListener("keydown", (e) => {
        const accel = e.ctrlKey || e.metaKey;
        if (!accel || e.shiftKey || e.altKey)
          return;
        if (e.key !== "l" && e.key !== "L")
          return;
        urlbarApi?.activateFloating("current");
      }, true);
    }
    window.addEventListener("unload", () => {
      Services.prefs.removeObserver(DRAGGABLE_PREF, draggableObserver);
      compact.destroy();
      urlbarApi?.destroy();
    }, { once: true });
    const sidebarButton = document.getElementById("sidebar-button");
    if (sidebarButton) {
      let mi = function(id, label, onCommand) {
        const item = document.createXULElement("menuitem");
        item.id = id;
        item.setAttribute("label", label);
        item.addEventListener("command", onCommand);
        return item;
      };
      const ogIcon = sidebarButton.querySelector(".toolbarbutton-icon");
      const ogIconStyle = ogIcon ? getComputedStyle(ogIcon).listStyleImage : null;
      sidebarButton.style.display = "none";
      const pfxButton = document.createXULElement("toolbarbutton");
      pfxButton.id = "pfx-sidebar-button";
      pfxButton.className = sidebarButton.className;
      pfxButton.setAttribute("tooltiptext", "Toggle compact mode (right-click for more)");
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
        if (e.button !== 0)
          return;
        compact.toggle();
      });
      const pfxMenu = document.createXULElement("menupopup");
      pfxMenu.id = "pfx-sidebar-button-menu";
      const compactItem = mi("pfx-toggle-compact", "Enable Compact", () => compact.toggle());
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
      const sidebarItem = mi("pfx-toggle-sidebar", "Enable Sidebar", () => {
        try {
          const win = window;
          if (win.SidebarController?.toggle) {
            win.SidebarController.toggle();
            return;
          }
          if (win.SidebarUI?.toggle) {
            win.SidebarUI.toggle();
            return;
          }
          const cmd = document.getElementById("cmd_toggleSidebar");
          if (cmd?.doCommand) {
            cmd.doCommand();
            return;
          }
          console.error("[PFX:drawer] no sidebar-toggle API available");
        } catch (e) {
          console.error("[PFX:drawer] sidebar toggle failed", e);
        }
      });
      const layoutItem = mi("pfx-toggle-tab-layout", "Horizontal Tabs", () => {
        const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
        Services.prefs.setBoolPref("sidebar.verticalTabs", !vertical);
      });
      const customizeItem = mi("pfx-customize-sidebar", "Customize Sidebar", () => {
        try {
          const native = document.getElementById("toolbar-context-customize-sidebar");
          native?.doCommand?.() ?? native?.click?.();
        } catch (e) {
          console.error("palefox: customize sidebar failed", e);
        }
      });
      pfxMenu.append(compactItem, collapseItem, sidebarItem, layoutItem, document.createXULElement("menuseparator"), customizeItem);
      const popupSet = document.getElementById("mainPopupSet");
      popupSet?.appendChild(pfxMenu);
      pfxButton.setAttribute("context", "pfx-sidebar-button-menu");
      pfxMenu.addEventListener("popupshowing", () => {
        const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
        const isCompact = vertical ? compact.isCompactVertical() : compact.isCompactHorizontal();
        compactItem.setAttribute("label", isCompact ? "Disable Compact" : "Enable Compact");
        collapseItem.hidden = !vertical;
        if (vertical) {
          const expanded = sidebarMain.hasAttribute("sidebar-launcher-expanded");
          collapseItem.setAttribute("label", expanded ? "Collapse Layout" : "Expand Layout");
        }
        const sidebarOpen = window.SidebarController?.isOpen ?? (!sidebarMain.hidden && sidebarMain.getBoundingClientRect().width > 0);
        sidebarItem.setAttribute("label", sidebarOpen ? "Disable Sidebar" : "Enable Sidebar");
        layoutItem.setAttribute("label", vertical ? "Horizontal Tabs" : "Vertical Tabs");
        if (compact.isCompactVertical())
          compact.pinSidebar();
        if (compact.isCompactHorizontal())
          compact.pinToolbox();
      });
      pfxMenu.addEventListener("popuphidden", () => {
        compact.reconcile("pfxMenu:popuphidden");
        compact.reconcileHorizontal("pfxMenu:popuphidden");
      });
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
