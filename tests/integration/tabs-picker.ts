// Tier 3 integration tests for :tabs — the tree-preserving live-tab picker.
//
// Drives the picker via the same key-synthesis path as restore-ux.ts, then
// verifies tree-shape rendering: matched items + their ancestors should be
// visible in tree order, ancestors marked with [pfx-picker-context].

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

const ACTIVATE_VIM = `
  const row = document.querySelector(${"`"}.pfx-tab-row${"`"});
  if (!row) throw new Error("no .pfx-tab-row found");
  const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };
  row.dispatchEvent(new MouseEvent("mousedown", opts));
  row.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
  return true;
`;

const DISMISS_PICKER = `
  const p = document.getElementById("pfx-picker");
  if (p && !p.hidden) {
    const inp = p.querySelector(".pfx-picker-input");
    inp?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true, view: window,
    }));
  }
  return true;
`;

function runEx(cmd: string): string {
  return `
    window.pfxTest.vim.runExCommand(${JSON.stringify(cmd)});
    return true;
  `;
}

const tests: IntegrationTest[] = [
  {
    name: "tabs-picker: :tabs opens picker with one row per live tab",
    async run(mn) {
      // Open extra tabs.
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        for (let i = 0; i < 3; i++) gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        return true;
      `);
      await waitFor(mn, `return gBrowser.tabs.length >= 4;`);
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(ACTIVATE_VIM);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);
      await mn.executeScript(runEx("tabs"));

      await waitFor(mn, `
        const p = document.getElementById("pfx-picker");
        return p && !p.hidden && p.querySelectorAll(".pfx-picker-row").length >= 4;
      `, 3000);

      // Cleanup
      await mn.executeScript(DISMISS_PICKER);
    },
  },

  {
    name: "tabs-picker: tree-preserving filter shows ancestors as context rows",
    async run(mn) {
      // Build a small tree: tabs[0] → tabs[1] (child) → tabs[2] (grandchild).
      // Set distinctive names so we can search for the deep child and
      // verify ancestors come along.
      await mn.executeScript(`
        const tabs = [...gBrowser.tabs];
        if (tabs.length < 3) throw new Error("need 3+ tabs for this test");
        // Use the last 3 tabs (indices N-3, N-2, N-1).
        const a = tabs[tabs.length - 3];
        const b = tabs[tabs.length - 2];
        const c = tabs[tabs.length - 1];
        const tdA = window.pfxTest.treeOf.get(a);
        const tdB = window.pfxTest.treeOf.get(b);
        const tdC = window.pfxTest.treeOf.get(c);
        tdA.name = "PFX_PARENT_TAB";
        tdB.name = "PFX_MIDDLE_TAB";
        tdB.parentId = tdA.id;
        tdC.name = "PFX_DEEP_NEEDLE";
        tdC.parentId = tdB.id;
        window.pfxTest.rows.scheduleTreeResync();
        return true;
      `);

      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(ACTIVATE_VIM);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);
      await mn.executeScript(runEx("tabs"));
      await waitFor(mn, `
        const p = document.getElementById("pfx-picker");
        return p && !p.hidden && p.querySelectorAll(".pfx-picker-row").length > 0;
      `, 3000);

      // Type "DEEP_NEEDLE" — only PFX_DEEP_NEEDLE matches directly, but
      // its ancestors PFX_MIDDLE_TAB and PFX_PARENT_TAB must come along
      // as context rows.
      await mn.executeScript(`
        const inp = document.querySelector("#pfx-picker .pfx-picker-input");
        inp.value = "DEEP_NEEDLE";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      `);

      const result = await mn.executeScript<{
        rowCount: number;
        directLabels: string[];
        contextLabels: string[];
      }>(`
        const rows = [...document.querySelectorAll("#pfx-picker .pfx-picker-row")];
        return {
          rowCount: rows.length,
          directLabels: rows
            .filter((r) => r.getAttribute("pfx-picker-context") !== "true")
            .map((r) => r.querySelector(".pfx-picker-label")?.getAttribute("value") ?? ""),
          contextLabels: rows
            .filter((r) => r.getAttribute("pfx-picker-context") === "true")
            .map((r) => r.querySelector(".pfx-picker-label")?.getAttribute("value") ?? ""),
        };
      `);

      if (!result.directLabels.includes("PFX_DEEP_NEEDLE")) {
        throw new Error(`direct match missing: ${JSON.stringify(result)}`);
      }
      if (!result.contextLabels.includes("PFX_PARENT_TAB")) {
        throw new Error(`PFX_PARENT_TAB should be visible as context: ${JSON.stringify(result)}`);
      }
      if (!result.contextLabels.includes("PFX_MIDDLE_TAB")) {
        throw new Error(`PFX_MIDDLE_TAB should be visible as context: ${JSON.stringify(result)}`);
      }

      await mn.executeScript(DISMISS_PICKER);
    },
  },

  {
    name: "tabs-picker: Tab key opens action menu with close/duplicate/pin/reload",
    async run(mn) {
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(ACTIVATE_VIM);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);
      await mn.executeScript(runEx("tabs"));
      await waitFor(mn, `
        const p = document.getElementById("pfx-picker");
        return p && !p.hidden && p.querySelectorAll(".pfx-picker-row").length > 0;
      `, 3000);

      // Press Tab on the input field to open the action menu.
      await mn.executeScript(`
        const inp = document.querySelector("#pfx-picker .pfx-picker-input");
        inp.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Tab", bubbles: true, cancelable: true, view: window,
        }));
        return true;
      `);

      // Sub-picker should appear with the action labels.
      await waitFor(mn, `
        const rows = [...document.querySelectorAll("#pfx-picker .pfx-picker-row")];
        const labels = rows.map((r) => r.querySelector(".pfx-picker-label")?.getAttribute("value") || "");
        return labels.some((l) => l.startsWith("Close")) &&
               labels.some((l) => l.startsWith("Duplicate")) &&
               labels.some((l) => l.startsWith("Reload"));
      `, 3000);

      await mn.executeScript(DISMISS_PICKER);
    },
  },
];

export default tests;
