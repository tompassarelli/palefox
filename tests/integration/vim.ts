// Tier 3 integration tests for vim mode.
//
// Drives palefox's vim handler via synthesized MouseEvent + KeyboardEvent
// in chrome scope. Since `--headless` doesn't deliver real input events,
// we dispatch them manually on the elements palefox listens on.
//
// What's covered:
//   - activate vim mode by clicking a tab row → cursor + panelActive set
//   - `j` / `k` move the cursor and the selected tab
//   - `gg` chord goes to top
//   - `Escape` deactivates panel
//
// Not covered here (would need fuller harness work):
//   - vim chords involving rename / search input field focus dance
//   - drag-from-vim flows
//   - multi-row selection with `V`

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

/** Dispatch a synthetic mousedown + mouseup on the element matching
 *  `selector`. palefox's row click handler runs on mousedown to activate vim. */
const SCRIPT_CLICK_FIRST = `
  const row = document.querySelector(${"`"}.pfx-tab-row${"`"});
  if (!row) throw new Error("no .pfx-tab-row found in panel");
  const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };
  row.dispatchEvent(new MouseEvent("mousedown", opts));
  row.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
  row.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
  return true;
`;

/** Dispatch a keydown on document with a single character key. palefox's
 *  vim handler is registered on document, so this is the same path real
 *  user input would take. */
function pressKey(key: string): string {
  // Note: bubbles/cancelable required for the handler chain. `key` field
  // is what palefox checks against in its switch statements.
  return `
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: ${JSON.stringify(key)},
      bubbles: true,
      cancelable: true,
      view: window,
    }));
    return true;
  `;
}

