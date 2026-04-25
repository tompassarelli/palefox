// Pure-function tests for snapshot.ts.
//
// snapshot.ts replaces the old persist.ts file IO. What stayed pure is
// what gets tested here — no chrome globals, no SQLite. Nothing in this
// file requires JSDOM or a Firefox harness; it runs under plain `bun test`.
//
// What's covered:
//   buildEnvelope — pure construction of the SnapshotEnvelope passed to
//                   history.appendEvent
//     - tabs in canonical order with their TreeData
//     - groups with afterTabId anchored to the most recent preceding tab
//     - savedTabQueue leftovers preserved (and de-duped against live URLs)
//     - closedTabs capped by CLOSED_MEMORY
//   popSavedByUrl / popSavedByIndex / popSavedForTab queue helpers
//     - splice-mutates queue
//     - prefers pfx-id, falls back to URL, then FIFO under inSessionRestore

import { describe, expect, test } from "bun:test";

import { CLOSED_MEMORY } from "./constants.ts";
import {
  buildEnvelope,
  popSavedByIndex,
  popSavedByUrl,
  popSavedForTab,
  type Snapshot,
} from "./snapshot.ts";
import type { Row, SavedNode, Tab, TreeData } from "./types.ts";

// === Test helpers ============================================================

function fakeTab(name: string): Tab {
  return { __testTab: name } as unknown as Tab;
}

function fakeGroupRow(group: { id: string; name: string; level: number; collapsed: boolean }): Row {
  return { _group: { ...group, type: "group", state: null } } as unknown as Row;
}

function fakeTabRow(tab: Tab): Row {
  return { _tab: tab } as unknown as Row;
}

function makeSnapshot(opts: {
  tabs: Tab[];
  treeData: Map<Tab, TreeData>;
  urls?: Map<Tab, string>;
  rows?: Row[];
  savedTabQueue?: SavedNode[];
  closedTabs?: SavedNode[];
  nextTabId?: number;
}): Snapshot {
  const urls = opts.urls ?? new Map();
  return {
    tabs: opts.tabs,
    rows: () => opts.rows ?? opts.tabs.map(fakeTabRow),
    savedTabQueue: opts.savedTabQueue ?? [],
    closedTabs: opts.closedTabs ?? [],
    nextTabId: opts.nextTabId ?? opts.tabs.length + 1,
    tabUrl: (tab) => urls.get(tab) ?? "https://example.com/",
    treeData: (tab) => {
      const d = opts.treeData.get(tab);
      if (!d) throw new Error("treeData fixture missing for tab");
      return d;
    },
  };
}

function td(id: number, parentId: TreeData["parentId"] = null, opts: Partial<TreeData> = {}): TreeData {
  return { id, parentId, name: null, state: null, collapsed: false, ...opts };
}

// === buildEnvelope ===========================================================

