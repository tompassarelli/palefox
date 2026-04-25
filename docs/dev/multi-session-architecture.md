# Palefox temporal workspace architecture

This document is the architectural plan for palefox's history + multi-session
feature. Generated from a research dive across Firefox SessionStore source
(`~/code/firefox/browser/components/sessionstore/`), Mozilla's
`Sqlite.sys.mjs` (`~/code/firefox/toolkit/modules/`), Sidebery / TST / Zen
implementations, and our existing single-session persistence.

Read this before touching `src/tabs/persist.ts`, `src/tabs/history.ts`, or
session-restore code.

---

## Vision

> Palefox treats browsing as a **durable, temporal workspace**, not
> disposable tab state. Every meaningful workspace mutation is captured.
> Some moments are tagged (Firefox quits → automatic sessions; user
> `:checkpoint <label>` → manual saves). The user can `:restore` any
> tagged point as a subtree under a synthetic group node, **without
> wiping current state.** They can search across all history by URL or
> label.

---

## Storage primitive: SQLite (single file)

```
<profile>/
└── palefox-history.sqlite      single source of truth, WAL-journalled
```

That's it. **No `palefox-tab-tree.json`. No history JSONL files. No
checkpoint files. No session-index file.** One database, one file, one
source of truth.

### Why SQLite over JSON

We considered JSONL files + an index file. Reasons SQLite won:

