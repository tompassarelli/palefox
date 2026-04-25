// Tier 3 integration tests for compact mode (real Firefox via Marionette).
// See docs/dev/testing.md for how the harness works.
//
// These tests prove behavior that Tier 2 mocks can't reach:
//   - palefox autoconfig loaded into the ephemeral profile
//   - Real `Services.prefs` observer chain reacts to pref changes
//   - Real chrome DOM (`#sidebar-main` etc.) gets the expected attributes
//   - The hover-strip element is created and removed by enable/disable
//
// Note: under `--headless`, some chrome elements that depend on toolbar
// customization (like `#sidebar-button` itself) aren't present at script
// eval time. Tests here probe behavior that doesn't require those —
// headless-mode-specific UX work belongs in headed CI / manual QA.

import type { IntegrationTest } from "../../tools/test-driver/runner.ts";
import type { MarionetteClient } from "../../tools/test-driver/marionette.ts";

/** Poll the chrome scope until `scriptReturningBool` evaluates truthy or the
 *  timeout elapses. Throws on timeout. Pollback at 100ms — fast enough for
 *  pref-observer reactions, gentle on Firefox. */
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
    name: "palefox bootstrap: chrome window has sidebar-main and gBrowser",
    async run(mn) {
      const info = await mn.executeScript<{
        url: string;
        sidebarMain: boolean;
        gBrowser: boolean;
        compactPrefRegistered: boolean;
      }>(`
        return {
          url: window.location?.href || "",
          sidebarMain: !!document.getElementById("sidebar-main"),
          gBrowser: typeof window.gBrowser !== "undefined",
          compactPrefRegistered: Services.prefs.prefHasUserValue("pfx.debug")
            || true,  // 'true' is fine if no user value — Services itself works
        };
      `);
      if (info.url !== "chrome://browser/content/browser.xhtml") {
        throw new Error(`unexpected chrome URL: ${info.url}`);
      }
      if (!info.sidebarMain) throw new Error("#sidebar-main missing from chrome doc");
      if (!info.gBrowser) throw new Error("gBrowser global missing — palefox load context wrong");
    },
  },

  {
    name: "compact pref observer: setting true adds data-pfx-compact, false removes it",
    async run(mn) {
      // Sanity: attribute starts absent.
      const startAttr = await mn.executeScript<boolean>(
        `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact") || false;`,
      );
      if (startAttr) {
        throw new Error("data-pfx-compact already set at startup — test profile state leaked?");
      }

      // Flip pref → palefox's observer should add the attribute.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", true);`);
      await waitFor(
        mn,
        `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact") || false;`,
      );

      // Flip back → attribute removed.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", false);`);
      await waitFor(
        mn,
        `return !document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact");`,
      );
    },
  },

  {
    name: "compact: hover strip element is created when active, removed when off",
    async run(mn) {
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", true);`);
      await waitFor(mn, `return !!document.getElementById("pfx-hover-strip");`);

      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", false);`);
      await waitFor(mn, `return !document.getElementById("pfx-hover-strip");`);
    },
  },

  {
    name: "horizontal compact: setting pfx.toolbar.compact in horizontal mode adds the root attribute",
    async run(mn) {
      // Switch to horizontal layout, then enable horizontal compact.
      await mn.executeScript(`Services.prefs.setBoolPref("sidebar.verticalTabs", false);`);
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.toolbar.compact", true);`);
      await waitFor(
        mn,
        `return document.documentElement.hasAttribute("data-pfx-compact-horizontal");`,
      );

      // Disable horizontal compact + restore vertical layout for the next test.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.toolbar.compact", false);`);
      await waitFor(
        mn,
        `return !document.documentElement.hasAttribute("data-pfx-compact-horizontal");`,
      );
      await mn.executeScript(`Services.prefs.setBoolPref("sidebar.verticalTabs", true);`);
    },
  },
];

export default tests;
