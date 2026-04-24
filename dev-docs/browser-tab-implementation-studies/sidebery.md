# Sidebery: Case Study

## How it works

### Process model

Sidebery is split across two JS contexts that cannot share memory:

- **Background script** (`src/bg/background.ts`) — runs persistently, owns canonical tab state, listens to `browser.tabs.*` events.
- **Sidebar page** (`src/sidebar/sidebar.ts`) — a Vue 3 app rendered in the extension sidebar iframe, owns UI state and is the canonical authority on tree structure.
- **IPC** (`src/services/ipc.ts`) — one `browser.runtime.Port` per sidebar/background connection pair. `localPort` created via `browser.runtime.connect()` (ipc.ts:229); `remotePort` received via `onConnect` (ipc.ts:717). On sidebar disconnect (ipc.ts:740–767): port listeners removed, `remotePort` nulled, connection dropped. Reconnection retries with exponential backoff, up to 6 attempts before silently abandoning.

Every user action that mutates tabs is a round trip: sidebar → IPC → background → `browser.tabs.*` → browser event → background → IPC → sidebar → re-render.

### Critical browser APIs

**`browser.tabs.*`**
- `query()` — loads all tabs on startup
- `onCreated` / `onRemoved` / `onMoved` / `onUpdated` / `onActivated` / `onDetached` / `onAttached` — full event surface; every handler feeds the recalc pipeline
- `move()`, `create()`, `update()`, `remove()`, `discard()`, `duplicate()` — all async mutations, all fire events that loop back into handlers

**`browser.sessions.*`**
- `setTabValue(tabId, 'data', {parentId, panelId, folded, customTitle, customColor})` — written with a **250ms debounce** (`saveTabDataTimeouts` map, `tabs.fg.ts:758–770`); written immediately (no delay) during restore operations
- `getTabValue()` — read at restore to reconstruct parentId/panelId
- `setWindowValue()` / `getWindowValue()` — active panel, hidden panels, unique window id

**`browser.storage.local`**
- `tabsDataCache` — array of `{id, url, pinned, parentId, panelId, folded, …}`, written with 2s debounce; fallback if sessions data is missing
- Also stores: settings, sidebar config, context menus, containers, snapshots, keybindings, custom CSS

**`browser.windows.*`**
- `getAll()` on startup; `update()` to set `titlePreface` window badge

### Tab tree model

**The sidebar is the tree structure authority; the background tracks parentId per-tab but not tree shape.**

Background does store `tab.parentId` (tabs.bg.ts:606: `tab.parentId = tabInfo.tid ?? D.NOID`) but does not independently compute nesting levels, subtrees, or folded state. When background needs full tree data (e.g. for snapshot writes), it calls `IPC.sidebar(winId, 'getTabsTreeData')` — the sidebar serializes current tree to `{pid, tid, f, ct, cc}` compact format and sends it back.

Each tab in sidebar frontend state (`tabs.fg.ts`) carries:
- `parentId` — tree parent (`NOID = -1` for roots)
- `lvl` — nesting depth computed from parent chain
- `folded` — subtree collapsed; persisted separately from `parentId` (saved to session but computed independently)
- `panelId` — which Sidebery panel the tab belongs to

Linear order of `Tabs.list` mirrors `gBrowser` tab index. Tree is an overlay.

**Panels are Sidebery-internal groupings, not Firefox containers.** Each panel has `newTabCtx` and `dropTabCtx` strings (sidebar.ts:69–70) that configure which Firefox container (contextual identity) new tabs open in — but a panel can contain tabs from multiple containers, or none.

### Event flow (tab created)

1. `browser.tabs.onCreated` → background `onTabCreated()` creates `BgTab`, inserts into `Windows[winId].tabs` and `Tabs.byId`
2. If sidebar not ready: event pushed to `deferredEventHandling` array (tabs.bg.ts:188, 269, 305, 366, 426, 464, 500). On `Tabs.ready`, all deferred callbacks execute sequentially (tabs.bg.ts:78: `deferredEventHandling.forEach(cb => cb())`). 100+ tab session restores run this way — no batching.
3. Background notifies sidebar via IPC port
4. Sidebar creates full reactive `Tab`, inserts into `Tabs.list`, assigns `parentId` from opener heuristics
5. `recalcTabsPanels()` — two-pass O(n) rebuild: first pass (lines 370–402) collects pinned tabs by panel; second pass (lines 404–472) builds `panelTabs` arrays for unpinned tabs
6. Vue re-renders the affected panel

### Persistence and restore

**Write:** `setTabValue` debounced 250ms per tab; `tabsDataCache` bulk write debounced 2s.

**Restore (hybrid match, not positional):**
1. Check if parent tab exists and old index falls within parent's branch (`fg.handlers.ts:350–366`)
2. Validate panel ID matches (`fg.handlers.ts:358, 377`)
3. Fall back to configured new-tab position

**Critical threshold:** if fewer than a minimum number of tabs have session data on restore, the entire session restore is discarded and all tabs are treated as new (`fg.handlers.ts:121`). This is a silent failure mode — a partial session corruption silently resets everything.

---

## Problems vs ideal model

**No chrome access.** Runs in an extension iframe. Cannot call `gBrowser.moveTab`, read SessionStore internals, or touch any chrome DOM. Autohide, compact mode, command palette, chrome-integrated UI — all blocked by the iframe boundary.

**O(n) recalc on every tab event.** `recalcTabsPanels()` iterates all tabs twice per event with no batching. Compounds with Vue reactivity cascade.

**Sidebar must be open for tree operations.** Background cannot perform tree-aware operations without an IPC round-trip to the sidebar. If sidebar is closed, tree state degrades.

**Restore is fragile.** Depends on 250ms-debounced `setTabValue` surviving the session. Dirty shutdown (crash, forced quit) within the debounce window loses tree data. The session threshold means partial corruption silently resets everything.

---

## Critical issues

- **iframe boundary** blocks all palefox goals: chrome layout, keybindings, command palette, graph view
- **Non-virtual DOM + O(n) recalcs** compound on every event; degrades ~200–300 tabs
- **Deferred event queue is sequential**: session restore of 100+ tabs fires each handler one at a time, each triggering full recalc pipeline
- **Cascading Vue reactivity**: `visibleTabIds` direct array mutation + reactive `panel.tabs` reference = dual tracking on same data
- **Search retriggers globally** on any tab create when any panel is in filtered state (`sidebar.fg.ts:505`)
- **Session restore silent discard**: partial session corruption hits the "not enough" threshold and wipes all tree state with no user warning
- **Port reconnection is fire-and-forget**: after 6 exponential-backoff failures, sidebar connection is silently abandoned — tree operations fail silently until next reload
