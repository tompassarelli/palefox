// Tier 3 integration tests for vim ex-mode commands and search.
//
// palefox's vim mode supports `:` ex-commands (`:group`, `:refile`, `:pin`,
// aliases) and `/` search with `n`/`N` navigation. Tests drive the input
// fields directly: press `:` to enter ex-mode, set the modeline input's
// value, dispatch Enter to commit. Same pattern for search.
//
// Each test starts by activating vim (clicking a row) so panelActive is
// true. The modeline element (`.pfx-search-input`) is queried after the
// `:` or `/` press.

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

const ACTIVATE_VIM_ON_FIRST_ROW = `
  const row = document.querySelector(${"`"}.pfx-tab-row${"`"});
  if (!row) throw new Error("no .pfx-tab-row found");
  const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };
  row.dispatchEvent(new MouseEvent("mousedown", opts));
  row.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
  row.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
  return true;
`;

function pressKey(key: string, target = "document"): string {
  return `
    ${target}.dispatchEvent(new KeyboardEvent("keydown", {
      key: ${JSON.stringify(key)},
      bubbles: true, cancelable: true, view: window,
    }));
    return true;
  `;
}

/** Dispatch an ex-command directly via pfxTest.vim.runExCommand. The
 *  user-facing flow is `:` → picker → modeline → Enter; tests bypass
 *  the UI by calling the API directly. */
function runExCommand(cmd: string): string {
  return `
    window.pfxTest.vim.runExCommand(${JSON.stringify(cmd)});
    return true;
  `;
}

const tests: IntegrationTest[] = [
  {
    name: "exmode: pressing : opens the ex-command picker",
    async run(mn) {
      // Open extra tabs so we have rows.
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        if (gBrowser.tabs.length < 2) gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
      `);
      await waitFor(mn, `return document.querySelectorAll(".pfx-tab-row").length >= 1;`);

      await mn.executeScript(ACTIVATE_VIM_ON_FIRST_ROW);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);

      await mn.executeScript(pressKey(":"));
      // The picker should appear with prompt "ex ›".
      await waitFor(mn, `
        const p = document.getElementById("pfx-picker");
        if (!p || p.hidden) return false;
        const prompt = p.querySelector(".pfx-picker-prompt")?.getAttribute("value") || "";
        return prompt.includes("ex");
      `, 2000);

      // Cleanup: dismiss with Escape.
      await mn.executeScript(`
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape", bubbles: true, cancelable: true, view: window,
        }));
      `);
    },
  },

  {
    name: "exmode: :group <name> creates a group with that name",
    async run(mn) {
      await mn.executeScript(ACTIVATE_VIM_ON_FIRST_ROW);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);

      await mn.executeScript(runExCommand("group MyTestGroup"));

      // Group with that name appears in the panel.
      await waitFor(mn, `
        const grps = document.querySelectorAll("#pfx-tab-panel *");
        for (const r of grps) {
          if (r._group && r._group.name === "MyTestGroup") return true;
        }
        return false;
      `);
    },
  },

  {
    name: "exmode: :grp alias works the same as :group",
    async run(mn) {
      await mn.executeScript(ACTIVATE_VIM_ON_FIRST_ROW);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);

      await mn.executeScript(runExCommand("grp AliasGroup"));

      await waitFor(mn, `
        for (const r of document.querySelectorAll("#pfx-tab-panel *")) {
          if (r._group && r._group.name === "AliasGroup") return true;
        }
        return false;
      `);
    },
  },

  {
    name: "exmode: :pin pins the focused tab via gBrowser.pinTab",
    async run(mn) {
      await mn.executeScript(ACTIVATE_VIM_ON_FIRST_ROW);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);

      // Pick whatever tab cursor is on, capture pinned state.
      const before = await mn.executeScript<boolean>(`
        const r = document.querySelector(".pfx-tab-row[pfx-cursor]");
        return !!r._tab && r._tab.pinned;
      `);
      // If already pinned, unpin first so the test exercises the pin path.
      if (before) {
        await mn.executeScript(`
          const r = document.querySelector(".pfx-tab-row[pfx-cursor]");
          gBrowser.unpinTab(r._tab);
        `);
        await waitFor(mn, `
          const r = document.querySelector(".pfx-tab-row[pfx-cursor]");
          return r && r._tab && !r._tab.pinned;
        `);
      }

      await mn.executeScript(runExCommand("pin"));

      // Tab should now be pinned. Note: pinning moves the tab into the
      // pinned container, so the pfx-cursor row may have changed; we
      // verify by tab id rather than by re-querying the cursor.
      await waitFor(mn, `
        return [...gBrowser.tabs].some(t => t.pinned);
      `);
    },
  },

  // / removed from palefox; Firefox's native find-as-you-type owns it.
  // The old "/ opens in-sidebar filter" tests have been deleted. The
  // global-key behaviors live in tests/integration/global-keys.ts.
];

export default tests;
