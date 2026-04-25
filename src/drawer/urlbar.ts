// Floating urlbar — keyboard-driven command-palette style activation.
//
// Two activation paths converge here:
//   1. Ctrl+L (Cmd+L on macOS). Native Firefox already focuses the urlbar — we
//      add the floating decoration on top by listening to the same key in
//      capture phase WITHOUT preventDefault. We deliberately don't bind
//      Ctrl+K — too many web apps own that combo (Slack, etc.).
//   2. Palefox `o` / `O` keys (in src/tabs/vim.ts). They dispatch the
//      `pfx-urlbar-activate` CustomEvent on document; we handle it here.
//      `o` = current-tab intent, `O` = new-tab intent.
//
// Mouse-click on the in-sidebar urlbar is deliberately untouched. Users who
// want native breakout-extend at the click point still get it.
//
// Visual: when active, the urlbar floats fixed at top:22vh, left:50%,
// translateX(-50%), width:720px. CSS lives in palefox.css under #region
// floating urlbar. The popover="manual" attribute is set so the urlbar
// occupies the top layer and renders above #sidebar-main / browser content.
//
// Intent="newTab": Firefox's UrlbarInput already supports Alt+Enter to open
// a result in a new tab. We intercept Enter (without altKey) and re-dispatch
// it with altKey=true so the existing handler routes to a new tab. No URL
// parsing or search-engine routing needed on our side — Firefox owns it.

import { createLogger, type Logger } from "../tabs/log.ts";

declare const window: any;

// =============================================================================
// INTERFACE
// =============================================================================

export type UrlbarDeps = {
  urlbar: HTMLElement;
};

export type UrlbarIntent = "current" | "newTab";

