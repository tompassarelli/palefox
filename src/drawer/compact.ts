// Compact mode — autohide chrome surfaces, reveal on hover.
//
// Two parallel modes share one state machine:
//   - Vertical   (sidebar.verticalTabs=true)  → #sidebar-main hides off-screen
//   - Horizontal (sidebar.verticalTabs=false) → #navigator-toolbox hides upward
//
// State model (inverted from naive show/hide):
//   data-pfx-compact / data-pfx-compact-horizontal present → CSS hides target
//   pfx-has-hover present                                  → CSS shows target
//   No pfx-has-hover                                       → hidden
//
// This eliminates race conditions: enabling compact just sets the attribute.
// The element is immediately hidden because pfx-has-hover is absent. Showing
// requires explicitly ADDING pfx-has-hover. See docs/dev/compact-mode-dissertation.md
// for the full state-machine analysis comparing this to Zen and Firefox native.
//
// Public API (CompactAPI): toggle(), reconcile()/reconcileHorizontal(),
// flashSidebar()/flashToolbox(), pin/unpin during external popups, destroy().
//
// Wires its own listeners (popups, mouseenter/leave, sizemodechange, blur)
// and pref observers (pfx.sidebar.compact, pfx.toolbar.compact,
// sidebar.verticalTabs). destroy() unwires everything for clean window unload.

import { createLogger, type Logger } from "../tabs/log.ts";


// =============================================================================
// INTERFACE
// =============================================================================

export type CompactDeps = {
  sidebarMain: HTMLElement;
  navigatorToolbox: HTMLElement;
  urlbar: HTMLElement | null;
};

