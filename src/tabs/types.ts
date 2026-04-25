// Core types used across src/tabs/* modules.
//
// Most chrome-scoped types (gBrowser, Services, etc.) live in src/types/chrome.d.ts
// as ambient `any`. The types below are palefox's own data shapes — the bits
// we put into WeakMaps, persist to disk, and pass between our own functions.
// These start narrow and tighten over time as files get migrated off @ts-nocheck.

/** Native Firefox `<tab>` XUL element. Tracked here as `any` because we touch
 *  many XUL-specific bits (label, pinned, owner, linkedBrowser, _tPos, …) and
 *  modelling all of them is more pain than payoff. Tighten in-place if a
 *  specific access pattern starts surfacing real bugs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tab = any;

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
