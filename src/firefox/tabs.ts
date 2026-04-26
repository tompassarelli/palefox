// Firefox tab-operations adapter — example of the `src/firefox/*` blast-shield
// pattern (see docs/dev/firefox-upstream-stability.md).
//
// Goal: feature code imports typed primitives from here instead of touching
// `gBrowser` directly. When Firefox's tab API shifts (signature, semantics,
// or DOM hooks), we patch this file. Feature modules don't change.
//
// Manifest entry: "gBrowser tab ops" — see tools/firefox-canary.ts.
//
// Migration policy: existing call sites continue to use `gBrowser` directly
// for now — this is the pattern, not a mandatory rewrite. New code MUST
// route through `src/firefox/<adapter>.ts`. Existing call sites are migrated
// opportunistically when their containing module is touched.

import type { Tab } from "../tabs/types.ts";

// `gBrowser` and `Services` are typed via src/types/chrome.d.ts.

// =============================================================================
// INTERFACE
// =============================================================================

/** All tabs in the current chrome window, in their tab-strip order.
 *  Reads `gBrowser.tabs` — that array IS the source of truth; never maintain
 *  a parallel ordering. */
export function allTabs(): readonly Tab[] {
  return gBrowser.tabs;
}

/** The tab the user is currently looking at. */
export function selectedTab(): Tab {
  return gBrowser.selectedTab;
}

/** Switch the chrome window to show `tab`. */
export function selectTab(tab: Tab): void {
  gBrowser.selectedTab = tab;
}

/** Container element that emits `TabOpen` / `TabClose` / `TabSelect` /
 *  `TabMove` / `TabAttrModified` events. Use this as the listener target,
 *  not individual tabs. */
export function tabContainer(): HTMLElement {
  return gBrowser.tabContainer;
}

/** Pin / unpin. No-op if already in the requested state. Safe to call
 *  during event handlers — Firefox guards re-entrancy internally. */
export function pinTab(tab: Tab): void {
  if (!tab.pinned) gBrowser.pinTab(tab);
}
export function unpinTab(tab: Tab): void {
  if (tab.pinned) gBrowser.unpinTab(tab);
}
export function togglePinned(tab: Tab): void {
  if (tab.pinned) unpinTab(tab); else pinTab(tab);
}

/** Close `tab`. Triggers `TabClose` synchronously. */
export function removeTab(tab: Tab): void {
  gBrowser.removeTab(tab);
}

/** Duplicate `tab` (URL, history, scroll position) into a new tab. Returns
 *  the new tab. Triggers `TabOpen`. */
export function duplicateTab(tab: Tab): Tab {
  return gBrowser.duplicateTab(tab);
}

/** Reload `tab` from network. */
export function reloadTab(tab: Tab): void {
  gBrowser.reloadTab(tab);
}

/** Move `tab` to a new linear index in the tab strip. The new index is in
 *  the post-move coordinate space — same semantics as `Array.splice`. */
export function moveTabTo(tab: Tab, index: number): void {
  gBrowser.moveTabTo(tab, index);
}

/** Open a new tab loading `url`. Background by default — caller selects it
 *  via `selectTab(t)` if they want it foreground. */
export function openTab(url: string): Tab {
  return gBrowser.addTab(url, {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
}

/** Tab favicon URL, or null when Firefox hasn't fetched / cached one yet. */
export function tabIcon(tab: Tab): string | null {
  try {
    return gBrowser.getIcon(tab);
  } catch {
    return null;
  }
}
