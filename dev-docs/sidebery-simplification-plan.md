# Path A rewrite: sync palefox order with Firefox, hierarchy via parentId

> **Status:** plan, not executed. Supersedes the smaller simplification idea.
> The scope expanded once we realized palefox's panel order drifts from
> Firefox's native tab order, which is the root cause of the fragile restore.

## Why this rewrite

Palefox today maintains its own tab order independent of `gBrowser.tabs`:

- **Drag-drop** (`executeDrop`, `palefox-tabs.uc.js:1558`) only reorders the
  palefox DOM. Never calls `gBrowser.moveTab`. Firefox's tab index stays put.
- **New tab placement** follows our `newTabPosition` pref, putting rows wherever
  we want in the panel. Firefox puts the real `<tab>` wherever its own rules
  say. Disagreement starts at creation.
- **`writeToDisk`** iterates `allRows()` (panel order), not `gBrowser.tabs`.

Result: on session restart, Firefox restores tabs in its order, we try to
match against saved nodes in our (different) order → positional match fails,
URLs are unreliable for pending tabs, and we end up with the 4-source URL
probe + retry chain to paper over the mismatch.

Sidebery never has this problem because their panel *is* Firefox's tab order.
Tree structure lives on top as an explicit `parentId` per tab; indentation is
computed from the parent chain.

## Target model

**State:**
```js
treeData(tab) = { id, parentId, name, state, collapsed }
```

- `parentId` replaces `level`. Tab's visual depth is computed on demand:
  `levelOf(tab) = 1 + levelOf(tabById(tab.parentId))` (or 0 if root).
- Panel order **mirrors** `gBrowser.tabs` order at all times.
- Palefox never invents a linear position — only `parentId` assignment and
  indentation.

**Invariant:** after any operation, the panel DOM order for tab rows equals
`gBrowser.tabs` order. Enforced by routing reordering through
`gBrowser.moveTab` and reacting to `TabMove` events.

## Function-by-function impact

### Rewritten

| Function | Old | New |
|---|---|---|
| `treeData` | `{level, …}` | `{parentId, …}` |
| `parentOfTab(tab)` | walk previous rows by level | return `tabById(treeData(tab).parentId)` |
| `subtreeRows(row)` | contiguous rows with greater level | tree walk by `parentId` |
| `levelOf(tab)` | read `td.level` | count parent chain hops |
| `syncTabRow` | `padding = td.level * INDENT` | `padding = levelOf(tab) * INDENT` |
| `onTabOpen` | insert row at pref-driven position + set level | set `parentId` based on pref (opener, selected, or none); row goes wherever Firefox puts the tab — we just reflect via `TabMove` |
| `onTabClose` | promote children one level | reparent children to `tab.parentId` (the grandparent) |
| `onTabMove` | no-op | reorder panel row to match Firefox's new index |
| `executeDrop` | DOM-only reorder + level delta | call `gBrowser.moveTab`; update `parentId` for nesting |
| `buildPanel` / `buildFromSaved` | panel order from saved JSON | walk `gBrowser.tabs` in order, insert one row per tab |
| Vim `h`/`l` outdent/indent | level ±1 | reparent to grandparent / prev sibling |
| Vim `Alt+j`/`Alt+k` swap | DOM swap | `gBrowser.moveTab` to sibling's index |
| Vim `Alt+h`/`Alt+l` subtree shift | level delta across subtree | reparent subtree root; linear position unchanged |

### Removed (dead after rewrite)