export type UrlbarAPI = {
  /** Activate floating mode. Caller is responsible for a sensible intent.
   *  Idempotent — calling while active just updates the intent. */
  activateFloating(intent: UrlbarIntent): void;
  /** Tear down floating decoration. Called automatically on blur/Esc. */
  deactivateFloating(): void;
  /** True when floating decoration is currently applied. */
  isFloating(): boolean;
  /** Unwire all listeners. Call from window.unload. */
  destroy(): void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makeUrlbar(deps: UrlbarDeps): UrlbarAPI {
  const { urlbar } = deps;
  const root = document.documentElement;
  const log: Logger = createLogger("urlbar");

  let activated = false;
  let intent: UrlbarIntent = "current";
  let backdrop: HTMLElement | null = null;

  function activateFloating(newIntent: UrlbarIntent): void {
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
      // Top layer: use popover so the urlbar renders above sidebar / content,
      // immune to ancestor transforms (compact mode + horizontal both rely
      // on this same trick — see src/drawer/compact.ts).
      if (urlbar.getAttribute("popover") !== "manual") {
        urlbar.setAttribute("popover", "manual");
      }
      if (!urlbar.matches(":popover-open")) {
        (urlbar as unknown as { showPopover?(): void }).showPopover?.();
      }
      window.gURLBar?.focus?.();
      window.gURLBar?.select?.();
    } catch (e) {
      log("activateFloating:error", { msg: String(e) });
    }
  }

  function deactivateFloating(): void {
    if (!activated) return;
    activated = false;
    log("deactivateFloating");
    root.removeAttribute("pfx-urlbar-floating");
    root.removeAttribute("pfx-urlbar-intent");
    backdrop?.remove();
    backdrop = null;

    // Sync popover state with the rest of the app's expectations.
    //   - compact mode active (vertical or horizontal) AND breakout-extend off:
    //     compact wants popover removed so the urlbar follows the
    //     sidebar/toolbox transform (i.e. gets hidden along with it). If we
    //     leave popover="manual" set, the urlbar stays in the top layer with
    //     UA popover defaults, which renders as a stuck floating box.
    //   - breakout-extend on (urlbar still focused — common after Alt+Enter
    //     opens a background tab and keeps focus): leave popover alone, the
    //     urlbar should remain in the top layer for native breakout sizing.
    //   - compact off: leave alone (palefox's "default" for the urlbar is
    //     popover="manual" + showPopover, set by compactDisable).
    const compactVertical = !!document.querySelector("#sidebar-main[data-pfx-compact]");
    const compactHorizontal = root.hasAttribute("data-pfx-compact-horizontal");
    const compactOn = compactVertical || compactHorizontal;
    const breakout = urlbar.hasAttribute("breakout-extend");
    if (compactOn && !breakout) {
      try {
        if (urlbar.matches(":popover-open")) {
          (urlbar as unknown as { hidePopover?(): void }).hidePopover?.();
        }
        urlbar.removeAttribute("popover");
      } catch (e) {
        log("deactivateFloating:popover-sync-error", { msg: String(e) });
      }
    }
  }

  function isFloating(): boolean {
    return activated;
  }

  // Auto-deactivate when focus leaves the urlbar.
  // focusout fires before activeElement updates — defer one tick.
  function onFocusOut(_e: Event): void {
    if (!activated) return;
    setTimeout(() => {
      if (!activated) return;
      const a = document.activeElement;
      if (a && (a === urlbar || urlbar.contains(a))) return;
      deactivateFloating();
    }, 0);
  }

  function onKeydown(e: KeyboardEvent): void {
    // Ctrl+J / Ctrl+K → next/prev suggestion. Always-on (works in floating,
    // in-sidebar, and nav-bar urlbars). Synthetic ArrowDown/Up keydowns
    // were rejected — UrlbarView's input handler ignores untrusted events.
    // gURLBar.view.selectBy(±1) is the public method UrlbarView itself
    // calls in response to arrow keys; bypasses the trust gate.
    const accel = e.ctrlKey || e.metaKey;
    if (accel && !e.shiftKey && !e.altKey) {
      const k = e.key;
      if (k === "j" || k === "k") {
        const view = window.gURLBar?.view;
        if (view?.selectBy) {
          e.preventDefault();
          e.stopImmediatePropagation();
          try { view.selectBy(k === "j" ? 1 : -1); } catch (err) {
            log("selectBy:error", { msg: String(err) });
          }
          return;
        }
      }
    }

    if (!activated) return;
    if (e.key === "Escape") {
      // Let the urlbar's own Esc handler close the dropdown first; then we
      // strip our decoration on the next tick.
      setTimeout(deactivateFloating, 0);
      return;
    }
    if (e.key === "Enter") {
      if (intent === "newTab" && !e.altKey) {
        // Firefox's UrlbarInput maps altKey=true on Enter to "open in new tab"
        // (UrlbarInput.mjs::_whereToOpen). Re-dispatch with altKey=true so the
        // existing routing handles search engines, keyword bookmarks, etc.
        e.preventDefault();
        e.stopImmediatePropagation();
        log("intercept:newTab-enter");
        const target = e.target as HTMLElement;
        target.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          altKey: true,
          bubbles: true,
          cancelable: true,
          view: window,
        } as KeyboardEventInit));
      }
      // Always deactivate on Enter — relying on focusout is unreliable
      // because Alt+Enter (open in background tab) keeps the urlbar focused.
      // Defer one tick so the keydown commits first.
      setTimeout(deactivateFloating, 0);
    }
  }

  // Cross-bundle activation hook: src/tabs/vim.ts dispatches this on
  // document so the keymap code doesn't need a direct reference to us.
  function onActivateRequest(e: Event): void {
    const detail = (e as CustomEvent<{ intent?: UrlbarIntent }>).detail;
    activateFloating(detail?.intent === "newTab" ? "newTab" : "current");
  }

  function onDeactivateRequest(_e: Event): void {
    deactivateFloating();
  }

  urlbar.addEventListener("focusout", onFocusOut, true);
  urlbar.addEventListener("keydown", onKeydown, true);
  document.addEventListener("pfx-urlbar-activate", onActivateRequest);
  document.addEventListener("pfx-urlbar-deactivate", onDeactivateRequest);

  function destroy(): void {
    urlbar.removeEventListener("focusout", onFocusOut, true);
    urlbar.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("pfx-urlbar-activate", onActivateRequest);
    document.removeEventListener("pfx-urlbar-deactivate", onDeactivateRequest);
    deactivateFloating();
  }

  return { activateFloating, deactivateFloating, isFloating, destroy };
}
