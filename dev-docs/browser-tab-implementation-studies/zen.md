# Zen Browser Vertical Tabs: Case Study

## How it works

Zen replaces Firefox's single flat tab strip with a **multi-workspace vertical sidebar system**. Each workspace is an independent DOM container. Tabs are physically moved between containers on workspace switch — not hidden, not CSS-toggled, but DOM-reparented.

### Workspace container model

**`ZenSpace.mjs`** — defines `<zen-workspace>`, a `MozXULElement`. Each instance contains:
- `.zen-current-workspace-indicator` — header with icon, name, collapse button
- `.zen-workspace-pinned-tabs-section` — essentials/pins area
- `.zen-workspace-normal-tabs-section` — wraps `<arrowscrollbox orient="vertical">` for scrollable tabs

**Tab routing is DOM reparenting, not attribute routing.** When a tab is assigned to a workspace, `ZenSpaceManager.mjs:1590–1591` does:
```
tab.setAttribute("zen-workspace-id", workspaceID)   // metadata
container.insertBefore(tab, container.lastChild)      // truth
```
The `zen-workspace-id` attribute is bookkeeping; the DOM parent is what determines which workspace a tab belongs to. XUL attribute inheritance fails across DOM layers, so `zen-workspace-id` is set manually on children (`ZenSpace.mjs:259–262`).

**Workspace switching is a CSS `translateX` animation, not hide/show.** All workspace containers exist in the DOM simultaneously. `ZenSpaceManager.mjs:2050, 2072`: non-active workspaces are offset via `transform: translateX(N%)`, sliding them off-screen. Switching animates containers in/out. `container.active` attribute (line 1699) marks the visible one.

**`allTabs` getter is patched** (`tabs-js.patch:71`): replaced from arrowscrollbox children to `gZenWorkspaces.tabboxChildren`, which returns `Array.from(this.activeWorkspaceStrip?.children || [])` (`ZenSpaceManager.mjs:365–366`) — only the active workspace's tabs. This means Firefox's own `gBrowser.tabs`-adjacent APIs see only the active workspace.

**Workspace switching has a mutex and 100ms debounce** (`ZenSpaceManager.mjs:87–89`: `_workspaceChangeInProgress` flag, `_tabSelectionState.debounceTime`). Rapid workspace switches are coalesced.

### Essentials (always-visible pinned tabs)

**`ZenPinnedTabManager.mjs`** — "essential" tabs are Firefox's `pinned` tabs with an additional `zen-essential` marker. Essential tabs live in a **single canonical DOM location** (`#zen-essentials` container, `ZenSpaceManager.mjs:443, 452`). They are CSS-hidden per container when `containerSpecificEssentials` is true — not duplicated in DOM. Visibility toggled by `essentialsContainer.setAttribute("hidden", "true")` (line 461).

Essential tabs are explicitly excluded from workspace reparenting (`ZenSpaceManager.mjs:413–414`): a tab marked essential will not be moved into a workspace container.

Custom drag zones handle transitions between essentials, pinned section, and normal tabs (`ZenPinnedTabManager.mjs:649–817`). Custom events: `ZenTabIconChanged`, `TabAddedToEssentials`, `TabRemovedFromEssentials`.

### Folder/group system

**`ZenFolder.mjs`** — `<zen-folder>` extends `MozTabbrowserTabGroup` (`ZenFolder.mjs:11`). Additions over base: `_activeTabs` tracking (line 76–77), SVG icon, rename handler (lines 81–87), custom `collapsed` setter that emits attributes (lines 34–40), pinned setter is a no-op (line 218) to prevent external pinning. Groups are collapsible containers within a workspace's normal-tabs section. **No recursive nesting — folders are flat within a workspace.**

No `parentId` or opener chain. Tab hierarchy = folder membership + workspace membership.

### Firefox patches

**`tabbrowser/content/tabs-js.patch`** — direct patches to Firefox's `tabs.js`:
- Line 10: `TabDragAndDrop` → `ZenDragAndDrop` (workspace-aware D&D)
- Line 71: `allTabs` → `gZenWorkspaces.tabboxChildren` (active workspace only)
- Line 140: `ariaFocusableItems` rebuilt to iterate essentials + workspace pinned + workspace normal
- Line 203: `newTabButton` fetches from active workspace strip
- Line 233: `#ensureTabIsVisible` always uses active workspace's scrollbox

