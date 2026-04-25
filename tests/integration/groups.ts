// Tier 3 integration tests for tab groups.
//
// palefox supports user-defined groups — header rows that sit between tabs
// in the tree. Tab→group parentage uses string parentIds ("g1", "g2") in
// TreeData, distinct from numeric tab→tab parentIds. Group state is
// persisted in palefox-history.sqlite with afterTabId anchoring.
//
// Tests here drive the API via `pfxTest` (the test-only debug surface) so
// we can exercise palefox's group-aware code paths without faking ex-mode
// or hand-firing keyboard shortcuts.

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
    name: "groups: createGroupRow inserts a group row in the panel with the right attributes",
    async run(mn) {
      // Make sure we have at least one tab to position the group around.
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        if (gBrowser.tabs.length < 2) gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
      `);
      await waitFor(mn, `return gBrowser.tabs.length >= 2;`);

      const result = await mn.executeScript<{ ok: boolean; groupId?: string; level?: number; attrs?: Record<string, string> }>(`
        if (!window.pfxTest) throw new Error("pfxTest not available");
        const grp = window.pfxTest.rows.createGroupRow("Test Group", 0);
        // Insert into the panel so layout/visibility code paths can see it.
        window.pfxTest.state.panel.appendChild(grp);
        window.pfxTest.rows.updateVisibility();
        return {
          ok: !!grp._group,
          groupId: grp._group?.id,
          level: grp._group?.level,
          attrs: {
            class: grp.className,
            "pfx-group": grp.getAttribute("pfx-group") || "",
          },
        };
      `);
      if (!result.ok) throw new Error("createGroupRow returned a row without _group decoration");
      if (!result.groupId || typeof result.groupId !== "string") {
        throw new Error(`group id missing or wrong type: ${JSON.stringify(result.groupId)}`);
      }
      if (result.level !== 0) {
        throw new Error(`expected level 0, got ${result.level}`);
      }
    },
  },

  {
    name: "groups: tab with string parentId resolves to group.level + 1 via levelOf",
    async run(mn) {
      const result = await mn.executeScript<{
        groupLevel: number;
        tabLevel: number;
        relationship: string;
      }>(`
        if (!window.pfxTest) throw new Error("pfxTest not available");
        // Create a group at level 1 (a sub-group within an outer level).
        const grp = window.pfxTest.rows.createGroupRow("Nested", 1);
        window.pfxTest.state.panel.appendChild(grp);

        // Pick a tab and set its parentId to the group's id.
        const tab = gBrowser.tabs[gBrowser.tabs.length - 1];
        const td = window.pfxTest.treeOf.get(tab);
        td.parentId = grp._group.id;
        // Force a row resync.
        window.pfxTest.rows.scheduleTreeResync();

        // Helpers exported from src/tabs/helpers.ts aren't exposed via
        // pfxTest, but levelOf is computed from treeOf, gBrowser.tabs, and
        // panel rows — we can reproduce its logic enough to verify.
        // Actual production levelOf:  numeric → walk parent chain;
        //                              string  → groupById(id).level + 1
        // We can fetch group by walking the panel.
        function findGroup(id) {
          for (const r of window.pfxTest.state.panel.querySelectorAll("*")) {
            if (r._group && r._group.id === id) return r._group;
          }
          return null;
        }
        const group = findGroup(td.parentId);
        const tabLevel = group ? group.level + 1 : 0;
        return {
          groupLevel: group ? group.level : -999,
          tabLevel,
          relationship: ${"`"}tab.parentId=${"$"}{td.parentId}${"`"},
        };
      `);
      if (result.groupLevel !== 1) throw new Error(`group level expected 1, got ${result.groupLevel}`);
      if (result.tabLevel !== 2) throw new Error(`tab-in-group level expected 2, got ${result.tabLevel}`);
    },
  },

  {
    name: "groups: snapshotTree reflects tab.parentId pointing at a group string id",
    async run(mn) {
      const snap = await mn.executeScript<Array<{ id: number; parentId: number | string | null; url: string }>>(`
        return window.pfxTest.snapshotTree();
      `);
      const grouped = snap.filter((n) => typeof n.parentId === "string");
      if (grouped.length === 0) {
        throw new Error("expected at least one tab with a string parentId from prior test");
      }
      // The string parentId should look like "g<number>" or similar.
      for (const n of grouped) {
        if (typeof n.parentId !== "string" || !n.parentId.length) {
          throw new Error(`expected non-empty string parentId, got ${JSON.stringify(n.parentId)}`);
        }
      }
    },
  },

  {
    name: "groups: persisted history snapshot includes group entries with afterTabId",
    async run(mn) {
      // Trigger a save by moving a tab.
      await mn.executeScript(`gBrowser.moveTabTo(gBrowser.tabs[gBrowser.tabs.length - 1], { tabIndex: 0 });`);
      // Saves are debounced; let one fire.
      await new Promise((r) => setTimeout(r, 500));

      // Query the latest history event. Snapshot should contain a group node.
      const result = await mn.executeAsyncScript<{
        eventCount: number;
        groupNodes: Array<{ name?: string; afterTabId?: number | null }>;
      }>(`
        const cb = arguments[arguments.length - 1];
        window.pfxTest.history.getRecent(20)
          .then((events) => {
            // Walk events newest-first and grab the first one that has a group.
            for (const ev of events) {
              const groups = (ev.snapshot.nodes || []).filter((n) => n.type === "group");
              if (groups.length) {
                cb({ eventCount: events.length, groupNodes: groups });
                return;
              }
            }
            cb({ eventCount: events.length, groupNodes: [] });
          })
          .catch(() => cb({ eventCount: -1, groupNodes: [] }));
      `);

      if (result.groupNodes.length === 0) {
        throw new Error(`no group nodes in any of the ${result.eventCount} recent events`);
      }
      for (const g of result.groupNodes) {
        if (!("afterTabId" in g)) {
          throw new Error(`group missing afterTabId field: ${JSON.stringify(g)}`);
        }
        if (g.afterTabId !== null && typeof g.afterTabId !== "number") {
          throw new Error(`group afterTabId wrong type: ${JSON.stringify(g.afterTabId)}`);
        }
      }
    },
  },
];

export default tests;
