// Palefox semantic platform layer — top-level namespace.
//
// One Palefox per chrome window. Established at chrome-window init,
// stored on `window.Palefox` (and `window.pfxTest.Palefox` for tests).
//
// Architectural sentence (from docs/dev/firefox-upstream-stability.md):
//
// > Palefox live state is window-scoped because Firefox live state is
// > window-scoped. Palefox persisted state is global because Palefox
// > sessions, checkpoints, and history are user-level concepts. Firefox
// > events invalidate Palefox state; Palefox reconcilers rebuild
// > semantic state from stable primitives under a central scheduler.
//
// What's wired today (Phase 1):
//   - Scheduler with the dirty-flag protocol.
//   - Tabs reconciler — bridges Firefox tab events into the scheduler.
//     Reconciler logs dirty reasons; rebuild logic still in src/tabs/events.ts
//     for now (M2 migrates it in).
//   - WindowTabs API — `Palefox.windows.current().tabs.{list,selected,pin,unpin,close,…}`.
//
// Not yet wired (deferred to the roadmap):
//   - Persisted APIs (Palefox.sessions / .history / .checkpoints) — M5/M6.
//   - Multi-instance scope params + instance discovery — M11.
//   - Cross-window aggregation (Palefox.tabs.findAcrossWindows) — M12.
//   - Events bus, urlbar facade, sidebar facade.

import type { HistoryAPI } from "../tabs/history.ts";
import { makeCrossWindowTabs, type CrossWindowTabsAPI } from "./cross-window-tabs.ts";
import { makePersisted, type PersistedAPI } from "./history.ts";
import { makeScheduler, type SchedulerAPI } from "./scheduler.ts";
import { makeTabsReconciler, type TabsReconcilerAPI } from "./tabs-reconciler.ts";
import { makePalefoxWindow, type PalefoxWindow } from "./window.ts";

// =============================================================================
// INTERFACE
// =============================================================================

export type PalefoxAPI = {
  /** The window-scoped facade for THIS chrome window. */
  windows: { current(): PalefoxWindow };
  /** Cross-window tab aggregator. `Palefox.tabs.all()` returns every tab
   *  in every chrome window of this Firefox process, each tagged with
   *  the window it came from. (Not a global "tabs.list()" — we forbid
   *  ambiguous globals; the explicit `.all()` name signals the scope.) */
  tabs: CrossWindowTabsAPI;
  /** Persisted-state APIs. */
  history: PersistedAPI["history"];
  sessions: PersistedAPI["sessions"];
  checkpoints: PersistedAPI["checkpoints"];
  /** Force-reconcile right now. Used by consistency-sensitive callers
   *  that genuinely need the model settled before proceeding. */
  flush(): Promise<void>;
  /** Diagnostic — scheduler state. Exposed via `pfxTest.Palefox.diag()`. */
  diag(): {
    scheduler: ReturnType<SchedulerAPI["diag"]>;
    windowId: string;
    instanceId: string;
  };
  /** Tear down. Called from window.unload. */
  destroy(): void;
};

export type PalefoxDeps = {
  readonly history: HistoryAPI;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makePalefox(deps: PalefoxDeps): PalefoxAPI {
  const scheduler = makeScheduler();
  const tabsReconciler: TabsReconcilerAPI = makeTabsReconciler({ scheduler });
  const win: PalefoxWindow = makePalefoxWindow(scheduler);
  const persisted: PersistedAPI = makePersisted(deps.history);
  const crossWindowTabs: CrossWindowTabsAPI = makeCrossWindowTabs();

  return {
    windows: { current: () => win },
    tabs: crossWindowTabs,
    history: persisted.history,
    sessions: persisted.sessions,
    checkpoints: persisted.checkpoints,
    flush: () => scheduler.flush(),
    diag: () => ({
      scheduler: scheduler.diag(),
      windowId: win.windowId,
      instanceId: deps.history.instanceId(),
    }),
    destroy(): void {
      tabsReconciler.destroy();
      scheduler.destroy();
    },
  };
}
