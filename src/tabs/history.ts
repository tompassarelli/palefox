// Temporal workspace history — palefox's append-only event log over SQLite.
//
// Public API (factory): see HistoryAPI below.
//
// Storage shape: one SQLite file at <profile>/palefox-history.sqlite.
//   - events            row per meaningful workspace mutation, hash-deduped
//   - events_search_content   per-tab url/label rows, kept in sync via app code
//   - event_search      FTS5 virtual table over the search-content
//
// See docs/dev/multi-session-architecture.md for the design rationale.
//
// Crash safety: WAL journalling means a crash mid-INSERT rolls back; the
// last successful commit is durable. Hash dedupe runs in-memory before
// touching the DB so we don't pay a write cost for no-op saves.

import { createLogger, type Logger } from "./log.ts";
import type { SavedNode } from "./types.ts";


// =============================================================================
// INTERFACE
// =============================================================================

/** Snapshot envelope — what gets serialized into the events.snapshot column. */
export interface SnapshotEnvelope {
  /** Tab nodes in canonical (gBrowser.tabs) order, plus group nodes. */
  readonly nodes: readonly SavedNode[];
  /** Recently-closed tabs queue (capped by CLOSED_MEMORY in constants.ts). */
  readonly closedTabs: readonly SavedNode[];
  /** Highest pfx-id assigned so far (so reload doesn't collide). */
  readonly nextTabId: number;
}

/** A single row from the events table, decoded for callers. */
export interface HistoryEvent {
  readonly id: number;
  readonly timestamp: number;
  readonly hash: string;
  readonly snapshot: SnapshotEnvelope;
  /** null = untagged, "session:<label>" or "checkpoint:<label>" = tagged. */
  readonly tag: string | null;
  /** Stable per-Firefox-profile id. Always equals THIS profile's instanceId
   *  in practice — we only ever read rows we wrote ourselves. Kept on the
   *  schema (instead of dropped) because the v2 migration already ran on
   *  users' DBs; ripping it out would need a v2→v1 migration which is
   *  more code than the ~36 bytes/row this costs. If we ever build
   *  cross-profile search, the data is already there. */
  readonly instanceId: string;
}

