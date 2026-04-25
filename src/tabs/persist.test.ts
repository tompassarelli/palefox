// Pure-function tests for persist.ts.
//
// The persist module is split so the on-disk-touching functions (writeTreeToDisk,
// readTreeFromDisk) wrap pure (de)serialization helpers (serializeState,
// parseLoaded) plus pure queue manipulators. Those pure pieces are what we
// test here — no chrome globals, no IO. Nothing in this file requires JSDOM
// or a Firefox harness; it runs under plain `bun test`.
//
// What's covered:
//   serializeState → JSON.parse round-trip
//     - tabs in canonical order with their TreeData
//     - groups with afterTabId anchored to the most recent preceding tab
//     - savedTabQueue leftovers preserved (and de-duped against live URLs)
//   parseLoaded
//     - happy path (modern tree-file)
//     - malformed JSON / missing nodes → null
//     - legacy migration: derives parentId from level+order when missing
//   popSavedByUrl / popSavedByIndex / popSavedForTab queue helpers
//     - splice-mutates queue
//     - prefers pfx-id, falls back to URL, then FIFO under inSessionRestore

import { describe, expect, test } from "bun:test";

import {
  parseLoaded,
  popSavedByIndex,
  popSavedByUrl,
  popSavedForTab,
  serializeState,
  type Snapshot,
} from "./persist.ts";
import type { Row, SavedNode, Tab, TreeData } from "./types.ts";

// === Test helpers ============================================================

/** Cast a plain object to a Tab — persist.ts only ever uses the tab as an
 *  opaque key into the snapshot's treeData/tabUrl maps. The actual properties
 *  on Tab are irrelevant for these tests. */
function fakeTab(name: string): Tab {
  return { __testTab: name } as unknown as Tab;
}

function fakeGroupRow(group: { id: string; name: string; level: number; collapsed: boolean }): Row {
  return { _group: { ...group, type: "group", state: null } } as unknown as Row;
}

function fakeTabRow(tab: Tab): Row {
  return { _tab: tab } as unknown as Row;
}

/** Build a Snapshot from a tabs-and-trees fixture. Defaults fill in URL, name,
 *  state, and collapsed sensibly so individual tests only override what they
 *  care about. */
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

// === serializeState ==========================================================

describe("serializeState", () => {
  test("emits tab nodes in canonical order with their TreeData", () => {
    const a = fakeTab("a");
    const b = fakeTab("b");
    const c = fakeTab("c");
    const snap = makeSnapshot({
      tabs: [a, b, c],
      treeData: new Map([
        [a, td(1)],
        [b, td(2, 1)],         // child of a
        [c, td(3, 2, { collapsed: true })],
      ]),
      urls: new Map([
        [a, "https://a.test/"],
        [b, "https://b.test/"],
        [c, "https://c.test/"],
      ]),
    });
    const parsed = JSON.parse(serializeState(snap));
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.nodes[0]).toMatchObject({ type: "tab", id: 1, parentId: null, url: "https://a.test/" });
    expect(parsed.nodes[1]).toMatchObject({ type: "tab", id: 2, parentId: 1, url: "https://b.test/" });
    expect(parsed.nodes[2]).toMatchObject({ type: "tab", id: 3, parentId: 2, url: "https://c.test/", collapsed: true });
  });

  test("group entries carry afterTabId of the last preceding tab", () => {
    const a = fakeTab("a");
    const b = fakeTab("b");
    const grp = fakeGroupRow({ id: "g1", name: "Work", level: 1, collapsed: false });
    const snap = makeSnapshot({
      tabs: [a, b],
      treeData: new Map([[a, td(10)], [b, td(11, 10)]]),
      // Row order: tabA, group, tabB → group anchors after tabA (id 10)
      rows: [fakeTabRow(a), grp, fakeTabRow(b)],
    });
    const parsed = JSON.parse(serializeState(snap));
    const groupNode = parsed.nodes.find((n: SavedNode) => n.type === "group");
    expect(groupNode).toBeDefined();
    expect(groupNode.afterTabId).toBe(10);
    expect(groupNode.name).toBe("Work");
    expect(groupNode.level).toBe(1);
  });

  test("group with no preceding tab gets afterTabId: null", () => {
    const a = fakeTab("a");
    const grp = fakeGroupRow({ id: "g1", name: "Top", level: 0, collapsed: false });
    const snap = makeSnapshot({
      tabs: [a],
      treeData: new Map([[a, td(1)]]),
      rows: [grp, fakeTabRow(a)], // group before any tab
    });
    const parsed = JSON.parse(serializeState(snap));
    const groupNode = parsed.nodes.find((n: SavedNode) => n.type === "group");
    expect(groupNode.afterTabId).toBeNull();
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
    const parsed = JSON.parse(serializeState(snap));
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.nodes[1]).toMatchObject({ id: 99, url: "https://stale.test/", type: "tab" });
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
    const parsed = JSON.parse(serializeState(snap));
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.nodes.find((n: SavedNode) => n.id === 50)).toBeUndefined();
    expect(parsed.nodes.find((n: SavedNode) => n.id === 51)).toBeDefined();
  });

  test("includes closedTabs and nextTabId in the envelope", () => {
    const closed: SavedNode = { id: 7, parentId: null, url: "https://closed.test/" };
    const snap = makeSnapshot({
      tabs: [],
      treeData: new Map(),
      closedTabs: [closed],
      nextTabId: 42,
    });
    const parsed = JSON.parse(serializeState(snap));
    expect(parsed.closedTabs).toEqual([closed]);
    expect(parsed.nextTabId).toBe(42);
  });
});

