// Core types used across src/tabs/* modules.
//
// Most chrome-scoped types (gBrowser, Services, etc.) live in src/types/chrome.d.ts
// as ambient `any`. The types below are palefox's own data shapes — the bits
// we put into WeakMaps, persist to disk, and pass between our own functions.
// These start narrow and tighten over time as files get migrated off @ts-nocheck.

/** XPCOM nsIURI — the chrome-side URL primitive. We only reach for `.spec`
 *  (the canonical string form) but the real interface has `host`, `scheme`,
 *  `pathQueryRef`, etc. Tighten in-place if a call site needs more. */
export interface nsIURI {
  /** Canonical string form (e.g. "https://example.com/path?q=1"). */
  spec: string;
}

/** Firefox `<browser>` XUL element — the content-area embed that backs a tab.
 *  Each Tab points at one via `tab.linkedBrowser`. Models only the bits
 *  palefox reaches for; the real surface is much wider (printPreviewURL,
 *  reload, goBack, etc.). */
export interface FirefoxBrowser extends HTMLElement {
  /** Live URI for the currently-loaded document. May be `about:blank` for
   *  pending / lazy-restored tabs — fall back to SessionStore.getTabState
   *  via tabUrl(). */
  currentURI: nsIURI;
}

/** Firefox `<tab>` XUL element (MozTabbrowserTab in browser/tabbrowser/content/tab.js).
 *  Models only the surface palefox actually touches:
 *
 *    - User-facing state:  label, pinned, selected, hidden, multiselected, muted, owner
 *    - Browser linkage:    linkedBrowser (with currentURI.spec)
 *    - Identity:           userContextId, tabbrowser
 *    - Lifecycle:          closing, isOpen, visible
 *    - DOM:                inherits attribute / event APIs from HTMLElement
 *
 *  If you find yourself reaching for something not modeled here, prefer
 *  adding the property over casting back to `any`. */
export interface Tab extends HTMLElement {
  /** Display label — what shows in the tab strip / tab tree row. */
  label: string;
  /** True iff the `pinned` attribute is set. */
  pinned: boolean;
  /** True iff this tab is the active tab. Mirrors `selected` attribute. */
  selected: boolean;
  /** Hidden via tab grouping, container tabs, FirefoxView, etc. Read-only:
   *  the getter narrows the inherited DOM `hidden` to attribute + group
   *  visibility. */
  hidden: boolean;
  /** True iff `multiselected` attribute set (Cmd/Ctrl+click). */
  multiselected: boolean;
  /** True iff `muted` attribute set. */
  muted: boolean;
  /** True iff sound is currently playing. */
  soundPlaying: boolean;
  /** Firefox container ID (0 = default). */
  userContextId: number;
  /** Tab that opened this tab (may be null after the opener closes — Firefox
   *  uses a WeakRef internally and returns null for collected referents). */
  owner: Tab | null;
  /** The `<browser>` element backing this tab's content. */
  linkedBrowser: FirefoxBrowser;
  /** Reference to the gBrowser singleton. Kept loose since gBrowser itself
   *  is `any` until Phase 4 of the type rollout. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tabbrowser: any;
  /** True while the tab's close animation is running. */
  closing: boolean;
  /** isConnected && !closing && != FirefoxViewHandler.tab. */
  readonly isOpen: boolean;
  /** isOpen && !hidden && (no group OR visible-in-group). */
  readonly visible: boolean;
  /** Wrapping `<tab-split-view-wrapper>`, or null if tab isn't in a split view. */
  readonly splitview: HTMLElement | null;
  /** Toggle audio mute. Optional reason string for extension-driven mutes. */
  toggleMuteAudio(aMuteReason?: string): void;
}

/** Per-tab tree metadata stored in the `treeOf` WeakMap. */
export type TreeData = {
  /** Stable palefox tab ID. Persisted across sessions via SessionStore.persistTabAttribute. */
  id: number;
  /** ID of the parent — number = tab id, string = group id ("g1", "g2", …),
   *  null = root. Pinned tabs are always null. Tabs with a string parentId
   *  are visually nested inside a group; their level derives as
   *  group.level + 1 (see helpers.levelOf). */
  parentId: number | string | null;
  /** Custom rename label, or null to fall back to tab.label. */
  name: string | null;
  /** Informational tag like "child" or "sibling" — set by spawn-position handlers. */
  state: string | null;
  /** Whether this tab's subtree is collapsed in the UI. */
  collapsed: boolean;
  /** Set once a session-restore "apply" has stamped this tab. Prevents stale
   *  queue entries from overwriting an already-corrected tab on later events. */
  appliedSavedState?: boolean;
};

/** User-defined group header sitting between rows in the tree. */
export type Group = {
  id: string;
  type: "group";
  name: string;
  level: number;
  state: string | null;
  collapsed: boolean;
};

/** A palefox row element. Discriminated by which of `_tab`/`_group` is set. */
export type Row = HTMLElement & {
  _tab?: Tab;
  _group?: Group;
};

/** Serialized form of a tab or group node, persisted in palefox-tab-tree.json. */
export type SavedNode = {
  id: number;
  /** Mirrors TreeData.parentId — number for tab parent, string for group parent. */
  parentId: number | string | null;
  /** Present for group entries; absent for tabs. */
  type?: "group";
  name?: string | null;
  state?: string | null;
  collapsed?: boolean;
  /** Present for tabs; URL at save time, used for re-pairing on session restore. */
  url?: string;
  /** Group nesting level. */
  level?: number;
  /** Group anchor — the tab this group sits after. */
  afterTabId?: number | null;
  /** Original index into the saved tab list — used for ordered restore. */
  _origIdx?: number;
  /** Mid-session-closed entries: id of the previous sibling at close time,
   *  used to re-position descendants on undoCloseTab. */
  prevSiblingId?: number | null;
  /** Mid-session-closed entries: ids of descendants captured at close time,
   *  so the whole subtree comes back nested correctly. */
  descendantIds?: number[];
};
