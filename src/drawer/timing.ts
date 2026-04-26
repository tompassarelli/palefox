// Animation timings — single source of truth, mirrored from CSS so JS
// state machines stay in sync with the visual animation.
//
// Don't hardcode duration constants in feature modules; import from here.
// CSS owns the value (`--pfx-transition-duration` in palefox.css); this
// file reads it back. Bumping the CSS value automatically updates every
// JS path that gates on it (collapse-protection, transitionend safety
// timers, etc.). The fallbacks below are only used if computed style
// isn't yet available (very early in init, before the stylesheet loads).

const FALLBACK_TRANSITION_MS = 250;

/** Read `--pfx-transition-duration` from `:root` and parse to ms. */
export function transitionDurationMs(): number {
  try {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--pfx-transition-duration").trim();
    const ms = raw.endsWith("ms") ? parseFloat(raw)
      : raw.endsWith("s") ? parseFloat(raw) * 1000
      : NaN;
    return Number.isFinite(ms) && ms > 0 ? ms : FALLBACK_TRANSITION_MS;
  } catch {
    return FALLBACK_TRANSITION_MS;
  }
}

/** Small grace period beyond the close animation; gives the browser a
 *  paint frame to settle before we trust state again. */
export const COLLAPSE_PROTECTION_MARGIN_MS = 30;

/** How long to block reveal attempts after a close commits. Tracks the
 *  CSS transition + a small margin. Used by the compact-mode state
 *  machine and anything else that needs to know "is the close animation
 *  still running." */
export function collapseProtectionDurationMs(): number {
  return transitionDurationMs() + COLLAPSE_PROTECTION_MARGIN_MS;
}
