// Snapshot building + session-restore queue helpers. Pure, no IO.
//
// Public API (interface):
//   buildEnvelope(snapshot)        → SnapshotEnvelope     pure struct
//   makeSaver(getSnapshot, history, onError?) → () => void  coalesced scheduleSave
//   popSavedByUrl(queue, url)      → SavedNode | null       splice-mutates
//   popSavedByIndex(queue, idx)    → SavedNode | null       splice-mutates
//   popSavedForTab(queue, ctx)     → SavedNode | null       splice-mutates
//
// Storage layer is src/tabs/history.ts (SQLite). This module just builds
// the envelope to hand off and exposes the queue helpers used during
// session-restore reconciliation.

import { CLOSED_MEMORY } from "./constants.ts";
import type { HistoryAPI, SnapshotEnvelope } from "./history.ts";
import type { Row, SavedNode, Tab, TreeData } from "./types.ts";

// =============================================================================
// INTERFACE
// =============================================================================

/** Live state at a moment in time. Captured by the orchestrator and passed
 *  to buildEnvelope. The snapshot module never reaches into globals. */
export type Snapshot = {
  /** Live Firefox tabs in canonical (gBrowser.tabs) order. */
  readonly tabs: readonly Tab[];
  /** Walks all rows in DOM order — used to find groups + their anchor tabs. */
  readonly rows: () => Iterable<Row>;
  /** Saved-tab queue carried over from prior session, for leftovers on save. */
  readonly savedTabQueue: readonly SavedNode[];
  /** Recently-closed tab memory, persisted alongside the live tree. */
  readonly closedTabs: readonly SavedNode[];
  /** Next palefox-id counter — saved so freshly opened tabs can't collide
   *  with restored-session ids. */
  readonly nextTabId: number;
  /** Returns the persisted URL for a tab — code paths know better ways
   *  to resolve URLs for pending/lazy tabs. */
  readonly tabUrl: (tab: Tab) => string;
  /** Returns the tree-data for a tab (must already exist). */
  readonly treeData: (tab: Tab) => TreeData;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/** Pure: build the envelope we'll hand to history.appendEvent. Deterministic
 *  given snapshot — same shape as the file format we used to write, just
 *  structured rather than stringified (the SQLite layer handles encoding). */
export function buildEnvelope(snapshot: Snapshot): SnapshotEnvelope {
  // Tabs in canonical Firefox order. Positional matching at load time
  // depends on this ordering being stable. SavedNode's `type` field is
  // `"group"` or absent — tab entries omit `type` (interpreted as "tab"
  // at the loader by `type !== "group"`).
  const tabEntries: SavedNode[] = snapshot.tabs.map((tab) => {
    const d = snapshot.treeData(tab);
    return {
      id: d.id,
      parentId: d.parentId ?? null,
      url: snapshot.tabUrl(tab),
      name: d.name,
      state: d.state,
      collapsed: d.collapsed,
    };
  });

  // Groups anchored by the most recent preceding tab (afterTabId).
  const groupEntries: SavedNode[] = [];
  let lastSeenTabId: number | null = null;
  for (const row of snapshot.rows()) {
    if (row._tab) {
      lastSeenTabId = snapshot.treeData(row._tab).id;
    } else if (row._group) {
      groupEntries.push({
        // SavedNode requires an id — groups don't have a stable numeric id,
        // so we synthesize 0 here. Loaders ignore group ids.
        id: 0,
        parentId: null,
        type: "group",
        name: row._group.name,
        level: row._group.level,
        state: row._group.state,
        collapsed: row._group.collapsed,
        afterTabId: lastSeenTabId,
      });
    }
  }

  // Preserve unconsumed saved-state entries so periodic saves during a blank
  // window don't clobber them before the real window is restored. Drop any
  // whose URL collides with a live tab so we don't double-up on restore.
  const liveUrls = new Set(tabEntries.map(e => e.url).filter(Boolean));
  const leftovers: SavedNode[] = snapshot.savedTabQueue
    .filter((s) => !s.url || !liveUrls.has(s.url))
    .map((s) => ({ ...s }));

  const out: SavedNode[] = [...tabEntries, ...groupEntries, ...leftovers];
  return {
    nodes: out,
    closedTabs: snapshot.closedTabs.slice(-CLOSED_MEMORY),
    nextTabId: snapshot.nextTabId,
  };
}

/** Build a coalesced save scheduler. The closure captures inFlight/pending
 *  flags privately and pulls a fresh snapshot for every write — so rapid-fire
 *  schedule calls collapse to one in-flight + (at most) one pending write,
 *  always recording the latest state. The actual write goes through
 *  history.appendEvent, which dedupes by content hash; calling this with
 *  a no-op state mutation is free. */
export function makeSaver(
  getSnapshot: () => Snapshot,
  history: HistoryAPI,
  onError: (err: unknown) => void = (e) => console.error("palefox-tabs: save chain", e),
): () => void {
  let inFlight = false;
  let pending = false;
  function scheduleSave(): void {
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    (async () => {
      try {
        await history.appendEvent(buildEnvelope(getSnapshot()));
      } catch (e) {
        onError(e);
      }
      inFlight = false;
      if (pending) {
        pending = false;
        scheduleSave();
      }
    })();
  }
  return scheduleSave;
}

// --- Queue helpers --------------------------------------------------------
//
// These splice-mutate the queue, matching the legacy behavior. The legacy
// caller wants the queue shrunk in place. Marked clearly in JSDoc so future
// readers don't expect FP-style return-new-array semantics.

/** Splice-mutates `queue`. Returns the matched node, or null. */
export function popSavedByUrl(queue: SavedNode[], url: string | null | undefined): SavedNode | null {
  if (!url) return null;
  const i = queue.findIndex(s => s.url === url);
  return i >= 0 ? queue.splice(i, 1)[0]! : null;
}

/** Splice-mutates `queue`. Returns the matched node, or null. */
export function popSavedByIndex(queue: SavedNode[], idx: number): SavedNode | null {
  if (idx < 0) return null;
  const i = queue.findIndex(s => s._origIdx === idx);
  return i >= 0 ? queue.splice(i, 1)[0]! : null;
}

/** Splice-mutates `queue`. Combined helper used by event handlers when a
 *  session-restore tab arrives. Priority order:
 *    1. pfx-id attribute (most reliable, persisted via persistTabAttribute)
 *    2. Exact URL match (when URL has resolved)
 *    3. FIFO shift (only if inSessionRestore — guards against new user tabs
 *       consuming stale entries from a previous session's leftovers) */
export function popSavedForTab(
  queue: SavedNode[],
  ctx: {
    /** Current index of this tab in gBrowser.tabs, or -1 if unknown. */
    readonly currentIdx: number;
    /** Persisted palefox ID on the tab, or 0 if none. */
    readonly pinnedId: number;
    /** Resolved URL for the tab, or empty string if pending. */
    readonly url: string;
    /** Whether session restore is in progress — gates the FIFO fallback. */
    readonly inSessionRestore: boolean;
    /** Optional logger. */
    readonly log?: (event: string, data?: Record<string, unknown>) => void;
  },
): SavedNode | null {
  const { currentIdx, pinnedId, url, inSessionRestore, log } = ctx;

  // 1. pfx-id match.
  if (pinnedId) {
    const i = queue.findIndex(s => s.id === pinnedId);
    if (i >= 0) {
      log?.("popSavedForTab:pfxId", { idx: currentIdx, pfxId: pinnedId, url });
      return queue.splice(i, 1)[0]!;
    }
  }
  // 2. URL match.
  if (url && url !== "about:blank") {
    const node = popSavedByUrl(queue, url);
    log?.("popSavedForTab:url", { idx: currentIdx, url, found: !!node });
    return node;
  }
  // 3. FIFO fallback — only during session restore.
  if (!inSessionRestore) return null;
  const node = queue.length ? queue.shift()! : null;
  log?.("popSavedForTab:fifo", {
    idx: currentIdx, pfxId: pinnedId, url, nodeId: node?.id, nodeOrigIdx: node?._origIdx,
  });
  return node;
}
