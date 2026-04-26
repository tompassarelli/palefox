// Tier 3 integration tests for the chrome-scope global keymap.
//
// Per the user's vimium-replacement plan, these keys work without sidebar
// focus first:
//   t           open spotlight tabs picker
//   :           open spotlight ex-input
//   Alt+X       same as :
//   `           toggle to last selected tab
//   o           focus urlbar
//   O           new tab + focus urlbar
//   x           close current tab
//
// We dispatch keys at the chrome document level (without first activating
// the sidebar) to verify panel-active is no longer required.

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

const DISMISS_EX_INPUT = `
  const inp = document.querySelector(".pfx-search-input");
  if (inp) {
    inp.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true, view: window,
    }));
  }
  return true;
`;

/** Dispatch a keydown WITHOUT first activating the sidebar. Verifies the
 *  global keys work from anywhere. */
function pressGlobal(key: string, opts: { ctrlKey?: boolean; altKey?: boolean } = {}): string {
  return `
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: ${JSON.stringify(key)},
      ctrlKey: ${opts.ctrlKey ? "true" : "false"},
      altKey: ${opts.altKey ? "true" : "false"},
      bubbles: true, cancelable: true, view: window,
    }));
    return true;
  `;
}

const tests: IntegrationTest[] = [
  {
    name: "global-keys: t opens the tabs picker without sidebar focus",
    async run(mn) {
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DISMISS_EX_INPUT);
      // Ensure focus is not on the sidebar panel.
      await mn.executeScript(`
        if (document.activeElement && document.activeElement !== document.body) {
          document.activeElement.blur && document.activeElement.blur();
        }
        return true;
      `);

      await mn.executeScript(pressGlobal("t"));
      await waitFor(mn, `
        const p = document.getElementById("pfx-picker");
        return p && !p.hidden;
      `, 3000);

      // Verify it's the tabs picker (prompt label).
      const prompt = await mn.executeScript<string>(`
        return document.querySelector("#pfx-picker .pfx-picker-prompt")?.getAttribute("value") || "";
      `);
      if (!prompt.includes("tabs")) {
        throw new Error(`expected tabs picker prompt, got: ${prompt}`);
      }
      // Sanity: current-window picker, prompt should NOT include "(all windows)".
      if (prompt.includes("all windows")) {
        throw new Error(`t opened all-windows picker; expected current-window. prompt: ${prompt}`);
      }
      await mn.executeScript(DISMISS_PICKER);
    },
  },

  {
    name: "global-keys: T opens the all-windows tabs picker",
    async run(mn) {
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DISMISS_EX_INPUT);
      await mn.executeScript(`
        if (document.activeElement && document.activeElement !== document.body) {
          document.activeElement.blur && document.activeElement.blur();
        }
        return true;
      `);

      await mn.executeScript(pressGlobal("T"));
      await waitFor(mn, `
        const p = document.getElementById("pfx-picker");
        return p && !p.hidden;
      `, 3000);

      const prompt = await mn.executeScript<string>(`
        return document.querySelector("#pfx-picker .pfx-picker-prompt")?.getAttribute("value") || "";
      `);
      if (!prompt.includes("all windows")) {
        throw new Error(`expected all-windows picker prompt, got: ${prompt}`);
      }
      await mn.executeScript(DISMISS_PICKER);
    },
  },

  {
    name: "global-keys: : opens ex-input without sidebar focus",
    async run(mn) {
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DISMISS_EX_INPUT);
      await mn.executeScript(pressGlobal(":"));
      await waitFor(mn, `return !!document.querySelector(".pfx-search-input");`, 3000);
      await mn.executeScript(DISMISS_EX_INPUT);
    },
  },

  {
    name: "global-keys: x closes the current tab (gBrowser.selectedTab)",
    async run(mn) {
      await mn.executeScript(DISMISS_PICKER);
      // Open an extra tab so we don't kill the only one.
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        return true;
      `);
      const before = await mn.executeScript<number>(`return gBrowser.tabs.length;`);
      // Select the extra tab so x closes it.
      await mn.executeScript(`gBrowser.selectedTab = gBrowser.tabs[gBrowser.tabs.length - 1]; return true;`);

      await mn.executeScript(pressGlobal("x"));
      await waitFor(mn, `return gBrowser.tabs.length === ${before - 1};`, 3000);
    },
  },

  {
    name: "global-keys: ` (backtick) toggles to the previously selected tab",
    async run(mn) {
      await mn.executeScript(DISMISS_PICKER);
      // Need at least 2 tabs.
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        if (gBrowser.tabs.length < 2) gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        return true;
      `);
      // Switch from tab[0] to tab[1] so palefox tracks tab[0] as previous.
      await mn.executeScript(`
        gBrowser.selectedTab = gBrowser.tabs[0];
        return true;
      `);
      await new Promise((r) => setTimeout(r, 100));
      await mn.executeScript(`
        gBrowser.selectedTab = gBrowser.tabs[1];
        return true;
      `);
      await new Promise((r) => setTimeout(r, 100));
      // Press backtick — should toggle back to tab[0].
      const idxBefore = await mn.executeScript<number>(`return [...gBrowser.tabs].indexOf(gBrowser.selectedTab);`);
      if (idxBefore !== 1) throw new Error(`setup failed; expected selectedTab to be tab[1], got tab[${idxBefore}]`);

      await mn.executeScript(pressGlobal("`"));
      await waitFor(mn, `return [...gBrowser.tabs].indexOf(gBrowser.selectedTab) === 0;`, 3000);
    },
  },
];

export default tests;
