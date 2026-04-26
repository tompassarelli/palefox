// Ambient declarations for the Mozilla chrome scripting environment.
//
// These are the chrome globals that fx-autoconfig exposes inside palefox's
// privileged scope. The high-traffic ones are typed from real palefox use
// (every method here is reached for by some adapter or feature module);
// the long tail stays `any` until a specific call site benefits from
// tighter checking.
//
// Maintenance protocol: when you write a new adapter that touches a
// chrome global method NOT yet typed here, ADD the method here rather
// than locally `declare const X: { ... }` in the adapter. The whole
// point of having one ambient declaration is consistency across files.
//
// Types referenced from src/tabs/types.ts are imported via TS's
// `import("...")` syntax — keeps this file declaration-only and avoids
// polluting the runtime module graph.

export {};

declare global {
  // ============================================================
  // XPCOM
  // ============================================================

  /** XPCOM component classes registry. Used as `Cc["@..."]
   *  .createInstance(Ci.nsXyz)` and `.getService(Ci.nsXyz)`. Loose-typed for
   *  now — concrete shapes are nsIID-keyed which TS can't model usefully
   *  without per-CID maps. */
  const Cc: {
    readonly [contractId: string]: {
      createInstance(iface: unknown): unknown;
      getService(iface: unknown): unknown;
    };
  };

  /** XPCOM interface registry. Used as `Ci.nsIFile`, `Ci.nsIWebNavigation`,
   *  etc. Each member is a marker token, not an instance. */
  const Ci: { readonly [name: string]: unknown };

  /** Components.utils — chrome-only utility namespace, mostly for legacy
   *  chrome use. New code prefers ChromeUtils. */
  const Cu: { readonly [name: string]: unknown };

  // ============================================================
  // Services / ChromeUtils
  // ============================================================

  /** Firefox's central service locator. Every member is a singleton. */
  const Services: {
    /** Pref branch — synchronous get/set + observer-based change events.
     *  All methods throw if the pref doesn't exist or is the wrong type
     *  unless a default is supplied (the second arg). */
    prefs: {
      getBoolPref(name: string, defaultValue?: boolean): boolean;
      setBoolPref(name: string, value: boolean): void;
      getIntPref(name: string, defaultValue?: number): number;
      setIntPref(name: string, value: number): void;
      getStringPref(name: string, defaultValue?: string): string;
      setStringPref(name: string, value: string): void;
      getCharPref(name: string, defaultValue?: string): string;
      setCharPref(name: string, value: string): void;
      clearUserPref(name: string): void;
      addObserver(
        name: string,
        observer:
          | ((subject: unknown, topic: string, data: string) => void)
          | { observe(subject: unknown, topic: string, data: string): void },
        weakRef?: boolean,
      ): void;
      removeObserver(
        name: string,
        observer:
          | ((subject: unknown, topic: string, data: string) => void)
          | { observe(subject: unknown, topic: string, data: string): void },
      ): void;
    };

    /** Topic-based pubsub. Used for global lifecycle events
     *  ("quit-application", "sessionstore-windows-restored", …). The
     *  observer arg accepts either a function or an `{ observe(...) }` object;
     *  Firefox's nsIObserver implementation handles both. */
    obs: {
      addObserver(
        observer:
          | ((subject: unknown, topic: string, data: string) => void)
          | { observe(subject: unknown, topic: string, data: string): void },
        topic: string,
        weakRef?: boolean,
      ): void;
      removeObserver(
        observer:
          | ((subject: unknown, topic: string, data: string) => void)
          | { observe(subject: unknown, topic: string, data: string): void },
        topic: string,
      ): void;
      notifyObservers(subject: unknown, topic: string, data?: string): void;
    };

    /** Standard-directories service — the canonical way to get the
     *  active profile path (via "ProfD") and other well-known dirs. */
    dirsvc: {
      get(name: string, iface: unknown): { path: string };
    };

    /** Script-security-manager — primarily for `getSystemPrincipal()`
     *  used as the `triggeringPrincipal` arg on chrome-side tab opens. */
    scriptSecurityManager: {
      getSystemPrincipal(): unknown;
    };

    /** I/O service — URI factory, etc. Loose-typed; reach for it rarely. */
    io: {
      newURI(spec: string, charset?: string | null, baseURI?: unknown): { spec: string };
    };

    [other: string]: unknown;
  };

  /** Modern chrome utility namespace. ESM loader, sandbox creation, etc. */
  const ChromeUtils: {
    /** Synchronously import a chrome:// or resource:// ESM. Returns the
     *  module's namespace object; callers destructure. The generic lets
     *  callers pin the expected shape (e.g. `importESModule<{ Sqlite: { ... } }>`). */
    importESModule<T = Record<string, unknown>>(url: string): T;
    /** Define lazy ESM getters on a target object. */
    defineESModuleGetters(target: object, getters: Record<string, string>): void;
    [other: string]: unknown;
  };

  // ============================================================
  // Fast IO (chrome-only)
  // ============================================================

  /** Async file IO available to chrome scripts. Promise-based. UTF-8 is
   *  the default encoding for the *UTF8 variants. */
  const IOUtils: {
    read(path: string, opts?: { offset?: number; maxBytes?: number }): Promise<Uint8Array>;
    readUTF8(path: string): Promise<string>;
    write(
      path: string,
      data: Uint8Array | string,
      opts?: { tmpPath?: string; mode?: "create" | "append" | "appendOrCreate" | "overwrite" },
    ): Promise<number>;
    writeUTF8(
      path: string,
      data: string,
      opts?: { tmpPath?: string; mode?: "create" | "append" | "appendOrCreate" | "overwrite" },
    ): Promise<number>;
    stat(path: string): Promise<{
      size: number;
      lastModified: number;
      type: "regular" | "directory" | "other";
    }>;
    exists(path: string): Promise<boolean>;
    remove(path: string): Promise<void>;
    makeDirectory(
      path: string,
      opts?: { ignoreExisting?: boolean; createAncestors?: boolean },
    ): Promise<void>;
  };

  /** Path manipulation helpers — pure functions, no IO. */
  const PathUtils: {
    join(...parts: string[]): string;
    parent(path: string): string | null;
    filename(path: string): string;
  };

  // ============================================================
  // Browser window globals (browser.xhtml scope)
  // ============================================================

  /** The current chrome window's tabbrowser singleton. Owns the live tab
   *  set, dispatches Tab* events on `tabContainer`, and exposes mutation
   *  methods (pin/unpin/move/close/duplicate/etc). */
  const gBrowser: {
    /** Live tab strip array. Authoritative linear order — never maintain
     *  a parallel ordering. */
    readonly tabs: ReadonlyArray<import("../tabs/types.ts").Tab>;
    /** Currently active tab. Setter switches the chrome window to show it. */
    selectedTab: import("../tabs/types.ts").Tab;
    /** Backing `<browser>` element for the currently active tab. Reach for
     *  `.currentURI.spec` / `.focus()` / `.fixupAndLoadURIString(url, opts)`. */
    readonly selectedBrowser: import("../tabs/types.ts").FirefoxBrowser & HTMLElement & {
      readonly webProgress?: { isLoadingDocument?: boolean };
      readonly messageManager?: {
        sendAsyncMessage(name: string, data?: unknown): void;
        loadFrameScript(url: string, allowDelayedLoad?: boolean): void;
      };
      focus(): void;
      fixupAndLoadURIString(spec: string, opts: { triggeringPrincipal: unknown; flags?: number }): void;
    };
    /** Container element that emits `TabOpen` / `TabClose` / `TabSelect` /
     *  `TabMove` / `TabAttrModified` / `TabPinned` / `TabUnpinned` events.
     *  Also exposes `.pinnedTabsContainer` (the inner sub-strip for pinned
     *  tabs) on modern Firefox; pre-revamp builds put pinned tabs straight
     *  under tabContainer. */
    readonly tabContainer: HTMLElement & {
      readonly pinnedTabsContainer?: HTMLElement;
    };
    /** Container for pinned tabs (separate from regular tab strip).
     *  Older builds expose this on gBrowser; modern builds nest it under
     *  tabContainer. Code reads both for compat. */
    readonly pinnedTabsContainer?: HTMLElement;
    /** Side panel area for tab content (mousedown listener target). */
    readonly tabpanels: HTMLElement;
    /** Group-scope message manager — broadcasts to every browser frame
     *  loader in this chrome window. allowDelayedLoad=true also covers
     *  newly-opened tabs. */
    readonly messageManager: {
      loadFrameScript(url: string, allowDelayedLoad: boolean): void;
      removeDelayedFrameScript?(url: string): void;
      addMessageListener(
        name: string,
        listener: (msg: { target: Element; data: unknown }) => void,
      ): void;
      removeMessageListener(
        name: string,
        listener: (msg: { target: Element; data: unknown }) => void,
      ): void;
      sendAsyncMessage?(name: string, data?: unknown): void;
    };

    pinTab(tab: import("../tabs/types.ts").Tab): void;
    unpinTab(tab: import("../tabs/types.ts").Tab): void;
    removeTab(tab: import("../tabs/types.ts").Tab): void;
    duplicateTab(tab: import("../tabs/types.ts").Tab): import("../tabs/types.ts").Tab;
    reloadTab(tab: import("../tabs/types.ts").Tab): void;
    /** Modern Firefox accepts either a number or `{ tabIndex: number }`. */
    moveTabTo(tab: import("../tabs/types.ts").Tab, index: number | { tabIndex: number }): void;
    addTab(uri: string, opts: { triggeringPrincipal: unknown }): import("../tabs/types.ts").Tab;
    /** Stable: open a tab in a new window. */
    replaceTabWithWindow(tab: import("../tabs/types.ts").Tab): unknown;
    /** Newer: open multiple tabs in a new window. May be absent on
     *  pre-revamp Firefox; callers check `typeof === "function"`. */
    replaceTabsWithWindow?(tabs: ReadonlyArray<import("../tabs/types.ts").Tab>): unknown;
    /** Favicon URL or null. Throws on rare error paths — wrap in try. */
    getIcon(tab: import("../tabs/types.ts").Tab): string | null;
  };

  /** Chrome window init signal. delayedStartupFinished flips true once
   *  gBrowser is fully wired and listeners are safe to attach. */
  const gBrowserInit: {
    delayedStartupFinished: boolean;
  };

  /** The urlbar singleton — UrlbarInput.mjs surface. */
  const gURLBar: {
    focus(): void;
    select(): void;
    /** Current input value. */
    value: string;
    /** Underlying <input> element. */
    readonly inputField: HTMLInputElement;
    /** Result-list view. selectBy(±n) navigates suggestions. */
    readonly view: {
      selectBy(amount: number, opts?: { reverse?: boolean; userPressedTab?: boolean }): void;
      readonly isOpen?: boolean;
    };
    [other: string]: unknown;
  };

  /** Navigator toolbox container — the toolbar/urlbar/tab-strip cluster. */
  const gNavToolbox: HTMLElement;

  // ============================================================
  // Subsystems palefox touches occasionally — loose for now
  // ============================================================

  const SessionStore: {
    getTabState(tab: import("../tabs/types.ts").Tab): string;
    setTabState(tab: import("../tabs/types.ts").Tab, state: string): void;
    persistTabAttribute(name: string): void;
    setCustomTabValue(tab: import("../tabs/types.ts").Tab, key: string, value: string): void;
    getCustomTabValue(tab: import("../tabs/types.ts").Tab, key: string): string;
    setCustomGlobalValue(key: string, value: string): void;
    getCustomGlobalValue(key: string): string;
    [other: string]: unknown;
  };

  /** Native tab context menu. Palefox occasionally piggybacks on its
   *  contextTab(s) state for split-view actions. */
  const TabContextMenu: {
    contextTab: import("../tabs/types.ts").Tab | null;
    contextTabs: ReadonlyArray<import("../tabs/types.ts").Tab>;
    moveTabsToSplitView?(): void;
    [other: string]: unknown;
  };

  const PlacesCommandHook: {
    bookmarkTabs?(tabs: ReadonlyArray<import("../tabs/types.ts").Tab>): void;
    [other: string]: unknown;
  };

  const FirefoxViewHandler: {
    readonly tab: import("../tabs/types.ts").Tab | null;
    [other: string]: unknown;
  };

  /** WebExtension API surface — only available in some contexts; loosely
   *  typed since palefox reaches for it opportunistically. */
  const browser: { readonly [api: string]: unknown };

  // ============================================================
  // DOM augmentation
  // ============================================================

  /** XUL element factories live on Document in chrome scope. */
  interface Document {
    createXULElement(tag: string): HTMLElement;
  }

  /** Palefox decorates DOM elements (the rows it builds) with these
   *  private refs. Typing them as optional on every Element lets walks
   *  through siblings/children avoid per-call casts. */
  interface Element {
    _tab?: import("../tabs/types.ts").Tab;
    _group?: import("../tabs/types.ts").Group;
    /** XUL/HTML elements palefox touches all expose `hidden`, `style`,
     *  `isContentEditable` — DOM lib types Element more strictly; this
     *  augmentation matches our runtime reality. */
    hidden?: boolean;
    isContentEditable?: boolean;
  }

  // ============================================================
  // Test-only debug API
  // ============================================================

  /** Only present when `pfx.test.exposeAPI` pref is true (set in
   *  test-profile user.js by tools/test-driver/profile.ts). Production
   *  builds never expose this. Typed loosely — surface is intentionally
   *  fluid; tests assert on shape themselves. */
  interface Window {
    pfxTest?: Record<string, unknown>;
    /** Palefox semantic platform — set during init. Typed strictly via
     *  `(window as ...).Palefox`-style cast at the call site. */
    Palefox?: unknown;
  }
}