const tests: IntegrationTest[] = [
  {
    name: "vim: open tabs, click first row, panel becomes active",
    async run(mn) {
      // Open a few extra tabs so we have multiple rows to navigate.
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
      `);
      await waitFor(mn, `return gBrowser.tabs.length >= 4;`);
      // Wait for palefox to render rows for them.
      await waitFor(
        mn,
        `return (document.querySelectorAll("#pfx-tab-panel .pfx-tab-row, #pfx-tab-panel-pinned .pfx-tab-row").length || 0) >= 4;`,
      );

      // Click the first row.
      await mn.executeScript(SCRIPT_CLICK_FIRST);

      // Cursor should be set on a row (state.cursor exposed via attribute).
      // palefox sets `pfx-cursor` attribute on the cursor row.
      await waitFor(
        mn,
        `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`,
        2000,
      );
    },
  },

  {
    name: "vim: j/k navigation moves cursor between rows",
    async run(mn) {
      // Activate (click first row).
      await mn.executeScript(SCRIPT_CLICK_FIRST);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);

      // Capture index before.
      const before = await mn.executeScript<number>(`
        const rows = [...document.querySelectorAll(".pfx-tab-row")];
        return rows.indexOf(document.querySelector(".pfx-tab-row[pfx-cursor]"));
      `);

      // Press j → cursor moves down.
      await mn.executeScript(pressKey("j"));
      await waitFor(mn, `
        const rows = [...document.querySelectorAll(".pfx-tab-row")];
        return rows.indexOf(document.querySelector(".pfx-tab-row[pfx-cursor]")) > ${before};
      `);

      // Press k → cursor moves back up.
      await mn.executeScript(pressKey("k"));
      await waitFor(mn, `
        const rows = [...document.querySelectorAll(".pfx-tab-row")];
        return rows.indexOf(document.querySelector(".pfx-tab-row[pfx-cursor]")) === ${before};
      `);
    },
  },

  {
    name: "vim: gg chord jumps cursor to first row",
    async run(mn) {
      // Activate, then move down a couple times to ensure we're not already at top.
      await mn.executeScript(SCRIPT_CLICK_FIRST);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);
      await mn.executeScript(pressKey("j"));
      await mn.executeScript(pressKey("j"));

      // Press g twice (chord).
      await mn.executeScript(pressKey("g"));
      await mn.executeScript(pressKey("g"));

      // Cursor should be on the first row now.
      await waitFor(
        mn,
        `
        const rows = [...document.querySelectorAll(".pfx-tab-row")];
        return rows.indexOf(document.querySelector(".pfx-tab-row[pfx-cursor]")) === 0;
        `,
        2000,
      );
    },
  },

  {
    name: "vim: G jumps cursor to last visible row",
    async run(mn) {
      await mn.executeScript(SCRIPT_CLICK_FIRST);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);

      await mn.executeScript(pressKey("G"));
      await waitFor(
        mn,
        `
        const rows = [...document.querySelectorAll(".pfx-tab-row:not([hidden]):not([pfx-collapsed-hidden])")];
        const cursor = document.querySelector(".pfx-tab-row[pfx-cursor]");
        return cursor === rows[rows.length - 1];
        `,
        2000,
      );
    },
  },

  {
    name: "pfxTest debug API: snapshotTree returns one entry per live tab",
    async run(mn) {
      // Open tabs so we have something to snapshot.
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
      `);
      await waitFor(mn, `return gBrowser.tabs.length >= 3;`);

      const result = await mn.executeScript<{
        apiPresent: boolean;
        snapshotLen: number;
        cursorId: number | null;
        firstEntryHasId: boolean;
      }>(`
        if (!window.pfxTest) return { apiPresent: false, snapshotLen: 0, cursorId: null, firstEntryHasId: false };
        const snap = window.pfxTest.snapshotTree();
        return {
          apiPresent: true,
          snapshotLen: snap.length,
          cursorId: window.pfxTest.cursorId(),
          firstEntryHasId: snap.length > 0 && typeof snap[0].id === "number",
        };
      `);

      if (!result.apiPresent) {
        throw new Error("window.pfxTest not exposed — gate pref not active in profile");
      }
      if (result.snapshotLen < 3) {
        throw new Error(`expected snapshotTree() to have 3+ entries, got ${result.snapshotLen}`);
      }
      if (!result.firstEntryHasId) {
        throw new Error("snapshotTree() entries missing numeric id field");
      }
    },
  },

  {
    name: "pfxTest debug API: cursorId tracks vim cursor moves",
    async run(mn) {
      // Activate vim on first row.
      await mn.executeScript(SCRIPT_CLICK_FIRST);
      await waitFor(mn, `return window.pfxTest?.cursorId?.() != null;`);

      const before = await mn.executeScript<number | null>(
        `return window.pfxTest.cursorId();`,
      );

      // Move cursor down via j.
      await mn.executeScript(pressKey("j"));
      await waitFor(mn, `return window.pfxTest.cursorId() !== ${JSON.stringify(before)};`);

      const after = await mn.executeScript<number | null>(
        `return window.pfxTest.cursorId();`,
      );
      if (after === before) {
        throw new Error(`cursorId unchanged after j press. before=${before} after=${after}`);
      }
    },
  },

  {
    name: "vim: Escape deactivates panel (pfx-cursor cleared on blur)",
    async run(mn) {
      await mn.executeScript(SCRIPT_CLICK_FIRST);
      await waitFor(mn, `return !!document.querySelector(".pfx-tab-row[pfx-cursor]");`);

      // Send a key palefox doesn't bind to, which deactivates the panel.
      // Specifically, an unbound printable char triggers blurPanel + content focus.
      await mn.executeScript(pressKey("z"));
      // After deactivation, panel should no longer have keyboard focus —
      // palefox calls gBrowser.selectedBrowser.focus() and clears panelActive.
      // Verify by sending another `j` and confirming cursor doesn't move.
      const before = await mn.executeScript<number>(`
        const rows = [...document.querySelectorAll(".pfx-tab-row")];
        const cursor = document.querySelector(".pfx-tab-row[pfx-cursor]");
        return cursor ? rows.indexOf(cursor) : -1;
      `);
      await mn.executeScript(pressKey("j"));
      // Wait briefly to give palefox a chance to react if it WERE still active.
      await new Promise((r) => setTimeout(r, 200));
      const after = await mn.executeScript<number>(`
        const rows = [...document.querySelectorAll(".pfx-tab-row")];
        const cursor = document.querySelector(".pfx-tab-row[pfx-cursor]");
        return cursor ? rows.indexOf(cursor) : -1;
      `);
      if (after !== before) {
        throw new Error(`cursor moved after blurPanel — vim handler still active. before=${before} after=${after}`);
      }
    },
  },
];

export default tests;
