// Shared mutable state for src/tabs/* modules.
//
// Strategy: WeakMaps and collections live as named exports — they're
// pass-by-reference, so importers see writes immediately. Scalar singletons
// (panel, cursor, etc.) stay inside the legacy index.ts for now and migrate
// into a `state` object here only when a typed slice needs to write them.
//
// Growth principle: this file expands ONLY when a typed module forces it.
// We don't lift state preemptively.

import type { Row, SavedNode, Tab, TreeData } from "./types.ts";

// --- Tab metadata, keyed by native Firefox tab ---

/** Per-tab tree metadata. Set on first treeData(tab) call; mutated by event
 *  handlers and persist's applySavedToTab. */
export const treeOf = new WeakMap<Tab, TreeData>();

/** Tab → palefox row element. Set by createTabRow, deleted by onTabClose. */
export const rowOf = new WeakMap<Tab, Row>();

/** Row → tab whose visuals to show (used in horizontal-mode collapse, where a
 *  collapsed parent row may visually mirror a different descendant tab). */
export const hzDisplay = new WeakMap<Row, Tab>();

// --- Session-restore + persistence collections ---

/** Saved-tab nodes left over from last session's tree file after the load-time
 *  positional match. Consumed by event handlers as session-restore tabs arrive. */
export const savedTabQueue: SavedNode[] = [];

/** Recently-closed tabs (FIFO, capped by CLOSED_MEMORY in constants.ts). Used
 *  to restore tree hierarchy on Ctrl+Shift+T. */
export const closedTabs: SavedNode[] = [];
