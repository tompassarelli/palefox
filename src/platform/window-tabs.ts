// Window-scoped tabs API — `Palefox.windows.current().tabs.*`.
//
// Capabilities-shaped interface over `src/firefox/tabs.ts`. The window
// object owns "the tabs in THIS chrome window"; multi-window aggregation
// lives at `Palefox.tabs.findAcrossWindows` (M12) and history search
// across instances at `Palefox.history.searchTabs` (M11).
//
// Tab references accept palefox-id (number, persistent across sessions)
// OR Firefox `Tab` element. resolveTab() handles the union.

import { createLogger, type Logger } from "../tabs/log.ts";
import { tabById } from "../tabs/helpers.ts";
import { state, treeOf } from "../tabs/state.ts";
import type { Tab, TreeData } from "../tabs/types.ts";
import * as adapter from "../firefox/tabs.ts";
import type { SchedulerAPI } from "./scheduler.ts";

// =============================================================================
// INTERFACE
// =============================================================================

/** Reference to a tab. Accept either a palefox id (number, stable across
 *  restarts via SessionStore) or the `Tab` element directly (when the
 *  caller already has it from an event or DOM walk). */
export type TabRef = number | Tab;

/** Public projection of a tab. Capability shape — not a Firefox internal. */
export type PalefoxTab = {
  readonly id: number;
  readonly url: string;
  readonly label: string;
  readonly customName: string | null;
  readonly pinned: boolean;
  readonly selected: boolean;
  readonly hidden: boolean;
  readonly parentId: number | string | null;
  readonly depth: number;
};

export type WindowTabsAPI = {
  /** All tabs in this chrome window, in tab-strip order. */
  list(): readonly PalefoxTab[];
  /** Currently selected tab, or null if no model row exists yet. */
  selected(): PalefoxTab | null;
  /** Resolve a TabRef → PalefoxTab. Null if the ref is unknown. */
  get(ref: TabRef): PalefoxTab | null;
  /** Pin (or no-op if already pinned). Sync mutation; reconciler runs
   *  next microtask. Use Palefox.flush() if you need settled state. */
  pin(ref: TabRef): void;
  unpin(ref: TabRef): void;
  togglePinned(ref: TabRef): void;
  close(ref: TabRef): void;
  duplicate(ref: TabRef): PalefoxTab | null;
  reload(ref: TabRef): void;
  select(ref: TabRef): void;
  /** Select the tab AND focus this chrome window. Used by the cross-window
   *  picker — when the user picks a tab from a different window, that
   *  window's `tabs.activate(id)` runs, which raises the window AND selects
   *  the tab in one call. Returns false if the ref is unknown. */
  activate(ref: TabRef): boolean;
  /** Open a new tab loading `url`. Returns the new PalefoxTab if available
   *  in the synchronous tick (otherwise null — caller can flush() then list()). */
  open(url: string): PalefoxTab | null;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makeWindowTabs(scheduler: SchedulerAPI): WindowTabsAPI {
  const log: Logger = createLogger("platform/tabs");

  function resolveTab(ref: TabRef): Tab | null {
    if (typeof ref === "number") return tabById(ref);
    return ref;
  }

  function project(tab: Tab): PalefoxTab | null {
    const td: TreeData | undefined = treeOf.get(tab);
    if (!td) return null;
    return {
      id: td.id,
      url: tab.linkedBrowser?.currentURI?.spec ?? "",
      label: tab.label ?? "",
      customName: td.name,
      pinned: !!tab.pinned,
      selected: !!tab.selected,
      hidden: !!tab.hidden,
      parentId: td.parentId,
      // Depth is derived elsewhere; for now compute via parent walk.
      depth: depthOf(td),
    };
  }

  function depthOf(td: TreeData): number {
    let d = 0;
    let cur: TreeData | undefined = td;
    while (cur && cur.parentId !== null) {
      d += 1;
      const parent = (typeof cur.parentId === "number") ? tabById(cur.parentId) : null;
      if (!parent) break;
      cur = treeOf.get(parent);
    }
    return d;
  }

  function list(): readonly PalefoxTab[] {
    const out: PalefoxTab[] = [];
    for (const tab of adapter.allTabs()) {
      const p = project(tab);
      if (p) out.push(p);
    }
    return out;
  }

  function selected(): PalefoxTab | null {
    return project(adapter.selectedTab());
  }

  function get(ref: TabRef): PalefoxTab | null {
    const t = resolveTab(ref);
    return t ? project(t) : null;
  }

  function withTab(ref: TabRef, op: (t: Tab) => void, reason: string): void {
    const t = resolveTab(ref);
    if (!t) {
      log("ref:not-found", { ref: typeof ref === "number" ? ref : "(Tab elem)" });
      return;
    }
    op(t);
    scheduler.markDirty("tabs", reason);
  }

  return {
    list,
    selected,
    get,
    pin: (r) => withTab(r, adapter.pinTab, "Palefox.tabs.pin"),
    unpin: (r) => withTab(r, adapter.unpinTab, "Palefox.tabs.unpin"),
    togglePinned: (r) => withTab(r, adapter.togglePinned, "Palefox.tabs.togglePinned"),
    close: (r) => withTab(r, adapter.removeTab, "Palefox.tabs.close"),
    duplicate(r) {
      const t = resolveTab(r);
      if (!t) return null;
      const dup = adapter.duplicateTab(t);
      scheduler.markDirty("tabs", "Palefox.tabs.duplicate");
      return project(dup);
    },
    reload: (r) => withTab(r, adapter.reloadTab, "Palefox.tabs.reload"),
    select: (r) => withTab(r, (t) => { (state as { panel?: HTMLElement }); adapter.selectTab(t); }, "Palefox.tabs.select"),
    activate(r) {
      const t = resolveTab(r);
      if (!t) {
        log("activate:not-found");
        return false;
      }
      adapter.selectTab(t);
      // Raise this chrome window. When called via Palefox.tabs.activate
      // from a DIFFERENT chrome window, this is what brings us forward.
      try { window.focus(); } catch {}
      scheduler.markDirty("tabs", "Palefox.tabs.activate");
      return true;
    },
    open(url) {
      const t = adapter.openTab(url);
      scheduler.markDirty("tabs", "Palefox.tabs.open");
      return project(t);
    },
  };
}
