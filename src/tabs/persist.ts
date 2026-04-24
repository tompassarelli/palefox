// Persistence — read/write the tab tree to <profile>/palefox-tab-tree.json.
//
// Public API (interface):
//   serializeState(snapshot)       → string         pure JSON string
//   parseLoaded(text)              → LoadedState | null
//   writeTreeToDisk(snapshot)      → Promise<void>
//   readTreeFromDisk()             → Promise<LoadedState | null>
//   makeSaver(getSnapshot, onError?) → () => void   coalesced scheduleSave
//   popSavedByUrl(queue, url)      → SavedNode | null   splice-mutates
//   popSavedByIndex(queue, idx)    → SavedNode | null   splice-mutates
//   popSavedForTab(queue, tab, …)  → SavedNode | null   splice-mutates
//
// Notes:
//   - serializeState/parseLoaded are pure. Easy to unit-test in isolation.
//   - The pop helpers mutate their queue argument, matching the existing
//     behavior. They're explicitly typed with a non-readonly array.
//   - makeSaver owns the inFlight/pending coalescing flags privately; each
//     call to makeSaver returns a fresh closure (one per logical save target).

import { SAVE_FILE, CLOSED_MEMORY } from "./constants.ts";
import type { Row, SavedNode, Tab, TreeData } from "./types.ts";

declare const PathUtils: any;
declare const Services: any;
declare const Ci: any;
declare const IOUtils: any;

// =============================================================================
// INTERFACE
// =============================================================================

/** Snapshot of the live tree at a moment in time. Captured by the orchestrator
 *  and passed to writeTreeToDisk; the persist module never reaches into globals. */
export type Snapshot = {
  /** Live Firefox tabs in canonical (gBrowser.tabs) order. */
  readonly tabs: readonly Tab[];
  /** Walks all rows in DOM order — used to find groups and their anchor tabs. */
  readonly rows: () => Iterable<Row>;
  /** Saved-tab queue carried over from last session, for leftovers on save. */
  readonly savedTabQueue: readonly SavedNode[];
  /** Recently-closed tab memory, persisted as part of the tree file. */
  readonly closedTabs: readonly SavedNode[];
  /** Next palefox-id counter — saved so freshly opened tabs can't collide
   *  with restored-session IDs across a restart. */
  readonly nextTabId: number;
  /** Returns the persisted URL for a tab — a few code paths know better
   *  ways to resolve URLs for pending/lazy tabs. */
  readonly tabUrl: (tab: Tab) => string;
  /** Returns the tree-data for a tab (must already exist). */
  readonly treeData: (tab: Tab) => TreeData;
};

/** Fully-decoded tree file from disk. Doesn't apply itself — the orchestrator
 *  threads it into live state. */
export type LoadedState = {
  /** All persisted nodes (tabs + groups), preserving original order. */
  readonly nodes: readonly SavedNode[];
  /** Just the tab nodes, in canonical order. */
  readonly tabNodes: readonly SavedNode[];
  /** Recently-closed tabs (capped by CLOSED_MEMORY). */
  readonly closedTabs: readonly SavedNode[];
  /** Persisted next-tab-id counter, or null if missing/stale. */
  readonly nextTabId: number | null;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

function profilePath(): string {
  return PathUtils.join(
    Services.dirsvc.get("ProfD", Ci.nsIFile).path,
    SAVE_FILE,
  );
}

/** Pure: build the JSON string we'll write. Deterministic given snapshot. */
export function serializeState(snapshot: Snapshot): string {
  // Tabs in canonical Firefox tab order. Positional matching at load time
  // depends on this ordering being stable.
  const tabEntries = snapshot.tabs.map((tab) => {
    const d = snapshot.treeData(tab);
    return {
      type: "tab" as const,
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
  // whose URL collides with a live tab to prevent duplicates corrupting the
  // correction path on subsequent restores.
  const liveUrls = new Set(tabEntries.map(e => e.url).filter(Boolean));
  const leftovers = snapshot.savedTabQueue
    .filter(s => !s.url || !liveUrls.has(s.url))
    .map(s => ({ ...s, type: "tab" as const }));

  const out = [...tabEntries, ...groupEntries, ...leftovers];

  return JSON.stringify({
    nodes: out,
    closedTabs: snapshot.closedTabs,
    nextTabId: snapshot.nextTabId,
  });
}

/** Pure: parse a tree-file's text into a typed structure. Returns null if the
 *  file is malformed or has no nodes array. Tolerant of legacy formats. */
export function parseLoaded(text: string): LoadedState | null {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || !Array.isArray(raw.nodes)) return null;

  const tabNodes: SavedNode[] = raw.nodes
    .filter((n: any) => n.type === "tab" || n.type === undefined)
    .map((n: any) => ({ ...n }));

  // Legacy migration: derive parentId from level+order via a stack walk if
  // parentId is missing on tab nodes. Mutates the tabNodes array in place
  // (these are fresh copies from the spread above, so it's local-only).
  {
    const stack: { level: number; id: number }[] = [];
    for (const n of tabNodes) {
      const lv = n.level || 0;
      while (stack.length && stack[stack.length - 1]!.level >= lv) stack.pop();
      if (n.parentId === undefined) {
        n.parentId = stack.length ? stack[stack.length - 1]!.id : null;
      }
      if (n.id) stack.push({ level: lv, id: n.id });
    }
  }

  return {
    nodes: raw.nodes,
    tabNodes,
    closedTabs: Array.isArray(raw.closedTabs)
      ? raw.closedTabs.slice(-CLOSED_MEMORY)
      : [],
    nextTabId: Number.isInteger(raw.nextTabId) ? raw.nextTabId : null,
  };
}

export async function writeTreeToDisk(snapshot: Snapshot): Promise<void> {
  try {
    await IOUtils.writeUTF8(profilePath(), serializeState(snapshot));
  } catch (e) {
    console.error("palefox-tabs: writeTreeToDisk failed", e);
    throw e;
  }
}

export async function readTreeFromDisk(): Promise<LoadedState | null> {
  const path = profilePath();
  let text: string;
  try {
    text = await IOUtils.readUTF8(path);
  } catch (e: any) {
    console.log(`palefox-tabs: no save file at ${path} (${e?.name || "err"})`);
    return null;
  }
  const parsed = parseLoaded(text);
  if (!parsed) {
    console.log("palefox-tabs: save file exists but failed to parse");
  }
  return parsed;
}

/** Build a coalesced save scheduler. The closure captures inFlight/pending
 *  flags privately and pulls a fresh snapshot for every write — so rapid-fire
 *  schedule calls collapse to one in-flight + (at most) one pending write,
 *  always recording the latest state. */
export function makeSaver(
  getSnapshot: () => Snapshot,
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
        await writeTreeToDisk(getSnapshot());
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
// These splice-mutate the queue, matching the existing semantics. The legacy
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
