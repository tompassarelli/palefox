// Tier 3 integration tests for multi-window behavior.
//
// palefox runs per-window — each chrome window gets its own copy of every
// .uc.js script's IIFE. State that LOOKS shared (compact pref, sidebar
// width pref) is actually pref-driven so it propagates; state that's
// per-window (cursor position, tree DOM) is independent.
//
// Tests here validate:
//   - Opening a second window: palefox initializes there too (independent
//     pfxTest API surface in each)
//   - Compact pref change in window A propagates to window B (Services.prefs
//     is process-wide, observers fire in both)
//   - Closing one window leaves the other functional

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
    name: "multiwindow: OpenBrowserWindow() spawns a second chrome window with palefox loaded",
    async run(mn) {
      const handlesBefore = await mn.getWindowHandles();
      const handleBefore = await mn.getWindowHandle();

      // Open a second window from chrome scope. OpenBrowserWindow is a
      // global helper Firefox exposes for opening new top-level browser windows.
      await mn.executeScript(`
        const win = OpenBrowserWindow();
        // Stash a marker so we can wait for it to finish loading
        win.addEventListener("load", () => { win.__pfxTestLoaded = true; }, { once: true });
        return true;
      `);

      // Wait for the new handle to appear.
      const deadline = Date.now() + 10_000;
      let handlesAfter = handlesBefore;
      while (Date.now() < deadline && handlesAfter.length === handlesBefore.length) {
        handlesAfter = await mn.getWindowHandles();
        await new Promise((r) => setTimeout(r, 200));
      }
      if (handlesAfter.length <= handlesBefore.length) {
        throw new Error(`new window never appeared. handlesBefore=${handlesBefore.length} handlesAfter=${handlesAfter.length}`);
      }

      // Find the new handle and switch to it.
      const newHandle = handlesAfter.find((h) => !handlesBefore.includes(h));
      if (!newHandle) throw new Error("could not isolate new window handle");
      await mn.switchToWindow(newHandle);

      // Verify palefox loaded in the second window — pfxTest should be
      // present on its window too.
      await waitFor(
        mn,
        `return typeof window.pfxTest !== "undefined" && !!document.getElementById("sidebar-main");`,
        15_000,
      );

      // Switch back to the original window for cleanup.
      await mn.switchToWindow(handleBefore);
    },
  },

  {
    name: "multiwindow: compact pref propagates across windows (Services.prefs is process-wide)",
    async run(mn) {
      const handles = await mn.getWindowHandles();
      if (handles.length < 2) throw new Error("expected 2+ windows from prior test");

      const [hA, hB] = handles;
      // Window A: enable compact.
      await mn.switchToWindow(hA!);
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", true);`);
      await waitFor(mn, `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact");`);

      // Window B: should also have data-pfx-compact set (observer fires
      // in every chrome window's palefox instance).
      await mn.switchToWindow(hB!);
      await waitFor(
        mn,
        `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact");`,
      );

      // Cleanup: turn pref off.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", false);`);
      await mn.switchToWindow(hA!);
      await waitFor(
        mn,
        `return !document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact");`,
      );
    },
  },

  {
    name: "multiwindow: closing the second window leaves the first functional",
    async run(mn) {
      const handles = await mn.getWindowHandles();
      if (handles.length < 2) throw new Error("expected 2+ windows for this test");

      const [hA, hB] = handles;
      // Switch to second, close it.
      await mn.switchToWindow(hB!);
      const remaining = await mn.closeWindow();
      if (remaining.length !== handles.length - 1) {
        throw new Error(
          `expected ${handles.length - 1} windows after close, got ${remaining.length}`,
        );
      }

      // First window should still be operational.
      await mn.switchToWindow(hA!);
      const ok = await mn.executeScript<boolean>(
        `return typeof window.pfxTest !== "undefined" && !!document.getElementById("sidebar-main");`,
      );
      if (!ok) throw new Error("first window broken after closing second");
    },
  },
];

export default tests;