1. **Indexed substring search** scales adequately as data grows.
   Originally planned FTS5 — runtime probe (Firefox 149.0.2,
   SQLite 3.51.2) confirms that chrome scripts get **none** of FTS3,
   FTS4, or FTS5. Mozilla's bundled SQLite doesn't compile them in.
   We use indexed LIKE-based search on a denormalized
   `events_search_content` table. At our scale (≤10k events × ≤100
   tabs/event = ≤1M rows) substring LIKE completes in <1s; prefix
   LIKE uses the index.

   **Considered and rejected: sqlite-wasm.** The bundle cost (~1MB)
   isn't the killer; it's the persistence story. sqlite-wasm's standard
   persistence layers (OPFS, kvvfs) don't work in chrome scope:
   - OPFS requires SharedArrayBuffer + COOP/COEP headers, broken for
     extensions per [bugzilla 1823260](https://bugzilla.mozilla.org/show_bug.cgi?id=1823260).
   - kvvfs uses localStorage, not available in chrome scope.
   - Custom VFS over IOUtils: IOUtils is async-only, no file handles,
     wrong shape for SQLite's pager (random reads/writes, locks, sync).
     Building it is "we wrote a fake filesystem to run SQLite while
     Firefox already contains SQLite."
   When the platform ships SQLite, ship-your-own-SQLite is the wrong
   move. Native wins.

   **Considered and deferred: Datahike / DataScript / Cozo.** Datalog
   over our data is genuinely interesting for AI-driven queries
   ("find tabs in this project", "show workspace as-of last Tuesday").
   But: SQLite already supports `WITH RECURSIVE` for tree descendant
   queries and timestamp filtering for as-of queries. SQL-with-CTEs is
   90% of what Datalog gives us at zero additional dependency. If
   palefox grows AI features and we need richer query semantics, layer
   DataScript on top of native SQLite (durable substrate stays
   SQLite, DataScript provides in-memory hot index) — don't replace.
2. **WAL mode = atomicity by construction.** Crash mid-write → transaction
   rolled back, no corruption. With JSON we'd be hand-rolling temp-file-
   then-rename atomicity.
3. **Indexed lookups.** "Sessions from last week" is a `WHERE timestamp
   BETWEEN ?` with an index. With JSON files chunked by day, it's "find
   files, parse, scan, filter."
4. **Retention is one DELETE statement.** With files, it's "iterate
   directory, parse dates, delete olds, handle race conditions."
5. **Mozilla's `Sqlite.sys.mjs` is the platform-native API.** Promise-
   based, async, full chrome-scope access via
   `ChromeUtils.importESModule("resource://gre/modules/Sqlite.sys.mjs")`.
   Firefox stores its own session/places/cookies in SQLite — we're
   aligned with the platform.

### Why one source of truth

Earlier we maintained `palefox-tab-tree.json` (palefox state) alongside
Firefox's `sessionstore.jsonlz4` (Firefox state). The two could disagree
about what tabs existed, and `popSavedForTab`'s reconciliation chain
(pfx-id → URL → FIFO) couldn't always bridge the gap. Drift between
saves caused tabs to come back without parents.

By making SQLite our **only** persistence, the drift problem can't
happen *within palefox*. We still rely on Firefox's SessionStore to
restore the *tabs themselves* (via `persistTabAttribute("pfx-id")`),
but our entire tree state is one query away.

---

## Schema

```sql
-- One row per meaningful workspace mutation, hash-deduped.
CREATE TABLE events (
  id        INTEGER PRIMARY KEY,
  timestamp INTEGER NOT NULL,    -- Date.now()
  hash      TEXT    NOT NULL UNIQUE,    -- sha256 of canonical(snapshot)
  snapshot  TEXT    NOT NULL,    -- JSON-encoded full SavedTree
  tag       TEXT             -- null untagged; else "session:<label>" or "checkpoint:<label>"
);
CREATE INDEX events_timestamp ON events(timestamp DESC);
CREATE INDEX events_tag       ON events(tag) WHERE tag IS NOT NULL;

-- Full-text search over each event's tab URLs and labels. Populated via
-- triggers when an event is inserted; stays in sync automatically.
CREATE VIRTUAL TABLE event_search USING fts5(
  url, label,
  content='events_search_content',
  content_rowid='event_id'
);

-- Materialized view over the JSON snapshot — extracted at insert time
-- so FTS5 can index it. One row per (event, tab).
CREATE TABLE events_search_content (
  rowid    INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  url      TEXT NOT NULL,
  label    TEXT NOT NULL
);
CREATE INDEX esc_event ON events_search_content(event_id);

PRAGMA user_version = 1;
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
```

### Schema migration discipline

`PRAGMA user_version` tracks schema version. The history module owns a
migrations array — `[v1 → v2 SQL, v2 → v3 SQL, ...]`. On open, we
read user_version and apply pending migrations in a single transaction.
Adding a column tomorrow is a one-line addition.

---

## Save flow (the hot path)

Every meaningful workspace mutation triggers `scheduleSave`, which
debounces. When the debounced call fires:

```
1. Build canonical snapshot (current TreeData + groups + closedTabs + nextTabId)
2. Compute sha256 hash of canonical JSON form
3. If hash === lastHistoryHash → no-op (clean dedupe; no event written)
4. Else:
     a. INSERT INTO events (timestamp, hash, snapshot, tag=null) VALUES (?, ?, ?)
     b. Extract tab URLs/labels into events_search_content for FTS5
     c. Update lastHistoryHash
```

The hash dedupe is the key correctness property. `scheduleSave` may fire
without the tree actually changing (e.g., a no-op resync); without
dedupe we'd write redundant events and pollute search results.
With dedupe, every event represents a real workspace mutation.

### Tagged points

- **Firefox quit:** `quit-application` observer runs:
  ```sql
  UPDATE events SET tag = 'session:Session - Sun 2026/04/26 14:31'
   WHERE id = (SELECT MAX(id) FROM events);
  ```
- **`:checkpoint <label>`:** Same UPDATE with `tag = 'checkpoint:<label>'`.
- A tagged event is **immune to retention.** Only untagged events get
  pruned by age.

---

## Retention policy

Two caps, configurable via prefs:

- `pfx.history.retainDays` (default 30) — drop untagged events older than this
- `pfx.history.maxRows` (default 10_000) — drop oldest untagged events past this

A retention pass runs:
- At Firefox startup (idle, after delayed-startup-finished)
- Every ~10 minutes during long sessions

```sql
DELETE FROM events
 WHERE tag IS NULL
   AND (timestamp < ? OR id IN (
     SELECT id FROM events WHERE tag IS NULL
      ORDER BY timestamp ASC
      LIMIT MAX(0, (SELECT COUNT(*) FROM events WHERE tag IS NULL) - ?)
   ));
VACUUM;  -- reclaim space, periodically not every pass
```

Tagged events are forever. Disk usage is bounded by `tagged events × snapshot size + retainDays × event rate × snapshot size`. For a heavy user (1000 events/day, 50KB/snapshot, 100 tagged sessions): 30 × 1000 × 50KB + 100 × 50KB ≈ 1.5GB. We'll add gzip on the snapshot blob in a later phase if that becomes a concern; for v1 the WAL file size is the metric to watch.

---

## Restore semantics

### `:restore` UX

Lists tagged events (sessions + checkpoints), date-sorted, most recent
first. User picks one. The action:

1. Load the chosen event's `snapshot` (JSON-decode → SavedNode array)
2. Re-key all pfx-ids in the saved snapshot: `id += state.nextTabId` and
   bump nextTabId past the new max. This guarantees no collisions with
   currently-live tabs.
3. Build a synthetic Group row: `{ id: "g-restored-<timestamp>", name:
   "Session - Sun 2026/04/26", level: 0, ... }`
4. Rewrite root parentages in the saved nodes: `parentId === null` →
   `parentId = synthetic group id`
5. Insert the group + saved nodes into `state.savedTabQueue`
6. For each saved tab, `gBrowser.addTab(url, ...)` — the existing
   `onTabOpen` → `popSavedForTab` chain wires each into its parent

Result: restored tree appears as a subtree under the group, **current
tabs untouched.**

### `:restore --raw <timestamp>`

Same flow but accepts an arbitrary event timestamp (untagged or tagged).
This is the power-user recovery hatch — surface in `:history`.

---

## Search

### `:sessions <query>`

FTS5 query over tagged events:

```sql
SELECT events.id, events.timestamp, events.tag,
       COUNT(DISTINCT esc.rowid) AS matches
FROM events
JOIN events_search_content esc ON esc.event_id = events.id
JOIN event_search ON event_search.rowid = esc.rowid
WHERE event_search MATCH ?
  AND events.tag IS NOT NULL
GROUP BY events.id
ORDER BY events.timestamp DESC
LIMIT 50;
```

Returns ranked list with match counts. Sub-millisecond on tens of
thousands of events.

### `:history` and `:history <query>`

Same query without the `tag IS NOT NULL` filter. Shows raw timeline.

---

## Session boundary: Firefox quit

Aligned with the user's mental model: "where was I when I last left
the browser?" Multi-window sessions bundle together — all open windows
during a session belong to one session entry.

Window close ≠ session boundary. A user who closes one window of two
isn't ending their session; they're tidying.

---

## Seven testable open questions (Tier 3 substrate covers these)

1. **WAL durability under SIGKILL.** Insert a row, kill Firefox via the
   OS, restart, verify the row is there. Confirms our crash-safety claim.
2. **FTS5 search latency** at 10k events. Insert synthetic events, time
   substring searches. Establishes our perf budget.
3. **Restore-into-group correctness** — the original failing test
   becomes the canonical fixture. Build a tree, save event, restore,
   verify nesting under synthetic group.
4. **Hash dedupe** — many no-op `scheduleSave` fires write zero new
   events.
5. **Retention** — events older than `retainDays` get evicted; tagged
   events don't.
6. **Schema migration** — add a fake v1→v2 migration, simulate older
   db file, verify migration succeeds.
7. **Multi-window save consistency** — events fired from different
   windows during the same session don't corrupt state.

---

## Implementation phases

### Phase 1 — SQLite substrate
- New `src/tabs/history.ts` module wrapping `Sqlite.sys.mjs`
- Schema + migrations
- `appendEvent({ snapshot })` with hash dedupe
- `tagLatest(tag)`, `getTagged(limit)`, `getById(id)`
- `searchTagged(query)`, `searchAll(query)` via FTS5
- `runRetention()` background pass
- Replace `writeTreeToDisk` / `readTreeFromDisk` callsites
- `quit-application` observer creates auto-tagged session
- Tier 3 integration tests for the substrate operations

### Phase 2 — Restore UX
- `:restore` ex-command (lists tagged points, opens picker, performs flow)
- `:checkpoint <label>` ex-command (tags latest event)
- Re-key + synthetic-group + queue-into-onTabOpen flow
- Integration test: build tree → save → close all → :restore → tree returns nested under group

### Phase 3 — Search UX
- `:sessions [query]` ex-command — list tagged + optional FTS5 filter
- `:history [query]` ex-command — full timeline + optional filter
- Result UI in modeline (TBD shape — inline list, popup, dedicated panel)

### Phase 4 — Power user / polish
- `:restore --raw <id>` from history view
- Configurable retention prefs
- Periodic VACUUM
- Compression on snapshot column if disk becomes a concern

---

## What we're explicitly not doing in v1

- **Deltas.** Each event is a full snapshot. Deltas are seductive
  premature optimization at our scale; we'd burn implementation time on
  replay logic and corruption surface area. JSON-encoded snapshots
  compress 10× with gzip if we need to revisit later.
- **Cross-device sync.** Each profile has its own history. Sync layer
  is a separate, much larger project.
- **Tab content snapshots.** We store URL + label + tree. Restored tabs
  re-fetch content. SessionStore handles content for the *current*
  session; for restored older sessions, content is re-fetched fresh.
- **Inferred tagging** ("automatically tag interesting moments"). Too
  fuzzy; user explicitly tags via `:checkpoint`.
- **Undo across history events.** Each event is a save point, not a
  reversible op. Restore is the only "undo" primitive.

---

## Risks / tradeoffs we accept

- **SQLite operational complexity.** Schema migrations, WAL file
  management. Mitigated by Mozilla's `Sqlite.sys.mjs` covering all the
  hard parts (transactions, shutdown barriers, async lifecycle).
- **No backward compat with the old `palefox-tab-tree.json` format.**
  Acceptable: project has handful of users, no install base to protect.
  First run on a profile with the old file logs a warning, ignores it,
  proceeds with empty SQLite. User can re-checkpoint manually.
- **Single-file blast radius.** A corrupt `palefox-history.sqlite`
  would lose all history. Mitigated by WAL journalling, periodic
  integrity checks (`PRAGMA integrity_check`), and the option to
  export tagged events to JSON for backup.