export interface HistoryAPI {
  /** Append a new event if its hash differs from the last. Returns the
   *  inserted event id, or null if the snapshot was a duplicate. */
  appendEvent(snapshot: SnapshotEnvelope): Promise<number | null>;
  /** Tag the most recent event. If `kind === "session"` the label is auto-
   *  generated from the current date; otherwise the caller-supplied label
   *  is used. Returns the tagged event's id, or null if no events exist. */
  tagLatest(kind: "session" | "checkpoint", label?: string): Promise<number | null>;
  /** Most recent N tagged events, newest first. */
  getTagged(limit?: number): Promise<HistoryEvent[]>;
  /** Get an event by id. */
  getById(id: number): Promise<HistoryEvent | null>;
  /** Most recent untagged + tagged events, newest first. */
  getRecent(limit?: number): Promise<HistoryEvent[]>;
  /** Substring search across url + label. */
  search(query: string, opts?: { taggedOnly?: boolean; limit?: number }): Promise<HistoryEvent[]>;
  /** Drop untagged events older than retainDays + past maxRows. Returns
   *  the number of rows deleted. */
  runRetention(opts?: { retainDays?: number; maxRows?: number }): Promise<number>;
  /** Last computed snapshot hash (for hot-path dedupe in scheduleSave). */
  lastHash(): string | null;
  /** This Firefox profile's instanceId. See note on the schema below. */
  instanceId(): string;
  /** Close the underlying connection. Idempotent. */
  close(): Promise<void>;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

const SCHEMA_VERSION = 2;

const INSTANCE_ID_PREF = "pfx.instance.id";

/** Keep schema migrations as ordered SQL strings. Each entry migrates from
 *  index N to N+1. Adding a column tomorrow appends one entry. The v1→v2
 *  migration backfills `instance_id` separately (post-migration, in JS)
 *  because it needs the live instanceId value. */
const MIGRATIONS: readonly string[] = [
  // v0 → v1: initial schema.
  //
  // Note 1: Firefox's bundled SQLite does NOT expose FTS3/4/5 to chrome
  // scripts. Confirmed runtime probe (Firefox 149.0.2, SQLite 3.51.2). We
  // use a plain search-content table with substring queries; at our scale
  // (max ~10k events × ~100 tabs/event = 1M search rows) it completes <1s.
  //
  // Note 2: Sqlite.sys.mjs has a safety check that rejects any SQL string
  // matching /\bLIKE\b\s(?![@:?])/i — including in COMMENTS. So we keep
  // schema SQL comment-free and put explanations only in JS-side comments
  // (here). The indexes below cover prefix searches; substring searches
  // still scan but it's bounded.
  `
  CREATE TABLE events (
    id        INTEGER PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    hash      TEXT    NOT NULL UNIQUE,
    snapshot  TEXT    NOT NULL,
    tag       TEXT
  );
  CREATE INDEX events_timestamp ON events(timestamp DESC);
  CREATE INDEX events_tag       ON events(tag) WHERE tag IS NOT NULL;

  CREATE TABLE events_search_content (
    rowid    INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    url      TEXT NOT NULL,
    label    TEXT NOT NULL
  );
  CREATE INDEX esc_event ON events_search_content(event_id);
  CREATE INDEX esc_url   ON events_search_content(url);
  CREATE INDEX esc_label ON events_search_content(label);
  `,
  // v1 → v2: per-record instanceId.
  //
  // History note: this was added when we mistakenly thought "cross-instance
  // search" meant "search across multiple Firefox profiles." It actually
  // meant "search across multiple chrome windows of the same profile" —
  // a single-process problem solved by `Palefox.tabs.all()` (M12), with
  // no DB join required.
  //
  // The migration already ran on users' DBs, so the column stays. It costs
  // ~36 bytes per row and isn't read by any production code today. If
  // cross-profile search ever becomes a real ask, the data is already
  // collected and indexed — flip a switch to fan out reads across sibling
  // profiles' DBs (M11 in firefox-stability-roadmap.md).
  `
  ALTER TABLE events ADD COLUMN instance_id TEXT;
  CREATE INDEX events_instance ON events(instance_id);
  `,
];

const log: Logger = createLogger("history");

interface Connection {
  execute(sql: string, params?: any[]): Promise<any>;
  executeTransaction(fn: () => Promise<unknown>): Promise<unknown>;
  close(): Promise<void>;
}

let _conn: Connection | null = null;
let _lastHash: string | null = null;
let _instanceId: string | null = null;

/** Load (or generate-and-persist) this Firefox profile's stable
 *  palefox instance id. Stored in a Firefox pref so it survives
 *  restarts. Used as `instance_id` on every persisted history row;
 *  cross-instance queries (M11) discover sibling profiles' DBs and
 *  use their instanceId values to attribute/filter results. */
function loadInstanceId(): string {
  if (_instanceId) return _instanceId;
  let id = "";
  try { id = Services.prefs.getStringPref(INSTANCE_ID_PREF, ""); } catch {}
  if (!id) {
    // Synthesize a UUID. crypto.randomUUID is available in chrome scope.
    id = (crypto as { randomUUID(): string }).randomUUID();
    try { Services.prefs.setStringPref(INSTANCE_ID_PREF, id); } catch {}
    log("instanceId:generated", { id });
  }
  _instanceId = id;
  return id;
}

/** Hash a string to a hex sha256 digest using SubtleCrypto. We hash the
 *  canonical JSON form (keys sorted) so structurally-equal snapshots dedupe
 *  even if key order in the source object differs. */
async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Stable stringify — JSON.stringify with sorted keys at every level. We
 *  use this for hashing so {a:1,b:2} and {b:2,a:1} dedupe identically. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

async function openConnection(): Promise<Connection> {
  if (_conn) return _conn;
  const { Sqlite } = ChromeUtils.importESModule<{ Sqlite: { openConnection(opts: { path: string }): Promise<Connection> } }>(
    "resource://gre/modules/Sqlite.sys.mjs",
  );
  const path = PathUtils.join(
    Services.dirsvc.get("ProfD", Ci.nsIFile).path,
    "palefox-history.sqlite",
  );
  log("openConnection", { path });
  const conn = await Sqlite.openConnection({ path });
  // Pragmas first — these don't participate in transactions.
  await conn.execute("PRAGMA journal_mode = WAL");
  await conn.execute("PRAGMA foreign_keys = ON");
  await applyMigrations(conn);
  _conn = conn;
  await primeLastHash(conn);
  return conn;
}

async function applyMigrations(conn: Connection): Promise<void> {
  // PRAGMA user_version returns rows of {user_version: N}.
  const rows = await conn.execute("PRAGMA user_version");
  const current = rows?.[0]?.getResultByName?.("user_version") ?? 0;
  if (current >= SCHEMA_VERSION) {
    log("migrate:current", { version: current });
    return;
  }
  log("migrate:apply", { from: current, to: SCHEMA_VERSION });
  for (let v = current; v < SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) throw new Error(`palefox-history: no migration for v${v} → v${v + 1}`);
    await conn.executeTransaction(async () => {
      // Sqlite.sys.mjs's `execute` runs ONE statement; split on `;`
      // for multi-statement migrations and execute each.
      for (const stmt of sql.split(/;\s*\n/)) {
        const trimmed = stmt.trim();
        if (trimmed) await conn.execute(trimmed);
      }
      // v1 → v2: backfill instance_id on pre-existing rows. The migration
      // SQL added the column nullable; this UPDATE puts the current
      // instance's id on every legacy row (they came from THIS Firefox
      // profile, since this is a per-profile DB).
      if (v === 1) {
        const id = loadInstanceId();
        await conn.execute(
          "UPDATE events SET instance_id = ? WHERE instance_id IS NULL",
          [id],
        );
        log("migrate:backfill-instance", { id });
      }
      await conn.execute(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

async function primeLastHash(conn: Connection): Promise<void> {
  const rows = await conn.execute("SELECT hash FROM events ORDER BY id DESC LIMIT 1");
  if (rows?.length) {
    _lastHash = rows[0].getResultByName("hash");
  }
}

function dateLabel(d = new Date()): string {
  // "Session - Sun 2026/04/26 14:31"
  const dayShort = d.toLocaleDateString("en-US", { weekday: "short" });
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  return `Session - ${dayShort} ${yyyy}/${mm}/${dd} ${HH}:${MM}`;
}

function decodeRow(row: any): HistoryEvent {
  const snap = row.getResultByName("snapshot") as string;
  return {
    id: row.getResultByName("id") as number,
    timestamp: row.getResultByName("timestamp") as number,
    hash: row.getResultByName("hash") as string,
    snapshot: JSON.parse(snap),
    tag: row.getResultByName("tag") as string | null,
    instanceId: (row.getResultByName("instance_id") as string | null) ?? "",
  };
}

// (scopeClause helper removed — see history note above the v1→v2 migration.)

/** Extract (url, label) pairs from a snapshot for FTS5 indexing. */
function extractSearchableRows(snapshot: SnapshotEnvelope): Array<{ url: string; label: string }> {
  const out: Array<{ url: string; label: string }> = [];
  for (const node of snapshot.nodes) {
    const url = node.url ?? "";
    const label = node.name ?? "";
    if (url || label) out.push({ url, label });
  }
  return out;
}

export function makeHistory(): HistoryAPI {
  return {
    async appendEvent(snapshot) {
      const conn = await openConnection();
      const canon = canonicalize(snapshot);
      const hash = await sha256Hex(canon);
      if (hash === _lastHash) {
        // Hot-path dedupe: identical snapshot, no DB write.
        return null;
      }
      const ts = Date.now();
      const instId = loadInstanceId();
      let insertedId: number | null = null;
      await conn.executeTransaction(async () => {
        // INSERT OR IGNORE handles the case where another window of the same
        // profile (rare for chrome scripts but possible) wrote the same hash.
        await conn.execute(
          "INSERT OR IGNORE INTO events(timestamp, hash, snapshot, tag, instance_id) VALUES (?, ?, ?, NULL, ?)",
          [ts, hash, canon, instId],
        );
        const idRows = await conn.execute(
          "SELECT id FROM events WHERE hash = ?",
          [hash],
        );
        if (!idRows.length) return;
        insertedId = idRows[0].getResultByName("id") as number;
        // Populate search content rows.
        for (const { url, label } of extractSearchableRows(snapshot)) {
          await conn.execute(
            "INSERT INTO events_search_content(event_id, url, label) VALUES (?, ?, ?)",
            [insertedId, url, label],
          );
        }
      });
      if (insertedId !== null) {
        _lastHash = hash;
        log("appendEvent", { id: insertedId, ts, hashHead: hash.slice(0, 12) });
      }
      return insertedId;
    },

    async tagLatest(kind, label) {
      const conn = await openConnection();
      const finalLabel = label ?? (kind === "session" ? dateLabel() : "Untitled");
      const tagValue = `${kind}:${finalLabel}`;
      // Tag (or re-tag) the most recent event. If the latest event is
      // already tagged (e.g., user runs :checkpoint twice on identical
      // state), we OVERWRITE — this matches user intent ("tag this
      // moment with this label") and avoids silent failures when hash
      // dedupe means no new event was inserted.
      await conn.execute(
        `UPDATE events SET tag = ?
          WHERE id = (SELECT MAX(id) FROM events)`,
        [tagValue],
      );
      const idRows = await conn.execute(
        "SELECT id FROM events ORDER BY id DESC LIMIT 1",
      );
      const id = idRows?.[0]?.getResultByName?.("id") ?? null;
      log("tagLatest", { id, tagValue });
      return id;
    },

    async getTagged(limit = 50) {
      const conn = await openConnection();
      const rows = await conn.execute(
        `SELECT id, timestamp, hash, snapshot, tag, instance_id
           FROM events
          WHERE tag IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT ?`,
        [limit],
      );
      return rows.map(decodeRow);
    },

    async getById(id) {
      const conn = await openConnection();
      const rows = await conn.execute(
        "SELECT id, timestamp, hash, snapshot, tag, instance_id FROM events WHERE id = ?",
        [id],
      );
      return rows.length ? decodeRow(rows[0]) : null;
    },

    async getRecent(limit = 50) {
      const conn = await openConnection();
      const rows = await conn.execute(
        `SELECT id, timestamp, hash, snapshot, tag, instance_id
           FROM events
          ORDER BY timestamp DESC
          LIMIT ?`,
        [limit],
      );
      return rows.map(decodeRow);
    },

    async search(query, { taggedOnly = false, limit = 50 } = {}) {
      const conn = await openConnection();
      const trimmed = query.trim();
      if (!trimmed) return [];
      // LIKE-based substring match. Splitting on whitespace lets users do
      // multi-token queries (each token must match SOMEWHERE in url/label).
      // Escape SQL LIKE special chars (%, _) so user input is literal.
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      const escapeLike = (s: string) => s.replace(/([%_\\])/g, "\\$1");
      const conditions: string[] = [];
      const params: unknown[] = [];
      for (const tok of tokens) {
        const pat = `%${escapeLike(tok)}%`;
        conditions.push(`(esc.url LIKE ? ESCAPE '\\' OR esc.label LIKE ? ESCAPE '\\')`);
        params.push(pat, pat);
      }
      const sql = `
        SELECT events.id, events.timestamp, events.hash, events.snapshot, events.tag, events.instance_id
          FROM events
          JOIN events_search_content esc ON esc.event_id = events.id
         WHERE ${conditions.join(" AND ")}
           ${taggedOnly ? "AND events.tag IS NOT NULL" : ""}
         GROUP BY events.id
         ORDER BY events.timestamp DESC
         LIMIT ?
      `;
      params.push(limit);
      const rows = await conn.execute(sql, params);
      return rows.map(decodeRow);
    },

    async runRetention({ retainDays, maxRows } = {}) {
      const conn = await openConnection();
      const days =
        retainDays ?? Services.prefs.getIntPref("pfx.history.retainDays", 30);
      const max =
        maxRows ?? Services.prefs.getIntPref("pfx.history.maxRows", 10_000);
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      let deleted = 0;
      await conn.executeTransaction(async () => {
        // Drop untagged older than cutoff.
        await conn.execute(
          `DELETE FROM events WHERE tag IS NULL AND timestamp < ?`,
          [cutoff],
        );
        const after1 = await conn.execute(
          "SELECT changes() AS c",
        );
        const c1 = (after1?.[0]?.getResultByName?.("c") as number) ?? 0;
        deleted += c1;

        // Trim untagged past maxRows (keeping newest).
        const overflow = await conn.execute(
          `DELETE FROM events
            WHERE tag IS NULL
              AND id IN (
                SELECT id FROM events
                 WHERE tag IS NULL
                 ORDER BY timestamp ASC
                 LIMIT MAX(0, (SELECT COUNT(*) FROM events WHERE tag IS NULL) - ?)
              )`,
          [max],
        );
        const after2 = await conn.execute("SELECT changes() AS c");
        const c2 = (after2?.[0]?.getResultByName?.("c") as number) ?? 0;
        deleted += c2;
      });
      if (deleted) {
        log("runRetention", { deleted, retainDays: days, maxRows: max });
      }
      return deleted;
    },

    lastHash() {
      return _lastHash;
    },

    instanceId() {
      return loadInstanceId();
    },

    async close() {
      if (_conn) {
        try { await _conn.close(); } catch {}
        _conn = null;
        _lastHash = null;
      }
    },
  };
}
