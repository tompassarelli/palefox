// Tier 3 integration tests for :checkpoint / :restore / :sessions / :history.
// Drives the vim ex-mode commands via the same synthesized-keyboard path
// as exmode.ts, then verifies effects via pfxTest.history.

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

const DISMISS_PICKER_IF_OPEN = `
  const p = document.getElementById("pfx-picker");
  if (p && !p.hidden) {
    const inp = p.querySelector(".pfx-picker-input");
    inp?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true, view: window,
    }));
  }
  return true;
`;

const ACTIVATE_VIM_ON_FIRST_ROW = `
  const row = document.querySelector(${"`"}.pfx-tab-row${"`"});
  if (!row) throw new Error("no .pfx-tab-row found");
  const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };
  row.dispatchEvent(new MouseEvent("mousedown", opts));
  row.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
  row.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
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
    name: "restore-ux: :checkpoint <label> creates a checkpoint-tagged event",
    async run(mn) {
      // Open a tab so palefox has something to save.
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        return true;
      `);
      await waitFor(mn, `return document.querySelectorAll(".pfx-tab-row").length >= 1;`);
      await mn.executeScript(ACTIVATE_VIM_ON_FIRST_ROW);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);

      await mn.executeScript(runEx("checkpoint MyCheckpoint"));
      // The :checkpoint handler defers tagging via setTimeout(100); give it time.
      await new Promise((r) => setTimeout(r, 600));

      const tagged = await mn.executeAsyncScript<string[]>(`
        const cb = arguments[arguments.length - 1];
        window.pfxTest.history.getTagged(20)
          .then((evs) => cb(evs.map((e) => e.tag)))
          .catch(() => cb([]));
      `);
      const found = tagged.find((t) => t.includes("MyCheckpoint"));
      if (!found) throw new Error(`expected a checkpoint with 'MyCheckpoint', got: ${tagged.join(", ")}`);
      if (!found.startsWith("checkpoint:")) {
        throw new Error(`expected tag to start with 'checkpoint:', got ${found}`);
      }
    },
  },

  {
    name: "restore-ux: :cp alias works the same as :checkpoint",
    async run(mn) {
      await mn.executeScript(ACTIVATE_VIM_ON_FIRST_ROW);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);
      await mn.executeScript(runEx("cp Aliased"));
      await new Promise((r) => setTimeout(r, 600));

      const tagged = await mn.executeAsyncScript<string[]>(`
        const cb = arguments[arguments.length - 1];
        window.pfxTest.history.getTagged(20)
          .then((evs) => cb(evs.map((e) => e.tag)))
          .catch(() => cb([]));
      `);
      if (!tagged.some((t) => t.includes("Aliased"))) {
        throw new Error(`expected an 'Aliased' checkpoint, got: ${tagged.join(", ")}`);
      }
    },
  },

  {
    name: "restore-ux: :sessions opens a picker listing tagged points",
    async run(mn) {
      // We've already created at least 2 checkpoints in prior tests; verify
      // running :sessions opens the picker and populates rows.
      await mn.executeScript(ACTIVATE_VIM_ON_FIRST_ROW);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);
      await mn.executeScript(runEx("sessions"));
      // Picker should appear with rows.
      await waitFor(mn, `
        const p = document.getElementById("pfx-picker");
        if (!p || p.hidden) return false;
        return p.querySelectorAll(".pfx-picker-row").length > 0;
      `, 3000);
      // Dismiss so subsequent tests aren't blocked by the picker capture.
      await mn.executeScript(`
        const inp = document.querySelector("#pfx-picker .pfx-picker-input");
        inp?.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape", bubbles: true, cancelable: true, view: window,
        }));
        return true;
      `);
      await waitFor(mn, `
        const p = document.getElementById("pfx-picker");
        return !p || p.hidden;
      `, 2000);
    },
  },

  {
    name: "restore-ux: :restore <label> reopens saved tabs under a synthetic group",
    async run(mn) {
      // Defensive: dismiss any leftover picker from prior tests so the
      // `:` key dispatch reaches the ex-mode handler.
      await mn.executeScript(DISMISS_PICKER_IF_OPEN);

      // First, create a checkpoint with a known marker tab. Set the tab's
      // name so it's unmistakable post-restore.
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        const t = gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        return true;
      `);
      await new Promise((r) => setTimeout(r, 200));
      await mn.executeScript(`
        const t = gBrowser.tabs[gBrowser.tabs.length - 1];
        const td = window.pfxTest.treeOf.get(t);
        td.name = "PFX_RESTORE_MARKER";
        window.pfxTest.scheduleSave();
        return true;
      `);
      await new Promise((r) => setTimeout(r, 500));

      await mn.executeScript(ACTIVATE_VIM_ON_FIRST_ROW);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);
      await mn.executeScript(runEx("checkpoint RestoreMe"));
      await new Promise((r) => setTimeout(r, 600));

      // Capture pre-restore tab count.
      const before = await mn.executeScript<number>(`return gBrowser.tabs.length;`);

      // Now run :restore RestoreMe.
      await mn.executeScript(runEx("restore RestoreMe"));
      // Restore is async; tab open + onTabOpen chain takes a moment.
      const deadline = Date.now() + 5000;
      let after = before;
      while (Date.now() < deadline && after <= before) {
        after = await mn.executeScript<number>(`return gBrowser.tabs.length;`);
        if (after > before) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (after <= before) {
        throw new Error(`:restore did not open any new tabs (before=${before} after=${after})`);
      }

      // Verify a synthetic group with the right label exists.
      const groupExists = await mn.executeScript<boolean>(`
        const root = document.getElementById("pfx-tab-panel");
        if (!root) return false;
        for (const r of root.querySelectorAll("*")) {
          if (r._group && /RestoreMe/.test(r._group.name)) return true;
        }
        return false;
      `);
      if (!groupExists) {
        throw new Error("synthetic group 'RestoreMe' was not created");
      }
    },
  },
];

export default tests;