// === parseLoaded =============================================================

describe("parseLoaded", () => {
  test("returns null on malformed JSON", () => {
    expect(parseLoaded("not json")).toBeNull();
    expect(parseLoaded("")).toBeNull();
    expect(parseLoaded("{}")).toBeNull();           // missing nodes
    expect(parseLoaded("[]")).toBeNull();           // root must be object
    expect(parseLoaded(JSON.stringify({ nodes: "x" }))).toBeNull();
  });

  test("happy path — modern format round-trips through serialize", () => {
    const a = fakeTab("a");
    const b = fakeTab("b");
    const snap = makeSnapshot({
      tabs: [a, b],
      treeData: new Map([[a, td(1)], [b, td(2, 1)]]),
      nextTabId: 99,
    });
    const text = serializeState(snap);
    const loaded = parseLoaded(text);
    expect(loaded).not.toBeNull();
    expect(loaded!.tabNodes).toHaveLength(2);
    expect(loaded!.nextTabId).toBe(99);
  });

  test("legacy migration: parentId derived from level when missing", () => {
    // Old format: nodes carry a `level` field but no parentId. parseLoaded
    // walks a stack to compute parents.
    const text = JSON.stringify({
      nodes: [
        { type: "tab", id: 1, level: 0, url: "https://a/" },
        { type: "tab", id: 2, level: 1, url: "https://b/" },  // child of 1
        { type: "tab", id: 3, level: 2, url: "https://c/" },  // child of 2
        { type: "tab", id: 4, level: 1, url: "https://d/" },  // back up: child of 1
        { type: "tab", id: 5, level: 0, url: "https://e/" },  // root
      ],
    });
    const loaded = parseLoaded(text);
    expect(loaded).not.toBeNull();
    expect(loaded!.tabNodes[0]!.parentId).toBeNull();
    expect(loaded!.tabNodes[1]!.parentId).toBe(1);
    expect(loaded!.tabNodes[2]!.parentId).toBe(2);
    expect(loaded!.tabNodes[3]!.parentId).toBe(1);
    expect(loaded!.tabNodes[4]!.parentId).toBeNull();
  });

  test("nextTabId only accepted as integer; otherwise null", () => {
    expect(parseLoaded(JSON.stringify({ nodes: [], nextTabId: 7 }))!.nextTabId).toBe(7);
    expect(parseLoaded(JSON.stringify({ nodes: [], nextTabId: "7" }))!.nextTabId).toBeNull();
    expect(parseLoaded(JSON.stringify({ nodes: [], nextTabId: 1.5 }))!.nextTabId).toBeNull();
    expect(parseLoaded(JSON.stringify({ nodes: [] }))!.nextTabId).toBeNull();
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
    // Without inSessionRestore: no match → null, queue intact
    expect(popSavedForTab(queue, baseCtx)).toBeNull();
    expect(queue).toHaveLength(2);
    // With inSessionRestore: takes the head
    const popped = popSavedForTab(queue, { ...baseCtx, inSessionRestore: true });
    expect(popped?.id).toBe(1);
    expect(queue).toHaveLength(1);
  });

  test("FIFO returns null on empty queue (even with inSessionRestore)", () => {
    const queue: SavedNode[] = [];
    expect(popSavedForTab(queue, { ...baseCtx, inSessionRestore: true })).toBeNull();
  });
});
