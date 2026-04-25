// Ambient declarations for the Mozilla chrome scripting environment.
//
// fx-autoconfig loads .uc.js files into the Firefox browser window's privileged
// chrome scope, where these globals are available without import. We declare
// them as `any` for now — the priority is unblocking type-checking on real
// code, not modeling the entire XPCOM/JS-component world. Tighten specific
// shapes here as palefox files surface footguns we'd like the checker to catch.

export {};

declare global {
  // XPCOM accessors (Components shorthand).
  const Cc: any;
  const Ci: any;
  const Cu: any;

  // Service singletons.
  const Services: any;
  const ChromeUtils: any;

  // File / path I/O (chrome-only fast IO modules).
  const IOUtils: any;
  const PathUtils: any;

  // Browser singletons / well-known objects exposed in browser.xhtml.
  const gBrowser: any;
  const gBrowserInit: any;
  const gURLBar: any;
  const gNavToolbox: any;

  // Session restore + tab metadata persistence.
  const SessionStore: any;

  // Native context menus we sometimes piggyback on.
  const TabContextMenu: any;

  // Various global helpers exposed by browser components.
  const PlacesCommandHook: any;
  const FirefoxViewHandler: any;

  // Firefox WebExtension API surface — only available in some contexts; here
  // we type it loosely so palefox code can opportunistically reach for it.
  const browser: any;

  // XUL element factories live on Document in the chrome scope.
  interface Document {
    createXULElement(tag: string): any;
  }

  // Palefox decorates DOM elements (the rows it builds) with these private
  // refs. Typing them as optional on every Element lets the legacy index.ts
  // walk siblings/children without per-call casts. Real Row construction
  // still goes through src/tabs/types.ts → Row.
  interface Element {
    _tab?: import("../tabs/types.ts").Tab;
    _group?: import("../tabs/types.ts").Group;
    /** All the XUL/HTML elements palefox touches are HTMLElement-shaped — they
     *  have `hidden`, `style`, `isContentEditable`, etc. The DOM lib types
     *  Element more strictly; this augmentation matches our runtime reality
     *  and avoids casting at every sibling-walk site. */
    hidden?: boolean;
    isContentEditable?: boolean;
  }

  // Test-only debug API. Only present when `pfx.test.exposeAPI` pref is
  // true (set in test-profile user.js by tools/test-driver/profile.ts).
  // Production builds never expose this. Typed as `any` because the
  // surface is intentionally fluid; tests assert on shape themselves.
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pfxTest?: any;
  }
}