describe("buildEnvelope", () => {
  test("emits tab nodes in canonical order with their TreeData", () => {
    const a = fakeTab("a");
    const b = fakeTab("b");
    const c = fakeTab("c");
    const snap = makeSnapshot({
      tabs: [a, b, c],
      treeData: new Map([
        [a, td(1)],
        [b, td(2, 1)],
        [c, td(3, 2, { collapsed: true })],
      ]),
      urls: new Map([
        [a, "https://a.test/"],
        [b, "https://b.test/"],
        [c, "https://c.test/"],
      ]),
    });
    const env = buildEnvelope(snap);
    expect(env.nodes).toHaveLength(3);
    // SavedNode tab entries have type === undefined (loader uses
    // `type !== "group"` to identify tabs).
    expect(env.nodes[0]).toMatchObject({ id: 1, parentId: null, url: "https://a.test/" });
    expect(env.nodes[1]).toMatchObject({ id: 2, parentId: 1, url: "https://b.test/" });
    expect(env.nodes[2]).toMatchObject({ id: 3, parentId: 2, url: "https://c.test/", collapsed: true });
    // Verify none of the tab entries are tagged as groups
    for (const n of env.nodes) {
      expect(n.type).not.toBe("group");
    }
  });

  test("group entries carry afterTabId of the last preceding tab", () => {
    const a = fakeTab("a");
    const b = fakeTab("b");
    const grp = fakeGroupRow({ id: "g1", name: "Work", level: 1, collapsed: false });
    const snap = makeSnapshot({
      tabs: [a, b],
      treeData: new Map([[a, td(10)], [b, td(11, 10)]]),
      rows: [fakeTabRow(a), grp, fakeTabRow(b)],
    });
    const env = buildEnvelope(snap);
    const groupNode = env.nodes.find((n) => n.type === "group");
    expect(groupNode).toBeDefined();
    expect(groupNode!.afterTabId).toBe(10);
    expect(groupNode!.name).toBe("Work");
    expect(groupNode!.level).toBe(1);
  });

  test("group with no preceding tab gets afterTabId: null", () => {
    const a = fakeTab("a");
    const grp = fakeGroupRow({ id: "g1", name: "Top", level: 0, collapsed: false });
    const snap = makeSnapshot({
      tabs: [a],
      treeData: new Map([[a, td(1)]]),
      rows: [grp, fakeTabRow(a)],
    });
    const env = buildEnvelope(snap);
    const groupNode = env.nodes.find((n) => n.type === "group");
    expect(groupNode!.afterTabId).toBeNull();
  });

  test("savedTabQueue leftovers without URL collisions are preserved", () => {
    const a = fakeTab("a");
    const leftover: SavedNode = {
      id: 99, parentId: null, url: "https://stale.test/", _origIdx: 5,
    };
    const snap = makeSnapshot({
      tabs: [a],
      treeData: new Map([[a, td(1)]]),
      urls: new Map([[a, "https://a.test/"]]),
      savedTabQueue: [leftover],
    });
    const env = buildEnvelope(snap);
    expect(env.nodes).toHaveLength(2);
    expect(env.nodes[1]).toMatchObject({ id: 99, url: "https://stale.test/" });
    expect(env.nodes[1]!.type).not.toBe("group");
  });

  test("savedTabQueue entries colliding with live tab URLs are dropped", () => {
    const a = fakeTab("a");
    const collide: SavedNode = { id: 50, parentId: null, url: "https://a.test/" };
    const keep: SavedNode = { id: 51, parentId: null, url: "https://elsewhere.test/" };
    const snap = makeSnapshot({
      tabs: [a],
      treeData: new Map([[a, td(1)]]),
      urls: new Map([[a, "https://a.test/"]]),
      savedTabQueue: [collide, keep],
    });
    const env = buildEnvelope(snap);
    expect(env.nodes).toHaveLength(2);
    expect(env.nodes.find((n) => n.id === 50)).toBeUndefined();
    expect(env.nodes.find((n) => n.id === 51)).toBeDefined();
  });

  test("includes closedTabs (capped by CLOSED_MEMORY) and nextTabId", () => {
    const closed: SavedNode = { id: 7, parentId: null, url: "https://closed.test/" };
    const snap = makeSnapshot({
      tabs: [],
      treeData: new Map(),
      closedTabs: [closed],
      nextTabId: 42,
    });
    const env = buildEnvelope(snap);
    expect(env.closedTabs).toEqual([closed]);
    expect(env.nextTabId).toBe(42);
  });

  test("closedTabs trimmed to CLOSED_MEMORY entries (newest)", () => {
    const many: SavedNode[] = Array.from({ length: CLOSED_MEMORY + 10 }, (_, i) => ({
      id: i + 1, parentId: null, url: `https://t${i}.test/`,
    }));
    const snap = makeSnapshot({
      tabs: [], treeData: new Map(), closedTabs: many,
    });
    const env = buildEnvelope(snap);
    expect(env.closedTabs).toHaveLength(CLOSED_MEMORY);
    // Newest 32 = the last 32 of `many`. id: 11..42
    expect(env.closedTabs[0]!.id).toBe(11);
    expect(env.closedTabs[CLOSED_MEMORY - 1]!.id).toBe(CLOSED_MEMORY + 10);
  });
});

