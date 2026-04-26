// Persisted-state APIs — Palefox.history / .sessions / .checkpoints.
//
// Thin capability layer over `src/tabs/history.ts`. Same shapes, palefox-
// domain naming. New feature code should call these instead of reaching
// for the HistoryAPI directly.
//
// Scope: today this is always "this Firefox profile's events" — single
// running palefox = single SQLite, single set of rows. Cross-profile
// search (M11 in firefox-stability-roadmap.md) would extend this with
// fanout across sibling profile DBs; not built today.

import type { HistoryAPI, HistoryEvent } from "../tabs/history.ts";

// =============================================================================
// INTERFACE
// =============================================================================

export type LimitedOpts = { readonly limit?: number };
export type SearchOpts = LimitedOpts & { readonly taggedOnly?: boolean };

export type PalefoxHistoryAPI = {
  /** Most recent N events, newest first. Untagged + tagged. */
  recent(opts?: LimitedOpts): Promise<readonly HistoryEvent[]>;
  /** Substring search across url + label. Multi-token queries match
   *  if EVERY token appears somewhere in url or label. */
  search(query: string, opts?: SearchOpts): Promise<readonly HistoryEvent[]>;
  /** Lookup by event id. */
  byId(id: number): Promise<HistoryEvent | null>;
  /** This profile's stable instanceId. Surfaced for diagnostics + tests. */
  instanceId(): string;
};

export type PalefoxTaggedAPI = {
  /** All tagged events of a kind, newest first. */
  list(opts?: LimitedOpts): Promise<readonly HistoryEvent[]>;
  /** Substring filter. Backed by the same search index, restricted to tagged. */
  search(query: string, opts?: LimitedOpts): Promise<readonly HistoryEvent[]>;
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
      recent(opts) {
        return history.getRecent(opts?.limit ?? 50);
      },
      search(query, opts) {
        return history.search(query, {
          taggedOnly: opts?.taggedOnly ?? false,
          limit: opts?.limit ?? 50,
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
        const all = await history.getTagged(opts?.limit ?? 100);
        return all.filter(isOfKind("checkpoint"));
      },
      async search(query, opts) {
        const matches = await history.search(query, {
          taggedOnly: true,
          limit: opts?.limit ?? 50,
        });
        return matches.filter(isOfKind("checkpoint"));
      },
      tag(label) {
        return history.tagLatest("checkpoint", label);
      },
    },

    sessions: {
      async list(opts) {
        const all = await history.getTagged(opts?.limit ?? 100);
        return all.filter(isOfKind("session"));
      },
      async search(query, opts) {
        const matches = await history.search(query, {
          taggedOnly: true,
          limit: opts?.limit ?? 50,
        });
        return matches.filter(isOfKind("session"));
      },
      tag(label) {
        return history.tagLatest("session", label);
      },
    },
  };
}