export type CompactAPI = {
  /** Toggle compact for whichever mode is currently active (per sidebar.verticalTabs). */
  toggle(): void;
  /** Force a reconcile pass for vertical mode. Used after external popups close. */
  reconcile(trigger: string): void;
  /** Force a reconcile pass for horizontal mode. Used after external popups close. */
  reconcileHorizontal(trigger: string): void;
  /** Pin the sidebar visible while an external popup is open (vertical mode). */
  pinSidebar(): void;
  /** Pin the toolbox visible while an external popup is open (horizontal mode). */
  pinToolbox(): void;
  /** Cheap attribute reads for menu state — caller doesn't need to know which attribute. */
  isCompactVertical(): boolean;
  isCompactHorizontal(): boolean;
  /** Tear down all listeners, observers, timers. Call from window.unload. */
  destroy(): void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makeCompact(deps: CompactDeps): CompactAPI {
  const { sidebarMain, navigatorToolbox, urlbar } = deps;

  // === Constants ===

  const COMPACT_PREF = "pfx.sidebar.compact";
  const HORIZONTAL_COMPACT_PREF = "pfx.toolbar.compact";

  // Match Zen's defaults exactly so the feel transfers.
  // - keepHoverDuration  (zen.view.compact.sidebar-keep-hover.duration)
  const KEEP_HOVER_DURATION = 150;
  // After an off-screen / strip trigger, schedule auto-hide after this long.
  // Cancelled by the cursor entering the surface. Matches Zen's
  // `zen.view.compact.toolbar-hide-after-hover.duration` (1000ms default).
  const OFFSCREEN_SHOW_DURATION = 1000;
  // Matches Zen's `zen.view.compact.toolbar-flash-popup.duration` (800ms).
  // Dispatched via `sidebarMain.dispatchEvent(new CustomEvent("pfx-flash"))`.
  const FLASH_DURATION = 800;
  // Once collapse is committed, block reveal attempts until the close animation
  // finishes. Matches CSS --pfx-transition-duration (250ms) plus a small margin.
  const COLLAPSE_PROTECTION_DURATION = 280;

  // Wayland / X11 spurious-mouseleave debounce. Wraps the per-tick :hover check
  // in setTimeout(_, hoverHackDelay()) so users on flaky compositors can tune.
  // Zen pref equivalent: zen.view.compact.hover-hack-delay (default 0).
  function hoverHackDelay(): number {
    return Services.prefs.getIntPref("pfx.compact.hoverHackDelay", 0);
  }

  // === Logging ===
  // Shared logger writes timestamped lines to <profile>/palefox-debug.log
  // when pfx.debug is true. Cheap no-op when off.

  const log: Logger = createLogger("compact");
  function dbg(event: string, data: Record<string, unknown> = {}): void {
    // Auto-payload reads only cheap attributes / scalars. NEVER call isGuarded()
    // here — it would recurse via reconcileCounterIfStale → dbg.
    log(event, {
      compact: sidebarMain.hasAttribute("data-pfx-compact"),
      compactHz: document.documentElement.hasAttribute("data-pfx-compact-horizontal"),
      hover: sidebarMain.hasAttribute("pfx-has-hover"),
      hoverHz: navigatorToolbox.hasAttribute("pfx-has-hover"),
      openPopups: _openPopups,
      flashPending: flashTimer !== null,
      ...data,
    });
  }

  // === Module state ===

  // Vertical
  let hoverStrip: HTMLElement | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let urlbarCompactObserver: MutationObserver | null = null;
  let _collapseProtectedUntil = 0;
  let hideWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

  // Horizontal
  let hoverStripTop: HTMLElement | null = null;
  let _hzFlashTimer: ReturnType<typeof setTimeout> | null = null;
  let urlbarCompactObserverHz: MutationObserver | null = null;
  let _collapseProtectedHzUntil = 0;
  let hideWatchdogTimerHz: ReturnType<typeof setTimeout> | null = null;

  // Shared
  // Blocks hover-triggered show during and immediately after compactToggle().
  // Zen equivalent: _ignoreNextHover (ZenCompactMode.mjs:623)
  let _ignoreNextHover = false;
  // Counter fed by document-wide popupshown/popuphidden. Treat as a hint;
  // reconcile from DOM at hide-time to catch leaks (P1 in dissertation).
  let _openPopups = 0;

  // === Popup detection ===

  function _isIgnoredPopup(e: Event): boolean {
    const path = (e as any).composedPath?.();
    const el: Element = path?.[0] ?? (e.target as Element);
    return el.localName === "tooltip" || el.id === "tab-preview-panel";
  }

  function onPopupShown(e: Event): void {
    if (_isIgnoredPopup(e)) return;
    _openPopups++;
    const t = e.target as Element;
    dbg("popupshown", { id: t.id, tag: t.localName, _openPopups });
  }

  function onPopupHidden(e: Event): void {
    if (_isIgnoredPopup(e)) return;
    _openPopups = Math.max(0, _openPopups - 1);
    const t = e.target as Element;
    dbg("popuphidden", { id: t.id, tag: t.localName, _openPopups });
  }

  // Hide-time backstop: counter elevated but no popup actually rendered → reset.
  function reconcileCounterIfStale(): void {
    if (_openPopups <= 0) return;
    const live = document.querySelector(
      "panel[panelopen='true'], panel[open='true'], " +
      "menupopup[state='open'], menupopup[state='showing'], " +
      "menupopup[open='true']"
    );
    if (!live) {
      dbg("reconcileCounterIfStale:reset", { stale: _openPopups });
      _openPopups = 0;
    }
  }

  function isGuarded(): boolean {
    if (_openPopups > 0) return true;
    if (urlbar?.hasAttribute("breakout-extend")) return true;
    if (document.querySelector("toolbarbutton[open='true']")) return true;
    if (document.querySelector(".tabbrowser-tab[multiselected]")) return true;
    if (document.querySelector("[pfx-dragging]")) return true;
    return false;
  }

  // === Vertical: setHover / flash / reconcile ===

  function setHover(value: boolean): void {
    dbg("setHover", {
      value,
      collapseProtectedRemaining: Math.max(0, _collapseProtectedUntil - Date.now()),
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

  function flashSidebar(duration: number): void {
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

  function clearFlash(): void {
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = null;
  }

  function reconcileCompactState(trigger: string): void {
    if (!sidebarMain.hasAttribute("data-pfx-compact")) return;
    const before = {
      hover: sidebarMain.hasAttribute("pfx-has-hover"),
      flashPending: flashTimer !== null,
      _ignoreNextHover,
      _openPopups,
    };
    _ignoreNextHover = false;
    reconcileCounterIfStale();
    const cursorOver = sidebarMain.matches(":hover")
      || (hoverStrip?.matches(":hover") ?? false);
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
      trigger, before, cursorOver, guarded,
      after: {
        hover: sidebarMain.hasAttribute("pfx-has-hover"),
        flashPending: flashTimer !== null,
        _ignoreNextHover,
      },
    });
  }

  function scheduleHideWatchdog(): void {
    if (hideWatchdogTimer) return;
    hideWatchdogTimer = setTimeout(() => {
      hideWatchdogTimer = null;
      reconcileCompactState("hide-watchdog-1s");
    }, 1000);
  }

  function cancelHideWatchdog(): void {
    if (hideWatchdogTimer) {
      clearTimeout(hideWatchdogTimer);
      hideWatchdogTimer = null;
    }
  }

  // === Horizontal: setToolboxHover / flashToolbox / reconcileHorizontal ===

  function setToolboxHover(value: boolean): void {
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

  function flashToolbox(duration: number): void {
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

  function clearFlashToolbox(): void {
    if (_hzFlashTimer) clearTimeout(_hzFlashTimer);
    _hzFlashTimer = null;
  }

  function reconcileCompactStateHorizontal(trigger: string): void {
    if (!document.documentElement.hasAttribute("data-pfx-compact-horizontal")) return;
    const before = {
      hover: navigatorToolbox.hasAttribute("pfx-has-hover"),
      flashPending: _hzFlashTimer !== null,
      _ignoreNextHover,
      _openPopups,
    };
    _ignoreNextHover = false;
    reconcileCounterIfStale();
    const cursorOver = navigatorToolbox.matches(":hover")
      || (hoverStripTop?.matches(":hover") ?? false);
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
      trigger, before, cursorOver, guarded,
      after: {
        hover: navigatorToolbox.hasAttribute("pfx-has-hover"),
        flashPending: _hzFlashTimer !== null,
        _ignoreNextHover,
      },
    });
  }

  function scheduleHideWatchdogHz(): void {
    if (hideWatchdogTimerHz) return;
    hideWatchdogTimerHz = setTimeout(() => {
      hideWatchdogTimerHz = null;
      reconcileCompactStateHorizontal("hide-watchdog-1s-hz");
    }, 1000);
  }

  function cancelHideWatchdogHz(): void {
    if (hideWatchdogTimerHz) {
      clearTimeout(hideWatchdogTimerHz);
      hideWatchdogTimerHz = null;
    }
  }

  // === Event handlers (mouse) ===

  function onSidebarEnter(event: MouseEvent): void {
    const target = event.target as Element;
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
      // A confirmed `:hover` after the hoverHackDelay tick is *evidence of
      // user intent* — they came back. Cancel any in-flight collapse
      // protection so the reveal isn't dropped under our feet. The
      // protection exists to suppress *spurious / programmatic* reveals
      // mid-collapse (Wayland mouseleave bug, programmatic pfx-flash);
      // it should NOT block a genuine cursor return. Without this the
      // user sees a "lockout" — the sidebar stays hidden until they move
      // out and back in slowly enough to land after the protection window.
      if (_collapseProtectedUntil > Date.now()) {
        dbg("onSidebarEnter:cancel-collapse-protection", {
          remainingMs: _collapseProtectedUntil - Date.now(),
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

  function onSidebarLeave(event: MouseEvent): void {
    const target = event.target as Element;
    const targetId = target.id || target.localName;
    // exitedWindow=true → cursor left the window entirely; longer linger so
    // user has time to come back. False → moved into content; short linger.
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

  function onDocMouseLeave(e: MouseEvent): void {
    if (!sidebarMain.hasAttribute("data-pfx-compact")) return;
    if (sidebarMain.hasAttribute("pfx-has-hover")) return;
    if (_ignoreNextHover) return;
    // Only trigger near the edge the sidebar is anchored to (mirrored when
    // sidebar.position_start flips from left → right).
    const triggerWidth = parseInt(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--pfx-compact-trigger-width") || "8",
      10,
    );
    const onLeft = Services.prefs.getBoolPref("sidebar.position_start", true);
    const nearEdge = onLeft
      ? e.clientX <= triggerWidth * 3
      : e.clientX >= window.innerWidth - triggerWidth * 3;
    if (!nearEdge) return;
    dbg("onDocMouseLeave:show", { clientX: e.clientX, onLeft });
    flashSidebar(OFFSCREEN_SHOW_DURATION);
  }

  function onToolboxEnter(event: MouseEvent): void {
    const target = event.target as Element;
    setTimeout(() => {
      if (!target.matches(":hover")) return;
      if (target.closest("panel")) return;
      clearFlashToolbox();
      // Confirmed cursor return — cancel collapse protection so the reveal
      // isn't dropped. Same rationale as onSidebarEnter; see that function
      // for the long form.
      if (_collapseProtectedHzUntil > Date.now()) {
        _collapseProtectedHzUntil = 0;
      }
      requestAnimationFrame(() => {
        if (_ignoreNextHover) return;
        if (navigatorToolbox.hasAttribute("pfx-has-hover")) return;
        setToolboxHover(true);
      });
    }, hoverHackDelay());
  }

  function onToolboxLeave(event: MouseEvent): void {
    const target = event.target as Element;
    const exitedWindow = !event.relatedTarget;
    const lingerMs = exitedWindow ? OFFSCREEN_SHOW_DURATION : KEEP_HOVER_DURATION;
    setTimeout(() => {
      if (target.matches(":hover")) return;
      if (_ignoreNextHover) return;
      if (isGuarded()) return;
      flashToolbox(lingerMs);
    }, hoverHackDelay());
  }

  function onDocMouseLeaveTop(e: MouseEvent): void {
    if (!document.documentElement.hasAttribute("data-pfx-compact-horizontal")) return;
    if (navigatorToolbox.hasAttribute("pfx-has-hover")) return;
    if (_ignoreNextHover) return;
    const triggerHeight = parseInt(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--pfx-compact-trigger-width") || "8",
      10,
    );
    if (e.clientY > triggerHeight * 3) return;
    dbg("onDocMouseLeaveTop:show", { clientY: e.clientY });
    flashToolbox(OFFSCREEN_SHOW_DURATION);
  }

  // === Enable / Disable per mode ===

  function compactEnable(): void {
    dbg("compactEnable");
    sidebarMain.setAttribute("data-pfx-compact", "");

    // Urlbar has popover="manual" → CSS top layer, immune to ancestor transforms.
    // Remove popover so the urlbar moves with the sidebar's transform; restore
    // it during breakout so the dropdown renders above everything.
    if (urlbar && !urlbarCompactObserver) {
      urlbar.removeAttribute("popover");
      urlbarCompactObserver = new MutationObserver(() => {
        if (!sidebarMain.hasAttribute("data-pfx-compact")) return;
        // Floating urlbar lives in its own top layer with popover state
        // owned by src/drawer/urlbar.ts. Bail so we don't fight it.
        if (document.documentElement.hasAttribute("pfx-urlbar-floating")) return;
        if (urlbar.hasAttribute("breakout-extend")) {
          dbg("urlbar:breakout-open");
          urlbar.setAttribute("popover", "manual");
          if (!urlbar.matches(":popover-open")) (urlbar as any).showPopover();
        } else {
          // breakout-close = user dismissed the urlbar (Enter / Esc / click-out).
          // Whether this counts as a "close-type" event depends on the cursor:
          //   - cursor in sidebar OR hover-strip → user is still interacting
          //     with the sidebar; just unwind popover and let hover state
          //     continue (existing mouseleave logic will close it later)
          //   - cursor outside the hover area → genuine close. Cancel any
          //     pending flash, drop hover, set collapse-protection so
          //     subsequent reveal triggers are blocked for ~280ms.
          // Previously we called flashSidebar(150) here on the no-hover path,
          // which revealed the sidebar after Ctrl+L → type → Enter from content.
          dbg("urlbar:breakout-close");
          urlbar.removeAttribute("popover");
          const cursorOver = sidebarMain.matches(":hover")
            || (hoverStrip?.matches(":hover") ?? false);
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
        attributeFilter: ["breakout-extend"],
      });
    }

    if (!hoverStrip || !hoverStrip.isConnected) {
      hoverStrip = (document as any).createXULElement("box") as HTMLElement;
      hoverStrip.id = "pfx-hover-strip";
      sidebarMain.parentNode!.appendChild(hoverStrip);
      hoverStrip.addEventListener("mouseenter", () => {
        dbg("hoverStrip:mouseenter", {
          _ignoreNextHover, flashPending: flashTimer !== null,
          hasHover: sidebarMain.hasAttribute("pfx-has-hover"),
        });
        if (_ignoreNextHover) {
          dbg("hoverStrip:abort", { reason: "ignore-next-hover-sync" });
          return;
        }
        flashSidebar(OFFSCREEN_SHOW_DURATION);
      });
    }

    sidebarMain.addEventListener("mouseover", onSidebarEnter as EventListener);
    sidebarMain.addEventListener("mouseleave", onSidebarLeave as EventListener);
    document.documentElement.addEventListener("mouseleave", onDocMouseLeave as EventListener);
  }

  function compactDisable(): void {
    dbg("compactDisable");
    clearFlash();
    cancelHideWatchdog();
    sidebarMain.removeAttribute("data-pfx-compact");
    sidebarMain.removeAttribute("pfx-has-hover");

    urlbarCompactObserver?.disconnect();
    urlbarCompactObserver = null;

    if (urlbar) {
      urlbar.setAttribute("popover", "manual");
      if (!urlbar.matches(":popover-open")) (urlbar as any).showPopover();
    }

    if (hoverStrip) {
      hoverStrip.remove();
      hoverStrip = null;
    }

    sidebarMain.removeEventListener("mouseover", onSidebarEnter as EventListener);
    sidebarMain.removeEventListener("mouseleave", onSidebarLeave as EventListener);
    document.documentElement.removeEventListener("mouseleave", onDocMouseLeave as EventListener);
  }

  function compactEnableHorizontal(): void {
    if (document.documentElement.hasAttribute("data-pfx-compact-horizontal")) return;
    dbg("compactEnableHorizontal");
    document.documentElement.setAttribute("data-pfx-compact-horizontal", "");

    if (urlbar && !urlbarCompactObserverHz) {
      urlbar.removeAttribute("popover");
      urlbarCompactObserverHz = new MutationObserver(() => {
        if (!document.documentElement.hasAttribute("data-pfx-compact-horizontal")) return;
        // Floating urlbar owns popover state — see src/drawer/urlbar.ts.
        // Without this bail, breakout-close on Enter strips popover before
        // urlbar.ts removes the floating attr, so during one frame the
        // still-pinned urlbar (top:22vh) is interpreted relative to the
        // navigator-toolbox's translateY(-100%) transform → ~200px upward
        // shift visible until deactivate fires. Vertical's observer has the
        // same bail; we'd missed it here because translateX hides the bug.
        if (document.documentElement.hasAttribute("pfx-urlbar-floating")) return;
        if (urlbar.hasAttribute("breakout-extend")) {
          urlbar.setAttribute("popover", "manual");
          if (!urlbar.matches(":popover-open")) (urlbar as any).showPopover();
        } else {
          urlbar.removeAttribute("popover");
        }
      });
      urlbarCompactObserverHz.observe(urlbar, {
        attributes: true,
        attributeFilter: ["breakout-extend"],
      });
    }

    if (!hoverStripTop || !hoverStripTop.isConnected) {
      hoverStripTop = (document as any).createXULElement("box") as HTMLElement;
      hoverStripTop.id = "pfx-hover-strip-top";
      document.documentElement.appendChild(hoverStripTop);
      hoverStripTop.addEventListener("mouseenter", () => {
        if (_ignoreNextHover) return;
        flashToolbox(OFFSCREEN_SHOW_DURATION);
      });
    }

    navigatorToolbox.addEventListener("mouseover", onToolboxEnter as EventListener);
    navigatorToolbox.addEventListener("mouseleave", onToolboxLeave as EventListener);
    document.documentElement.addEventListener("mouseleave", onDocMouseLeaveTop as EventListener);
  }

  function compactDisableHorizontal(): void {
    if (!document.documentElement.hasAttribute("data-pfx-compact-horizontal")) return;
    dbg("compactDisableHorizontal");
    clearFlashToolbox();
    cancelHideWatchdogHz();
    document.documentElement.removeAttribute("data-pfx-compact-horizontal");
    navigatorToolbox.removeAttribute("pfx-has-hover");

    urlbarCompactObserverHz?.disconnect();
    urlbarCompactObserverHz = null;
    if (urlbar) {
      urlbar.setAttribute("popover", "manual");
      if (!urlbar.matches(":popover-open")) (urlbar as any).showPopover();
    }

    if (hoverStripTop) {
      hoverStripTop.remove();
      hoverStripTop = null;
    }

    navigatorToolbox.removeEventListener("mouseover", onToolboxEnter as EventListener);
    navigatorToolbox.removeEventListener("mouseleave", onToolboxLeave as EventListener);
    document.documentElement.removeEventListener("mouseleave", onDocMouseLeaveTop as EventListener);
  }

  function compactToggle(): void {
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
        // F-B: safety timer + transitionend both funnel through reconcile so
        // post-transition state is coherent. See dissertation.
        const safetyTimer = setTimeout(
          () => reconcileCompactState("safety-timer-400ms"),
          400,
        );
        sidebarMain.addEventListener("transitionend", function onTransitionEnd(e) {
          if (e.target !== sidebarMain || (e as TransitionEvent).propertyName !== "transform") return;
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
        const safetyTimer = setTimeout(
          () => reconcileCompactStateHorizontal("safety-timer-400ms-hz"),
          400,
        );
        navigatorToolbox.addEventListener("transitionend", function onTransitionEnd(e) {
          if (e.target !== navigatorToolbox || (e as TransitionEvent).propertyName !== "transform") return;
          navigatorToolbox.removeEventListener("transitionend", onTransitionEnd);
          clearTimeout(safetyTimer);
          reconcileCompactStateHorizontal("transitionend-transform-hz");
        });
      }
    }
  }

  // === Mode application + pref observers ===

  function applyCompactForCurrentMode(): void {
    const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
    if (vertical) {
      if (Services.prefs.getBoolPref(COMPACT_PREF, false)
          && !sidebarMain.hasAttribute("data-pfx-compact")) {
        compactEnable();
      }
    } else {
      if (Services.prefs.getBoolPref(HORIZONTAL_COMPACT_PREF, false)
          && !document.documentElement.hasAttribute("data-pfx-compact-horizontal")) {
        compactEnableHorizontal();
      }
    }
  }

  // Each pref observer is a no-op when its mode isn't active (saved for later).
  const compactObserver = {
    observe(): void {
      const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
      if (!vertical) return;
      const enabled = Services.prefs.getBoolPref(COMPACT_PREF, false);
      const active = sidebarMain.hasAttribute("data-pfx-compact");
      if (enabled && !active) compactEnable();
      else if (!enabled && active) compactDisable();
    },
  };

  const compactObserverHz = {
    observe(): void {
      const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
      if (vertical) return;
      const enabled = Services.prefs.getBoolPref(HORIZONTAL_COMPACT_PREF, false);
      const active = document.documentElement.hasAttribute("data-pfx-compact-horizontal");
      if (enabled && !active) compactEnableHorizontal();
      else if (!enabled && active) compactDisableHorizontal();
    },
  };

  // Tear down outgoing mode, apply incoming pref. Avoids dangling state.
  const verticalTabsObserver = {
    observe(): void {
      const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
      dbg("verticalTabs:change", { vertical });
      if (vertical) compactDisableHorizontal();
      else compactDisable();
      applyCompactForCurrentMode();
    },
  };

  // === External-event listeners (script-dispatched + window-level) ===

  // Other scripts can dismiss the sidebar by dispatching "pfx-dismiss".
  function onPfxDismiss(): void {
    _ignoreNextHover = true;
    setHover(false);
    clearFlash();
    setTimeout(() => { _ignoreNextHover = false; }, KEEP_HOVER_DURATION + 100);
  }

  // Other scripts can flash the sidebar visible by dispatching "pfx-flash".
  function onPfxFlash(): void {
    if (!sidebarMain.hasAttribute("data-pfx-compact")) return;
    flashSidebar(FLASH_DURATION);
  }

  function onSizemodeChange(): void {
    reconcileCompactState("sizemodechange");
  }

  function onWindowBlur(e: FocusEvent): void {
    // The blur event bubbles from any focused element. Only react when the
    // window itself is the target — otherwise we'd reconcile dozens of times
    // per second of user activity, repeatedly clearing pfx-has-hover.
    if (e.target !== window) return;
    reconcileCompactState("window-blur");
  }

  // === Wire it all up ===

  document.addEventListener("popupshown", onPopupShown);
  document.addEventListener("popuphidden", onPopupHidden);
  sidebarMain.addEventListener("pfx-dismiss", onPfxDismiss);
  sidebarMain.addEventListener("pfx-flash", onPfxFlash);
  window.addEventListener("sizemodechange", onSizemodeChange);
  window.addEventListener("blur", onWindowBlur as EventListener);

  Services.prefs.addObserver(COMPACT_PREF, compactObserver);
  Services.prefs.addObserver(HORIZONTAL_COMPACT_PREF, compactObserverHz);
  Services.prefs.addObserver("sidebar.verticalTabs", verticalTabsObserver);

  applyCompactForCurrentMode();

  // === Public API ===

  function pinSidebar(): void {
    sidebarMain.setAttribute("pfx-has-hover", "true");
    clearFlash();
  }

  function pinToolbox(): void {
    navigatorToolbox.setAttribute("pfx-has-hover", "true");
    clearFlashToolbox();
  }

  function destroy(): void {
    document.removeEventListener("popupshown", onPopupShown);
    document.removeEventListener("popuphidden", onPopupHidden);
    sidebarMain.removeEventListener("pfx-dismiss", onPfxDismiss);
    sidebarMain.removeEventListener("pfx-flash", onPfxFlash);
    window.removeEventListener("sizemodechange", onSizemodeChange);
    window.removeEventListener("blur", onWindowBlur as EventListener);
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
    destroy,
  };
}
