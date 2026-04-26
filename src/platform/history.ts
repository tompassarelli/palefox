// Persisted-state APIs — Palefox.history / .sessions / .checkpoints.
//
// Wraps `src/tabs/history.ts` with the scope-parameterized contract
// from the strategy doc:
//
//   Palefox.history.recent({ scope: "current" | "all" })
//   Palefox.history.search(q, { scope })
//   Palefox.sessions.list({ scope })       — sessions = auto-tagged (kind="session")
//   Palefox.checkpoints.list({ scope })    — checkpoints = user-tagged (kind="checkpoint")
//
// Today, scope: "current" filters by the running profile's instanceId.
// scope: "all" returns all rows in this DB (just current's data, since
// each DB is per-profile). M11 extends scope: "all" to fan out across
// sibling profiles' DBs and merge results.
//
// Default scope is "current" everywhere — keeps the common case fast
// and surprise-free; cross-instance is opt-in per call.

import type { HistoryAPI, HistoryEvent, HistoryScope } from "../tabs/history.ts";

// =============================================================================
// INTERFACE
// =============================================================================

export type ScopeOpts = { readonly scope?: HistoryScope };
export type LimitedScopeOpts = ScopeOpts & { readonly limit?: number };
export type SearchOpts = LimitedScopeOpts & { readonly taggedOnly?: boolean };

export type PalefoxHistoryAPI = {
  /** Most recent N events, newest first. Untagged + tagged. */
  recent(opts?: LimitedScopeOpts): Promise<readonly HistoryEvent[]>;
  /** Substring search across url + label. Multi-token queries match
   *  if EVERY token appears somewhere in url or label. */
  search(query: string, opts?: SearchOpts): Promise<readonly HistoryEvent[]>;
  /** Lookup by event id. Skips scope (id is unique per DB). */
  byId(id: number): Promise<HistoryEvent | null>;
  /** This profile's stable instanceId. Surfaced for diagnostics + tests. */
  instanceId(): string;
};

export type PalefoxTaggedAPI = {
  /** All tagged events of a kind, newest first. */
  list(opts?: LimitedScopeOpts): Promise<readonly HistoryEvent[]>;
  /** Substring filter. Backed by the same search index, restricted to tagged. */
  search(query: string, opts?: LimitedScopeOpts): Promise<readonly HistoryEvent[]>;
};

export type PersistedAPI = {
  history: PalefoxHistoryAPI;
  /** User-tagged checkpoints (`:checkpoint <label>`). */
  checkpoints: PalefoxTaggedAPI & {
    /** Tag the latest event as a checkpoint. */
    tag(label?: string): Promise<number | null>;
  };
  /** Auto-tagged sessions (created on quit-application). */
  sessions: PalefoxTaggedAPI & {
    /** Tag the latest event as a session. Used by the quit-application observer. */
    tag(label?: string): Promise<number | null>;
  };
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makePersisted(history: HistoryAPI): PersistedAPI {
  function isOfKind(kind: "session" | "checkpoint") {
    const prefix = `${kind}:`;
    return (e: HistoryEvent) => typeof e.tag === "string" && e.tag.startsWith(prefix);
  }

  return {
    history: {
      async recent(opts) {
        return history.getRecent(opts?.limit ?? 50, opts?.scope ?? "current");
      },
      search(query, opts) {
        return history.search(query, {
          taggedOnly: opts?.taggedOnly ?? false,
          limit: opts?.limit ?? 50,
          scope: opts?.scope ?? "current",
        });
      },
      byId(id) {
        return history.getById(id);
      },
      instanceId() {
        return history.instanceId();
      },
    },

    checkpoints: {
      async list(opts) {
        const all = await history.getTagged(opts?.limit ?? 100, opts?.scope ?? "current");
        return all.filter(isOfKind("checkpoint"));
      },
      async search(query, opts) {
        const matches = await history.search(query, {
          taggedOnly: true,
          limit: opts?.limit ?? 50,
          scope: opts?.scope ?? "current",
        });
        return matches.filter(isOfKind("checkpoint"));
      },
      tag(label) {
        return history.tagLatest("checkpoint", label);
      },
    },

    sessions: {
      async list(opts) {
        const all = await history.getTagged(opts?.limit ?? 100, opts?.scope ?? "current");
        return all.filter(isOfKind("session"));
      },
      async search(query, opts) {
        const matches = await history.search(query, {
          taggedOnly: true,
          limit: opts?.limit ?? 50,
          scope: opts?.scope ?? "current",
        });
        return matches.filter(isOfKind("session"));
      },
      tag(label) {
        return history.tagLatest("session", label);
      },
    },
  };
}
