# docs/dev/

Cross-session context for AI-assisted work on palefox. CLAUDE.md is the
always-loaded primer; everything in this directory is reference you read
**before** doing the work it describes, not while passing through.

## Index

### Architecture & strategy

- [**testing.md**](testing.md) — 4-tier test plan, sprint checklist, and
  the rules for which tier covers which surface. Read end-to-end before
  doing test work.
- [**multi-session-architecture.md**](multi-session-architecture.md) —
  SQLite temporal substrate (`history.ts`): event log shape, retention,
  hash dedupe, why JSON was retired, FTS deferred.
- [**sidebar-design-plan.md**](sidebar-design-plan.md) — why we replaced
  Sidebery with a chrome-context implementation.
- [**firefox-internals.md**](firefox-internals.md) — Firefox APIs,
  events, and DOM surfaces palefox depends on. Read before any rewrite.

### State machines & UX dissertations

- [**compact-mode-dissertation.md**](compact-mode-dissertation.md) —
  forensic analysis of palefox / Zen / Firefox-native compact behavior.
  Source of truth for `src/drawer/compact.ts`'s state model.
- [**compact-mode-zen-audit.md**](compact-mode-zen-audit.md) — port log
  for what we took from Zen Browser's `ZenCompactMode.mjs` and what we
  skipped.

### Operational notes

- [**dev-notes.md**](dev-notes.md) — DOM reparenting constraints
  (toolbox into sidebar, urlbar breakout, context menu fix). Living doc
  for layout-restructure tripwires.
- [**context-menu-items.md**](context-menu-items.md) — backlog of items
  for the tab / chrome context menus, with API hints.

### Post-mortems

- [**postmortem-content-focus.md**](postmortem-content-focus.md) — v0.40.0
  content-focus iteration. The TDD discipline rule in CLAUDE.md was
  written from this.

### Reference dumps

- [**chrome-reference/**](chrome-reference/) — `dump-chrome-dom.js`
  (paste into Browser Console to dump chrome DOM with hidden/style hints
  to `~/chrome-dom.txt`) and other one-shot probes.
- [**browser-tab-implementation-studies/**](browser-tab-implementation-studies/) —
  case studies of Firefox native, Sidebery, Zen tab implementations.

### Archive

- [**archive/**](archive/) — superseded snapshots and pre-refactor audits.
  Kept for historical reference; do not read for current guidance.
