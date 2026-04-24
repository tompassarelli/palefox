# Sidebar Design Plan

## Why replace Sidebery

Palefox aims to replace Sidebery with a native sidebar implementation built directly in `chrome/JS/`. Two fundamental problems make Sidebery unsuitable as a long-term dependency.

**Performance at scale.** Sidebery renders every tab as a full Vue component with no virtual scrolling, runs an O(n) full panel recalculation on every tab event, and triggers cascading Vue reactivity on direct array mutations. The system degrades noticeably around 200–300 tabs. See [`browser-tab-implementation-studies/sidebery.md`](browser-tab-implementation-studies/sidebery.md) for the full breakdown.

**iframe isolation.** Sidebery runs in a WebExtension sidebar panel — an iframe with no access to `gBrowser`, no chrome JS, no DOM integration. Every tab operation is an async round-trip through the WebExtension messaging layer. Implementing autohide, compact mode, command palette, or any chrome-integrated UI is impossible without a fork.

A `chrome/JS/` implementation runs in the privileged chrome context with full access to everything.

---

## Prior art

Three existing implementations inform the design. Each has a detailed case study in `docs/browser-tab-implementation-studies/`:

**[Firefox native vertical tabs](browser-tab-implementation-studies/firefox.md)** — a layout orientation toggle on the existing horizontal tab strip. All tabs are real DOM nodes (non-virtual), no tree hierarchy beyond `openerTab`, no workspace scoping. Vertical mode is a retrofit, not a first-class design. Useful as a reference for the underlying `gBrowser` event model and SessionStore integration.

**[Zen Browser](browser-tab-implementation-studies/zen.md)** — extends Firefox with workspace-scoped tab containers, "essential" (always-visible pinned) tabs, and folder-based grouping. Gets the UX direction right but requires a full Firefox fork — workspace routing, D&D, and the `allTabs` getter are all patched at build time. No `parentId` tree; grouping is flat folder membership. Not adoptable without becoming a fork.

**[Sidebery](browser-tab-implementation-studies/sidebery.md)** — the most mature vertical tab extension: `parentId` tree model, panel scoping, rich keyboard nav. Blocked by the iframe boundary and performance issues described above. Its `parentId`-over-linear-order model is the right data model and is what we're building toward.

---

## Design goals

- **Virtual tab list** — only render visible rows; measure container height and recalculate on scroll
- **Granular updates** — per-tab state updates, not full-array mutations; batch tab events within a single microtask
- **`parentId` tree model** — hierarchy as a `parentId` overlay on Firefox's native tab order (see `NOTES/sidebery-simplification-plan.md` for full spec)
- **Firefox-order sync** — panel DOM always mirrors `gBrowser.tabs`; all reordering routed through `gBrowser.moveTab`
- **Chrome-native** — `.uc.js` script in `chrome/JS/`, integrated with existing palefox drawer and state model

---

## Implementation phases

| Phase | Scope |
|---|---|
| 1 | Core tab list: virtual scroll, `parentId` tree, Firefox-order sync |
| 2 | Command palette: workspace-scoped tab search, centered overlay, keybind toggle |
| 3 | Graph view: Cytoscape.js tab graph with typed edges |
| 4 | AI layer: local Ollama for edge labeling, semantic search |
