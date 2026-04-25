// Tier 3 integration tests for the SQLite-backed history substrate.
//
// Replaces the old palefox-tab-tree.json persist tests. Drives the new
// history layer (src/tabs/history.ts) end-to-end via Marionette's
// executeAsyncScript so we can await SQLite queries from chrome scope.
//
// What's covered:
//   - opening tabs records events in palefox-history.sqlite
//   - identical state on consecutive saves doesn't add new events (hash dedupe)
//   - tagLatest("session") produces a session-tagged event
//   - getTagged returns most-recent-first ordering
//   - events survive Firefox restart (WAL durability)

import type { IntegrationTest } from "../../tools/test-driver/runner.ts";
import type { MarionetteClient } from "../../tools/test-driver/marionette.ts";

async function waitFor(
  mn: MarionetteClient,
  scriptReturningBool: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await mn.executeScript<boolean>(scriptReturningBool);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${scriptReturningBool.slice(0, 120)}`);
}

const tests: IntegrationTest[] = [
  {
    name: "history: opening tabs records events in palefox-history.sqlite",
    async run(mn) {
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        for (let i = 0; i < 3; i++) gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        return true;
      `);
      await waitFor(mn, `return gBrowser.tabs.length >= 4;`);
      // Saves are debounced; let one fire.
      await new Promise((r) => setTimeout(r, 500));

      const result = await mn.executeAsyncScript<{
        eventCount: number;
        latestNodeCount: number;
        latestNextTabId: number | null;
      }>(`
        const cb = arguments[arguments.length - 1];
        window.pfxTest.history.getRecent(50)
          .then((events) => {
            const latest = events[0];
            cb({
              eventCount: events.length,
              latestNodeCount: latest?.snapshot?.nodes?.length ?? 0,
              latestNextTabId: latest?.snapshot?.nextTabId ?? null,
            });
          })
          .catch((e) => cb({ eventCount: -1, latestNodeCount: -1, latestNextTabId: null }));
      `);

      if (result.eventCount < 1) {
        throw new Error(`expected at least 1 event, got ${result.eventCount}`);
      }
      if (result.latestNodeCount < 4) {
        throw new Error(`latest event has ${result.latestNodeCount} nodes, expected 4+`);
      }
    },
  },

  {
    name: "history: hash dedupe — identical state doesn't write new events",
    async run(mn) {
      const before = await mn.executeAsyncScript<number>(`
        const cb = arguments[arguments.length - 1];
        window.pfxTest.history.getRecent(1).then((evs) => cb(evs[0]?.id ?? 0));
      `);
      // Trigger two saves with no state change between them.
      await mn.executeScript(`window.pfxTest.scheduleSave(); return true;`);
      await new Promise((r) => setTimeout(r, 300));
      await mn.executeScript(`window.pfxTest.scheduleSave(); return true;`);
      await new Promise((r) => setTimeout(r, 300));
      const after = await mn.executeAsyncScript<number>(`
        const cb = arguments[arguments.length - 1];
        window.pfxTest.history.getRecent(1).then((evs) => cb(evs[0]?.id ?? 0));
      `);
      if (after !== before) {
        throw new Error(`expected no new events on no-op saves; before=${before} after=${after}`);
      }
    },
  },

  {
    name: "history: tagLatest('session') produces a session-tagged event",
    async run(mn) {
      // Ensure we have a fresh untagged event to tag.
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        return true;
      `);
      await new Promise((r) => setTimeout(r, 500));

      const result = await mn.executeAsyncScript<{ taggedId: number | null; foundTag: string | null }>(`
        const cb = arguments[arguments.length - 1];
        (async () => {
          const taggedId = await window.pfxTest.history.tagLatest("session");
          const tagged = await window.pfxTest.history.getTagged(5);
          const t = tagged.find((e) => e.id === taggedId);
          cb({ taggedId, foundTag: t?.tag ?? null });
        })().catch(() => cb({ taggedId: null, foundTag: null }));
      `);

      if (!result.taggedId) throw new Error("tagLatest returned null");
      if (!result.foundTag?.startsWith("session:")) {
        throw new Error(`expected tag to start with 'session:', got ${result.foundTag}`);
      }
    },
  },

  {
    name: "history: getTagged returns most-recent-first; checkpoint label round-trips",
    async run(mn) {
      // Add events, tag with distinct labels.
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        return true;
      `);
      await new Promise((r) => setTimeout(r, 400));
      await mn.executeAsyncScript(`
        const cb = arguments[arguments.length - 1];
        window.pfxTest.history.tagLatest("checkpoint", "first").then(() => cb(true));
      `);
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        return true;
      `);
      await new Promise((r) => setTimeout(r, 400));
      await mn.executeAsyncScript(`
        const cb = arguments[arguments.length - 1];
        window.pfxTest.history.tagLatest("checkpoint", "second").then(() => cb(true));
      `);

      const tagged = await mn.executeAsyncScript<Array<{ tag: string; timestamp: number }>>(`
        const cb = arguments[arguments.length - 1];
        window.pfxTest.history.getTagged(20)
          .then((evs) => cb(evs.map((e) => ({ tag: e.tag, timestamp: e.timestamp }))));
      `);
      // Newest first.
      for (let i = 1; i < tagged.length; i++) {
        if (tagged[i - 1]!.timestamp < tagged[i]!.timestamp) {
          throw new Error(`getTagged not in newest-first order: ${JSON.stringify(tagged)}`);
        }
      }
      // We tagged at least the two checkpoints we just added.
      const labels = tagged.map((t) => t.tag);
      if (!labels.some((l) => l.includes("first"))) {
        throw new Error(`expected 'first' checkpoint, got: ${labels.join(", ")}`);
      }
      if (!labels.some((l) => l.includes("second"))) {
        throw new Error(`expected 'second' checkpoint, got: ${labels.join(", ")}`);
      }
    },
  },

  {
    name: "history: events survive Firefox restart (WAL durability)",
    async run(mn, ctx) {
      const before = await mn.executeAsyncScript<number>(`
        const cb = arguments[arguments.length - 1];
        window.pfxTest.history.getRecent(1000).then((evs) => cb(evs.length));
      `);
      if (before < 1) throw new Error("expected at least 1 event from prior tests");

      const mn2 = await ctx.restartFirefox();
      await waitFor(mn2, `return typeof window.pfxTest !== "undefined";`, 15_000);

      const after = await mn2.executeAsyncScript<number>(`
        const cb = arguments[arguments.length - 1];
        window.pfxTest.history.getRecent(1000).then((evs) => cb(evs.length));
      `);
      if (after < before) {
        throw new Error(`events lost across restart. before=${before} after=${after}`);
      }
    },
  },

  {
    name: "history: search() finds tabs by name (label) substring",
    async run(mn) {
      // Open a tab and set its TreeData.name to a unique string we can
      // search for. We use `name` instead of URL because headless tabs
      // don't always navigate URLs reliably; `name` is palefox-managed
      // and goes straight into the search-content table at save time.
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        const t = gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        // Wait one tick so palefox treeOf registers the tab.
        return true;
      `);
      // Let palefox process TabOpen.
      await new Promise((r) => setTimeout(r, 200));
      await mn.executeScript(`
        const t = gBrowser.tabs[gBrowser.tabs.length - 1];
        const td = window.pfxTest.treeOf.get(t);
        td.name = "PFX_SEARCH_NEEDLE";
        window.pfxTest.scheduleSave();
        return true;
      `);
      // Let the save flush + history index.
      await new Promise((r) => setTimeout(r, 800));

      const result = await mn.executeAsyncScript<{ count: number; firstSnapshotHasNeedle: boolean }>(`
        const cb = arguments[arguments.length - 1];
        window.pfxTest.history.search("PFX_SEARCH_NEEDLE", { limit: 10 })
          .then((evs) => {
            const first = evs[0];
            const hasIt = !!first?.snapshot?.nodes?.some((n) => (n.name || "").includes("PFX_SEARCH_NEEDLE"));
            cb({ count: evs.length, firstSnapshotHasNeedle: hasIt });
          })
          .catch(() => cb({ count: -1, firstSnapshotHasNeedle: false }));
      `);

      if (result.count < 1) {
        throw new Error(`search returned no events for 'PFX_SEARCH_NEEDLE' (got ${result.count})`);
      }
      if (!result.firstSnapshotHasNeedle) {
        throw new Error("first matching event's snapshot does not contain the needle name");
      }
    },
  },
];

export default tests;