- `resolveOpeningUrl` (4-source URL probing)
- Retry chain in `onTabOpen` (microtask + 50/250/1000ms)
- `pinTabId` / `readPinnedId` / `tryRegisterPinAttr`, `pfx-id` DOM attribute
- `SS` handle block if `getTabState` isn't used elsewhere
- `placeRestoredRow` (mid-session closed-tab re-insertion becomes trivial: restore `parentId` and let Firefox handle insertion position via `undoCloseTab`; our `TabMove` handler reflects it)
- `savedTabState` leftover URL map (not needed — restore matches positionally)
- Descendant re-demote logic on `Ctrl+Shift+T` (children's `parentId` doesn't change when parent closes if we don't forcibly reparent; we can choose to leave children as roots on close, and `parentId` restore just points them back)

### Simplified

- `writeToDisk`: iterate `gBrowser.tabs`, dump `{id, url, parentId, name, state, collapsed}` per tab
- `loadFromDisk`: positional blindspot match (Sidebery pattern); apply `parentId` directly
- `closedTabs` LIFO: drop `prevSiblingId` and `descendantIds`; just save `{id, parentId, name, state, collapsed}`. On restore, restore `parentId` on the reopened tab. Firefox handles linear position via its own undo logic

### Kept untouched

- Immediate write-on-change persistence
- Vim cursor, selection, horizontal mode rendering (level-based via `levelOf`)
- Group feature conceptually (but see next section for their new placement model)

## Groups

Groups are palefox-only panel rows with no corresponding Firefox tab. Under
the new model they need a **position anchor** since Firefox's tab order
doesn't know about them:

**Proposal:** each group stores `{ afterTabId, parentId }`.
- `afterTabId` — the id of the tab it sits immediately after in the panel
  (or `null` for "top of panel").
- `parentId` — same semantics as for tabs (what subtree the group belongs to)
- On build: walk `gBrowser.tabs` in order. After placing each tab's row,
  check if any group has `afterTabId === tab.id` and insert it.
- If `afterTabId` references a closed tab: group's anchor promotes to the
  closed tab's `parentId`-subtree ancestor, similar to orphan handling.

This keeps groups purely as a palefox decoration without requiring any
entry in `gBrowser.tabs`.

## Save file format change

Before:
```json
{ "nodes": [{"type":"tab","level":0,"url":"…"}, …],
  "closedTabs": […], "nextTabId": N }
```

After:
```json
{ "tabs":   [{"id":1,"parentId":null,"url":"…","name":null,"state":null,"collapsed":false}, …],
  "groups": [{"id":"g1","name":"Work","afterTabId":1,"parentId":null,…}],
  "closedTabs": [{"id":5,"parentId":1,"url":"…","name":…}, …],
  "nextTabId": N }
```

Tabs array is in Firefox order at save time. Positional blindspot match on
load is trivial.

**Migration:** the old file format is incompatible and will be ignored on
first run. Users' existing in-file hierarchy is lost once. Document this —
they rebuild manually over a session or two and then it's rock solid.

## Match-on-load logic (replaces current matching)

```js
function matchSavedToLive(savedTabs, liveTabs, apply) {
  let li = 0;
  for (const saved of savedTabs) {
    if (li >= liveTabs.length) break;
    const live = liveTabs[li];
    const liveUrl = live.linkedBrowser?.currentURI?.spec || "";
    const pending = liveUrl === "about:blank"
                 && (live.hasAttribute("pending") || live.hasAttribute("busy"));
    if (liveUrl === saved.url || pending) { apply(live, saved); li++; continue; }
    // ±5 lookahead for a URL match (user opened extra tabs)
    let off = 0;
    for (let j = 1; j <= 5 && li + j < liveTabs.length; j++) {
      if ((liveTabs[li + j].linkedBrowser?.currentURI?.spec || "") === saved.url) {
        off = j; break;
      }
    }
    if (off) { apply(liveTabs[li + off], saved); li += off + 1; }
  }
}
```

No retries, no microtasks, no SessionStore internals. `apply` sets `parentId`
+ metadata on the tab.

## `newTabPosition` pref under the new model

We still control linear position, but we route through `gBrowser.moveTab`
so Firefox agrees with us. The pref now drives both `parentId` assignment
and (via `moveTab`) the linear position:

| Pref | Linear position | parentId |
|---|---|---|
| `"root"` (default) | End of tab strip (`moveTab` to last index) | `null` |
| `"child"` | After parent's subtree end | `tab.owner ?? selectedTab` |
| `"sibling"` | After selected tab's subtree end | `parentOfTab(tab.owner ?? selectedTab)` |

Flow for a new tab:
1. Firefox creates tab at its own default position
2. Our `onTabOpen` computes `targetIndex` from the pref
3. If Firefox's position ≠ target: `gBrowser.moveTab(tab, targetIndex)`
4. Firefox emits `TabMove`; our generic `onTabMove` handler reorders the
   palefox row to match

Result: linear position is ours to define, AND Firefox's tab strip always
agrees with the sidebar. No drift possible.

Sidebery exposes this as many preferences (separate knobs for "new tab
from link" vs "new tab from Ctrl+T" vs "new tab from pinned tab"). Start
with the current 3-value pref and add sidebery-style granularity later
if someone wants it. The infrastructure (`moveTab` + `onTabMove` sync)
supports arbitrary linear positioning.

## Implementation order

1. **Core model**: add `parentId` to `treeData`. Implement `levelOf`,
   `parentOfTab` via parentId lookup, `subtreeRows` via tree walk. Drop the
   old `level` field from the tree data shape. Update `syncTabRow` to use
   `levelOf` for indentation. Don't change user-visible behavior yet — this
   just re-expresses the same tree structure.

2. **Firefox-order sync**: wire up `onTabMove` to move the matching palefox
   row to the new Firefox index. Update `buildPanel` to walk `gBrowser.tabs`
   in order. Remove any lingering assumption that rows can be anywhere.

3. **Drag-drop**: rewrite `executeDrop` to call `gBrowser.moveTab`. `parentId`
   update happens in `onTabOpen`/`onTabMove`/drop handler depending on direction.

4. **Vim ops**: outdent/indent/swap routed through `parentId` mutations and
   `gBrowser.moveTab` for sibling swaps.

5. **Persistence**: new save format; positional blindspot match on load.

6. **Groups**: `{afterTabId, parentId}` anchor model.

7. **Cleanup**: delete `resolveOpeningUrl`, retry chain, `pinTabId` block,
   `SS` import if unused, savedTabState leftover logic, `placeRestoredRow`,
   descendant re-demote. Simplify `closedTabs` entries.

Each step should leave the tree in a working state (tree renders, edits work).

## Files to touch

- `chrome/JS/palefox-tabs.uc.js` — all of the above
- `docs/features.md` — pref semantics note for `newTabPosition` changes
- README/features: nothing else

## Risks / open questions

- **Firefox's own tab-placement behavior** for newly opened tabs may not
  always match our `parentId` intent for `"child"`/`"sibling"`. We might
  need to call `gBrowser.moveTab` immediately after creation in some cases
  to align linear position with tree intent. Prefer leaving Firefox's
  behavior alone where it's close enough.
- **Cursor preservation** when `onTabMove` reorders panel rows under the
  cursor. Need to keep cursor tracking the tab, not the DOM position.
- **Horizontal layout** (`pfx-horizontal`) handles level via CSS padding
  currently; needs to work with `levelOf`. Should be straightforward.
- **Groups with anchored `afterTabId`** — edge cases: user drags group to
  new location, anchor tab closes, etc. Need explicit rules.

## Verification

After full rewrite:

1. Fresh slate: delete `~/.mozilla/firefox/tom/palefox-tab-tree.json`
2. Open tabs, build a tree (nested, with groups)
3. Drag a tab between tree positions → verify Firefox's tab strip reorders too
4. Quit Firefox cleanly
5. Reopen → tree renders with correct hierarchy **without clicking anything**
6. Mid-session: close a nested tab, `Ctrl+Shift+T` → tab snaps back to its
   parent automatically (Firefox handles linear position; we restore `parentId`)
7. Open an extra tab before all restored tabs finish loading → ±5 lookahead
   still matches the rest
8. Alt+j/k vim swap → Firefox's tab order also changes
9. `:group Work` then quit/reopen → group still sits between the right tabs
