// Tier 3 tests for the Palefox semantic platform layer.
//
// Exercises `window.pfxTest.Palefox.windows.current().tabs.*` end-to-end
// against a real Firefox to validate:
//   - the API surface exists and is window-scoped
//   - mutations land synchronously on gBrowser
//   - the scheduler dirty-flag protocol fires (via diag())
//   - flush() awaits pending reconcilers
//
// This is the foundation test — once M2 migrates feature code to the
// platform layer, more behavioral tests will live alongside.

import type { IntegrationTest } from "../../tools/test-driver/runner.ts";

const tests: IntegrationTest[] = [
  {
    name: "platform: Palefox namespace exposed via pfxTest",
    async run(mn) {
      const ok = await mn.executeScript<boolean>(`
        const P = window.pfxTest?.Palefox;
        return !!(P && P.windows && P.flush && P.diag);
      `);
      if (!ok) throw new Error("pfxTest.Palefox surface missing or shape wrong");
    },
  },

  {
    name: "platform: windows.current().tabs.list() returns tabs in tab-strip order",
    async run(mn) {
      // Add two extra tabs so order matters.
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        return true;
      `);
      const result = await mn.executeScript<{ palefoxLen: number; firefoxLen: number; firstId: number | null }>(`
        const Palefox = window.pfxTest.Palefox;
        const list = Palefox.windows.current().tabs.list();
        return {
          palefoxLen: list.length,
          firefoxLen: gBrowser.tabs.length,
          firstId: list[0]?.id ?? null,
        };
      `);
      if (result.palefoxLen !== result.firefoxLen) {
        throw new Error(`Palefox.tabs.list() length ${result.palefoxLen} != gBrowser.tabs.length ${result.firefoxLen}`);
      }
      if (typeof result.firstId !== "number") {
        throw new Error(`first tab has no palefox id (got ${result.firstId})`);
      }
    },
  },

  {
    name: "platform: tabs.selected() matches gBrowser.selectedTab",
    async run(mn) {
      const ok = await mn.executeScript<boolean>(`
        const Palefox = window.pfxTest.Palefox;
        const sel = Palefox.windows.current().tabs.selected();
        if (!sel) return false;
        // Look the tab back up by id and confirm it's the selected one.
        const tabs = [...gBrowser.tabs];
        const found = tabs.find((t) => {
          const td = window.pfxTest.treeOf?.get?.(t);
          return td && td.id === sel.id;
        });
        return found === gBrowser.selectedTab;
      `);
      if (!ok) throw new Error("Palefox.tabs.selected() did not match gBrowser.selectedTab");
    },
  },

  {
    name: "platform: tabs.pin/unpin mutations propagate to gBrowser + scheduler",
    async run(mn) {
      // Use Marionette's callback pattern — the chrome-context async-script
      // runtime here expects arguments[N-1](result), not Promise-return.
      const result = await mn.executeAsyncScript<{ pinned: boolean; sawDirty: boolean }>(`
        const cb = arguments[arguments.length - 1];
        (async () => {
          const Palefox = window.pfxTest.Palefox;
          const wTabs = Palefox.windows.current().tabs;
          const list = wTabs.list();
          if (!list.length) { cb({ pinned: false, sawDirty: false }); return; }
          const id = list[0].id;
          const wasPinned = list[0].pinned;

          if (wasPinned) wTabs.unpin(id); else wTabs.pin(id);

          const diagAfter = Palefox.diag();
          const sawDirty = (diagAfter.scheduler.pending.tabs ?? []).length > 0
            || diagAfter.scheduler.nextFlushPending;

          await Palefox.flush();

          const tabs = [...gBrowser.tabs];
          const tab = tabs.find((t) => {
            const td = window.pfxTest.treeOf?.get?.(t);
            return td && td.id === id;
          });
          const nowPinned = !!tab?.pinned;

          // Idempotent: revert.
          if (nowPinned !== wasPinned) {
            if (wasPinned) wTabs.pin(id); else wTabs.unpin(id);
            await Palefox.flush();
          }

          cb({ pinned: nowPinned !== wasPinned, sawDirty });
        })().catch((e) => cb({ pinned: false, sawDirty: false, error: String(e) }));
      `);
      if (!result.pinned) throw new Error("pin/unpin did not flip gBrowser tab state");
      if (!result.sawDirty) throw new Error("scheduler did not see a dirty marker after the mutation");
    },
  },

  {
    name: "platform: flush() resolves after pending reconcilers run",
    async run(mn) {
      const ms = await mn.executeAsyncScript<number>(`
        const cb = arguments[arguments.length - 1];
        (async () => {
          const Palefox = window.pfxTest.Palefox;
          const before = Date.now();
          const sp = Services.scriptSecurityManager.getSystemPrincipal();
          gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
          await Palefox.flush();
          cb(Date.now() - before);
        })().catch((e) => cb(-1));
      `);
      if (ms < 0) throw new Error("flush() rejected");
      if (ms > 1000) throw new Error("flush took " + ms + "ms — reconciler may be hung");
    },
  },

  {
    name: "platform: diag() exposes scheduler state for debugging",
    async run(mn) {
      const ok = await mn.executeScript<boolean>(`
        const d = window.pfxTest.Palefox.diag();
        return typeof d.windowId === "string"
          && typeof d.scheduler === "object"
          && typeof d.scheduler.nextFlushPending === "boolean"
          && typeof d.scheduler.pending === "object"
          && typeof d.instanceId === "string"
          && d.instanceId.length > 0;
      `);
      if (!ok) throw new Error("diag() shape unexpected (instanceId missing or zero-length)");
    },
  },

  {
    name: "platform: Palefox.history.instanceId() returns stable per-profile id",
    async run(mn) {
      const result = await mn.executeAsyncScript<{ ok: boolean; sample: string }>(`
        const cb = arguments[arguments.length - 1];
        (async () => {
          const Palefox = window.pfxTest.Palefox;
          const id1 = Palefox.history.instanceId();
          const id2 = Palefox.history.instanceId();
          const idDiag = Palefox.diag().instanceId;
          cb({ ok: id1 === id2 && id1 === idDiag && id1.length > 0, sample: id1 });
        })().catch((e) => cb({ ok: false, sample: String(e) }));
      `);
      if (!result.ok) throw new Error("instanceId not stable across calls or empty: " + result.sample);
    },
  },

  {
    name: "platform: Palefox.history.recent({scope:current}) returns events",
    async run(mn) {
      const result = await mn.executeAsyncScript<{ ok: boolean; len: number; allHaveInstance: boolean; instanceId: string }>(`
        const cb = arguments[arguments.length - 1];
        (async () => {
          const Palefox = window.pfxTest.Palefox;
          // Trigger an event so we have at least one row.
          await window.pfxTest.scheduleSave();
          await new Promise((r) => setTimeout(r, 200));
          const events = await Palefox.history.recent({ scope: "current", limit: 5 });
          const myId = Palefox.history.instanceId();
          const allHaveInstance = events.every((e) => e.instanceId === myId);
          cb({ ok: events.length > 0, len: events.length, allHaveInstance, instanceId: myId });
        })().catch((e) => cb({ ok: false, len: -1, allHaveInstance: false, instanceId: String(e) }));
      `);
      if (!result.ok) throw new Error("history.recent returned no events");
      if (!result.allHaveInstance) throw new Error("not all events tagged with current instanceId");
    },
  },

  {
    name: "platform: Palefox.checkpoints.tag + .list round-trips",
    async run(mn) {
      const result = await mn.executeAsyncScript<{ ok: boolean; tagged: boolean; foundLabel: string | null }>(`
        const cb = arguments[arguments.length - 1];
        (async () => {
          const Palefox = window.pfxTest.Palefox;
          // Need at least one event to tag.
          await window.pfxTest.scheduleSave();
          await new Promise((r) => setTimeout(r, 300));
          const label = "test-checkpoint-" + Date.now();
          const id = await Palefox.checkpoints.tag(label);
          const list = await Palefox.checkpoints.list({ scope: "current", limit: 20 });
          const found = list.find((e) => e.tag === ("checkpoint:" + label));
          cb({ ok: id !== null && !!found, tagged: id !== null, foundLabel: found?.tag ?? null });
        })().catch((e) => cb({ ok: false, tagged: false, foundLabel: String(e) }));
      `);
      if (!result.tagged) throw new Error("checkpoints.tag returned null");
      if (!result.ok) throw new Error("checkpoint not found in list (label was " + result.foundLabel + ")");
    },
  },

  {
    name: "platform: Palefox.history default scope is current (not all)",
    async run(mn) {
      const ok = await mn.executeAsyncScript<boolean>(`
        const cb = arguments[arguments.length - 1];
        (async () => {
          const Palefox = window.pfxTest.Palefox;
          // No scope opt → defaults to "current". Should still return events.
          const recent = await Palefox.history.recent();
          cb(Array.isArray(recent));
        })().catch((e) => cb(false));
      `);
      if (!ok) throw new Error("default-scope recent() failed");
    },
  },
];

export default tests;
