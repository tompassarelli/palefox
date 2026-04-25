// Tier 3 integration tests that REQUIRE headed mode.
//
// In headless Firefox, certain things don't render or behave the same:
//   - #sidebar-button (native customizable toolbar widget) isn't present
//     at script-eval time, so palefox's `if (sidebarButton)` block in
//     drawer/index.ts skips creating #pfx-sidebar-button.
//   - Real cursor / `:hover` pseudoclass tracking can be flaky.
//
// Each test here calls `ctx.skip(reason)` when `ctx.headed` is false. The
// runner emits `test:skip` events for these — they don't count as failures
// but show up in the run log so you don't lose track. Run headed via:
//   bun run test:integration -- --headed
// (Heads up: --headed pops a real Firefox window on your compositor.)

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
    // Note: in fresh ephemeral profiles, Firefox doesn't add sidebar-button
    // to the nav-bar by default — that customization gets persisted via
    // xulstore.json after a real profile uses the sidebar UI. We add it
    // explicitly here via CustomizableUI so the test reflects the
    // daily-driver state of palefox users.
    name: "headed: adding sidebar-button to nav-bar makes #pfx-sidebar-button appear",
    async run(mn, ctx) {
      if (!ctx.headed) ctx.skip("needs --headed: feature not present in headless Firefox");

      // Add the native sidebar-button to nav-bar via CustomizableUI.
      await mn.executeScript(`
        const { CustomizableUI } = ChromeUtils.importESModule(
          "resource:///modules/CustomizableUI.sys.mjs"
        );
        if (!CustomizableUI.getPlacementOfWidget("sidebar-button")) {
          CustomizableUI.addWidgetToArea("sidebar-button", "nav-bar");
        }
        return true;
      `);
      await waitFor(mn, `return !!document.getElementById("sidebar-button");`, 5000);

      // palefox runs at script load, BEFORE we just-now customized the
      // toolbar. So #pfx-sidebar-button hasn't been created on first boot.
      // In real daily-driver use, sidebar-button is customized BEFORE
      // palefox's first run (across many sessions), so palefox finds it.
      // To reproduce that timing in a fresh profile, restart Firefox so
      // palefox runs AFTER the toolbar customization is persisted.
      const mn2 = await ctx.restartFirefox();
      await waitFor(mn2, `return !!document.getElementById("pfx-sidebar-button");`, 15_000);
    },
  },

  {
    name: "headed: right-click on #pfx-sidebar-button opens the custom menu",
    async run(mn, ctx) {
      if (!ctx.headed) ctx.skip("needs --headed: feature not present in headless Firefox");
      // pfx-sidebar-button should already exist from the prior test (which
      // customized the toolbar + restarted). If running this test in
      // isolation, the prior step would need re-running.
      await waitFor(mn, `return !!document.getElementById("pfx-sidebar-button");`, 5000);

      // Synthesize a contextmenu event on the button. palefox wires the
      // button's `context` attribute to "pfx-sidebar-button-menu", which
      // Firefox's chrome menu plumbing reads on contextmenu.
      await mn.executeScript(`
        const btn = document.getElementById("pfx-sidebar-button");
        const ev = new MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, button: 2,
        });
        btn.dispatchEvent(ev);
        return true;
      `);

      // Menu should open. The menu's id is set by drawer/index.ts.
      await waitFor(
        mn,
        `
        const menu = document.getElementById("pfx-sidebar-button-menu");
        return menu && (menu.state === "open" || menu.state === "showing");
        `,
        2000,
      );
    },
  },

  {
    name: "headed: real pointer move to hover-strip area triggers compact reveal",
    async run(mn, ctx) {
      if (!ctx.headed) ctx.skip("needs --headed: feature not present in headless Firefox");

      // Enable compact and confirm the hover strip element exists.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", true);`);
      await waitFor(mn, `return !!document.getElementById("pfx-hover-strip");`);

      // Compute the strip's screen coordinates so we can target the cursor.
      const stripRect = await mn.executeScript<{ x: number; y: number }>(`
        const s = document.getElementById("pfx-hover-strip");
        const r = s.getBoundingClientRect();
        return { x: Math.floor(r.left + r.width / 2), y: Math.floor(r.top + r.height / 2) };
      `);

      // WebDriver actions: pointer move to the strip center. The
      // sequence is "move to (x,y) over 100ms" then "pause 200ms" so
      // palefox's hoverHackDelay tick has time to fire.
      await mn.performActions([
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", x: stripRect.x, y: stripRect.y, duration: 100 },
            { type: "pause", duration: 300 },
          ],
        },
      ]);
      await mn.releaseActions();

      // The hover strip's mouseenter handler calls flashSidebar →
      // pfx-has-hover gets set.
      await waitFor(
        mn,
        `return document.getElementById("sidebar-main")?.hasAttribute("pfx-has-hover");`,
        3000,
      );

      // Cleanup: turn off compact.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", false);`);
    },
  },
];

export default tests;