### Compact mode / autohide

**`ZenCompactMode.mjs`** — not CSS-only. Multi-phase JS state machine:
- `mouseenter` → delay (HOVER_HACK_DELAY, line 47) → check hover status → `requestAnimationFrame` → conditional attribute set
- State variables: `_wasInCompactMode`, `_ignoreNextHover`, cached animation frame IDs (line 842), timeout cancellation (line 885)
- Expand/collapse: `_setElementExpandAttribute()` (lines 693–737) manipulates attributes directly; CSS animations drive the transform

### Gotchas and non-obvious behaviors

**Empty tab persists across workspaces.** `ZenSpaceManager.mjs:311–325` creates a persistent empty tab at startup that is moved between workspaces (line 1738) rather than destroyed and recreated. Treat this tab as infrastructure.

**`#fixTabPositions()` is called explicitly.** Lines 1750–1776: manually recalculates `_tPos` and `_pPos` internal position values because SessionStore's position tracking drifts from DOM state after workspace reparenting. This is an acknowledged desync workaround.

**Workspace switch is async under a mutex.** If you call workspace switch twice fast, the second is debounced. The `_workspaceChangeInProgress` flag must be respected or you can end up with tabs in limbo between containers.

**essentials behavior changes with `containerSpecificEssentials`.** When this pref is true, each Firefox container (contextual identity) gets its own essentials section. Essential tabs are CSS-hidden per container, not per workspace — different axis of visibility than workspace scoping.

### Key files

| Component | File |
|---|---|
| Workspace container | `src/zen/spaces/ZenSpace.mjs` |
| Workspace lifecycle + tab routing | `src/zen/spaces/ZenSpaceManager.mjs` |
| Essentials/pinned | `src/zen/tabs/ZenPinnedTabManager.mjs` |
| Folder groups | `src/zen/folders/ZenFolder.mjs` |
| Firefox tab strip patches | `src/browser/components/tabbrowser/content/tabs-js.patch` |
| Compact/autohide | `src/zen/compact-mode/ZenCompactMode.mjs` |

---

## Problems vs ideal model

**Requires a fork.** DOM reparenting of tab nodes, patching `allTabs`, replacing `TabDragAndDrop` — all require build-time changes to Firefox source. There is no way to replicate Zen's workspace model as a userChrome overlay.

**`allTabs` patch breaks Firefox internals.** By returning only active-workspace tabs from `gBrowser.tabs`-adjacent APIs, any Firefox internal that iterates all tabs gets a filtered view. This causes subtle bugs when Firefox's own code assumes it can see every tab.

**No `parentId` tree.** Grouping is flat folder + workspace membership. Cannot express opener chains, subtree operations (collapse subtree, close subtree, move subtree), or computed nesting depth.

**Essentials global scope by default.** Essential tabs span all workspaces in standard mode — no per-workspace pinned tab concept unless `containerSpecificEssentials` is enabled, which scopes by Firefox container, not by workspace.

**D&D is a full patch.** `ZenDragAndDrop` replaces Firefox's handler entirely. Any upstream D&D fix is a manual merge conflict.

**Workspace switching hides all non-active tabs from Firefox internals.** Since `allTabs` only returns active workspace tabs, Firefox features that iterate tabs (find-in-page, keyboard shortcuts, session restore) operate on a partial view.

---

## Critical issues

- **Fork requirement**: hard blocker — cannot adopt without becoming a fork of Firefox
- **`allTabs` patch**: most dangerous change — corrupts Firefox's internal tab iteration; produces hard-to-diagnose bugs
- **No `parentId` tree**: folder model cannot represent opener chains or subtree operations
- **DOM reparenting on workspace switch**: tabs physically move in the DOM on every switch — any code that holds a reference to a tab's parent container must re-query after switch
- **What Zen gets right** (worth referencing for UX design): workspace scoping via container routing, essentials-as-always-visible-pins, per-workspace scroll state, `translateX` animation for workspace transitions — these are valid UX patterns; the implementation strategy is the problem
