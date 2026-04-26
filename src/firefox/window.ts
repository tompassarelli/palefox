// Firefox chrome-window adapter — well-known IDs, startup signals, system
// principal, ESM loader.
//
// Manifest entries: "Well-known chrome IDs" (Tier 1), "ChromeUtils.importESModule"
// (Tier 1, stable). Centralizing the ID lookups means a sidebar-revamp-style
// rename only changes this file.

// `gBrowserInit`, `Services`, `ChromeUtils` are typed via src/types/chrome.d.ts.

// =============================================================================
// INTERFACE
// =============================================================================

/** Chrome elements palefox depends on. Single seam for any future Firefox
 *  rename — change here, not at every callsite. Returns null when an
 *  element doesn't exist (e.g. on a Firefox build that's removed it). */
export const ids = {
  sidebarMain: () => document.getElementById("sidebar-main"),
  navigatorToolbox: () => document.getElementById("navigator-toolbox"),
  urlbar: () => document.getElementById("urlbar"),
  urlbarContainer: () => document.getElementById("urlbar-container"),
  navBar: () => document.getElementById("nav-bar"),
  tabsToolbar: () => document.getElementById("TabsToolbar"),
  tabsToolbarTarget: () => document.getElementById("TabsToolbar-customization-target"),
  tabbrowserTabs: () => document.getElementById("tabbrowser-tabs"),
  mainPopupSet: () => document.getElementById("mainPopupSet"),
  unifiedExtensionsButton: () => document.getElementById("unified-extensions-button"),
  sidebarButton: () => document.getElementById("sidebar-button"),
};

/** Resolves true once the chrome window has finished its delayed startup —
 *  the right moment to register listeners that depend on `gBrowser` being
 *  fully wired. Used by orchestrators in src/tabs/index.ts and
 *  src/drawer/index.ts. */
export function delayedStartupFinished(): boolean {
  return gBrowserInit.delayedStartupFinished;
}

/** System principal for chrome-side tab opens (`gBrowser.addTab(url, { triggeringPrincipal })`).
 *  Cached — calling it many times during a burst of tab opens has no cost. */
let cachedSystemPrincipal: unknown;
export function systemPrincipal(): unknown {
  if (cachedSystemPrincipal === undefined) {
    cachedSystemPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
  }
  return cachedSystemPrincipal;
}

/** Synchronously load a chrome / resource ESM. Used by history.ts to get
 *  the SQLite module. Wrapper so the canary's manifest entry has one owner.
 *  Note: returns the module's namespace object; callers destructure. */
export function importESM<T extends Record<string, unknown> = Record<string, unknown>>(url: string): T {
  return ChromeUtils.importESModule(url) as T;
}