// === Queue helpers ===========================================================

describe("popSavedByUrl", () => {
  test("splice-mutates and returns matched node", () => {
    const queue: SavedNode[] = [
      { id: 1, parentId: null, url: "https://a/" },
      { id: 2, parentId: null, url: "https://b/" },
    ];
    const popped = popSavedByUrl(queue, "https://a/");
    expect(popped?.id).toBe(1);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.id).toBe(2);
  });

  test("returns null and leaves queue alone on miss", () => {
    const queue: SavedNode[] = [{ id: 1, parentId: null, url: "https://a/" }];
    expect(popSavedByUrl(queue, "https://nope/")).toBeNull();
    expect(queue).toHaveLength(1);
  });

  test("returns null on empty / falsy URL", () => {
    const queue: SavedNode[] = [{ id: 1, parentId: null, url: "https://a/" }];
    expect(popSavedByUrl(queue, "")).toBeNull();
    expect(popSavedByUrl(queue, null)).toBeNull();
    expect(popSavedByUrl(queue, undefined)).toBeNull();
    expect(queue).toHaveLength(1);
  });
});

describe("popSavedByIndex", () => {
  test("matches on _origIdx, splice-mutates", () => {
    const queue: SavedNode[] = [
      { id: 1, parentId: null, _origIdx: 5 },
      { id: 2, parentId: null, _origIdx: 9 },
    ];
    const popped = popSavedByIndex(queue, 9);
    expect(popped?.id).toBe(2);
    expect(queue).toHaveLength(1);
  });

  test("returns null on negative index", () => {
    const queue: SavedNode[] = [{ id: 1, parentId: null, _origIdx: 0 }];
    expect(popSavedByIndex(queue, -1)).toBeNull();
    expect(queue).toHaveLength(1);
  });
});

describe("popSavedForTab", () => {
  const baseCtx = { currentIdx: 0, pinnedId: 0, url: "", inSessionRestore: false };

  test("priority 1: pfx-id wins even when URL would also match", () => {
    const queue: SavedNode[] = [
      { id: 7, parentId: null, url: "https://other.test/" },
      { id: 8, parentId: null, url: "https://a.test/" },
    ];
    const popped = popSavedForTab(queue, { ...baseCtx, pinnedId: 7, url: "https://a.test/" });
    expect(popped?.id).toBe(7);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.id).toBe(8);
  });

  test("priority 2: URL match when no pfx-id", () => {
    const queue: SavedNode[] = [
      { id: 1, parentId: null, url: "https://a/" },
      { id: 2, parentId: null, url: "https://b/" },
    ];
    const popped = popSavedForTab(queue, { ...baseCtx, url: "https://b/" });
    expect(popped?.id).toBe(2);
    expect(queue).toHaveLength(1);
  });

  test("about:blank URLs are NOT used for URL matching", () => {
    const queue: SavedNode[] = [
      { id: 1, parentId: null, url: "about:blank" },
      { id: 2, parentId: null, url: "https://b/" },
    ];
    const popped = popSavedForTab(queue, { ...baseCtx, url: "about:blank" });
    expect(popped).toBeNull();
    expect(queue).toHaveLength(2);
  });

  test("priority 3: FIFO — only fires when inSessionRestore", () => {
    const queue: SavedNode[] = [
      { id: 1, parentId: null, url: "" },
      { id: 2, parentId: null, url: "" },
    ];
    expect(popSavedForTab(queue, baseCtx)).toBeNull();
    expect(queue).toHaveLength(2);
    const popped = popSavedForTab(queue, { ...baseCtx, inSessionRestore: true });
    expect(popped?.id).toBe(1);
    expect(queue).toHaveLength(1);
  });

  test("FIFO returns null on empty queue (even with inSessionRestore)", () => {
    const queue: SavedNode[] = [];
    expect(popSavedForTab(queue, { ...baseCtx, inSessionRestore: true })).toBeNull();
  });
});
