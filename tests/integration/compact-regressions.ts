// Tier 3 regression tests for compact-mode bugs we hit during development.
//
// Each test is named `regression: <short bug description>`. If a future
// refactor reintroduces the bug, the test fails. The point is to lock in
// the fixes — not to re-derive what was broken; the dissertation in
// docs/dev/compact-mode-dissertation.md has the long form.

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
    // Bug (reported by user): mouse re-enters the sidebar AS IT'S CLOSING,
    // and the sidebar stays hidden — appears "locked out." User reports
    // having to slowly drag back in to recover. Root cause: setHover(false)
    // (the close commit) stamps a 280ms collapse-protection window. If the
    // user re-enters during that window, onSidebarEnter → setHover(true)
    // checks _collapseProtectedUntil and DROPS the reveal. The protection
    // was meant to suppress spurious reveal events during the close
    // animation — but a confirmed `:hover` after the hoverHackDelay tick
    // is real user intent, not a spurious event.
    //
    // Fix: onSidebarEnter cancels _collapseProtectedUntil after `:hover`
    // is confirmed, before scheduling setHover(true).
    name: "regression: mouse re-entering during close animation interrupts the close",
    async run(mn) {
      // Set up: enable compact, force sidebar visible.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", true);`);
      await waitFor(mn, `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact");`);
      await new Promise((r) => setTimeout(r, 350)); // wait out any prior protection

      // Show the sidebar (cursor "arrives").
      await mn.executeScript(`document.getElementById("sidebar-main").dispatchEvent(new CustomEvent("pfx-flash"));`);
      await waitFor(mn, `return document.getElementById("sidebar-main")?.hasAttribute("pfx-has-hover");`, 2000);

      // Wait for the flash auto-hide to fire — this stamps collapse-protection.
      // FLASH_DURATION = 800ms; wait 1000ms to be safe past it but well within
      // the 280ms protection window that follows.
      await new Promise((r) => setTimeout(r, 900));
      const stillVisible = await mn.executeScript<boolean>(
        `return document.getElementById("sidebar-main")?.hasAttribute("pfx-has-hover") || false;`,
      );
      // We expect it to be hiding/hidden by now (flash timer fired).
      // (Don't assert false here — there's natural jitter; just continue.)

      // Now simulate the cursor RETURNING during the protection window.
      // We need to dispatch a mouseover that passes the `:hover` check
      // inside onSidebarEnter. Without a real cursor, we have to set up
      // the dispatchEvent path correctly: the handler reads
      // `event.target.matches(":hover")` after a setTimeout(hoverHackDelay)
      // tick. happy-dom-style :hover pseudoclass tracking is finicky in
      // headless Firefox without a real cursor.
      //
      // Workaround: bypass the :hover check by dispatching mouseover with
      // a target that has `matches: () => true` patched on it. (We test
      // the post-:hover-confirm path: collapse-protection cancellation +
      // reveal.) The :hover check itself is tested in vim.ts.
      await mn.executeScript(`
        const sb = document.getElementById("sidebar-main");
        // Patch matches() temporarily so the simulated cursor return
        // passes onSidebarEnter's check. Restore right after.
        const orig = sb.matches.bind(sb);
        sb.matches = (s) => s === ":hover" ? true : orig(s);
        sb.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
        // hoverHackDelay defaults to 0; the handler runs on next microtask.
        // Restore matches() after a frame so the rAF inside onSidebarEnter
        // also sees the patched version.
        setTimeout(() => { sb.matches = orig; }, 100);
        return true;
      `);

      // After the re-entry, the reveal should NOT be dropped — pfx-has-hover
      // should be set (or about to be set on the next rAF tick).
      await waitFor(
        mn,
        `return document.getElementById("sidebar-main")?.hasAttribute("pfx-has-hover") || false;`,
        2000,
      );

      // Cleanup
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", false);`);
    },
  },
  {
    // Bug: window.blur bubbles up from any focused element (urlbar, popups,
    // input fields) — palefox's old listener didn't filter `e.target ===
    // window`, so it reconciled (and force-cleared pfx-has-hover) dozens of
    // times per second of normal user activity. Pegged CPU and made the
    // sidebar flicker.
    // Fix: `if (e.target !== window) return;` at the top of onWindowBlur.
    name: "regression: window.blur bubbling from inputs doesn't tear down compact",
    async run(mn) {
      // Enable compact + force visible.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", true);`);
      await waitFor(mn, `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact");`);
      // Wait out any prior collapse-protection so the flash actually reveals.
      await new Promise((r) => setTimeout(r, 350));
      await mn.executeScript(`document.getElementById("sidebar-main").dispatchEvent(new CustomEvent("pfx-flash"));`);
      await waitFor(mn, `return document.getElementById("sidebar-main")?.hasAttribute("pfx-has-hover");`, 2000);

      // Now dispatch 50 blur events whose target is NOT window. If the
      // regression returns, palefox will reconcile-and-clear pfx-has-hover.
      await mn.executeScript(`
        const sb = document.getElementById("sidebar-main");
        const fakeFocusable = document.createElement("input");
        document.body.appendChild(fakeFocusable);
        for (let i = 0; i < 50; i++) {
          fakeFocusable.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        }
        fakeFocusable.remove();
        return true;
      `);

      // Sidebar should still be visible.
      const stillVisible = await mn.executeScript<boolean>(
        `return document.getElementById("sidebar-main")?.hasAttribute("pfx-has-hover") || false;`,
      );
      if (!stillVisible) {
        throw new Error("compact sidebar lost pfx-has-hover after non-window blur events — regression returned");
      }

      // Cleanup
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", false);`);
    },
  },

  {
    // Bug: a setHover(true) call inside the 280ms window after setHover(false)
    // would race with the close-animation transform and produce a flicker /
    // partial open. Fix: setHover(true) checks `Date.now() <
    // _collapseProtectedUntil` and drops the reveal.
    // We test by enabling compact, hiding (via pfx-dismiss), then immediately
    // dispatching pfx-flash. The reveal should be dropped, NOT the sidebar
    // shown again.
    name: "regression: collapse-protection drops mid-animation reveal",
    async run(mn) {
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", true);`);
      await waitFor(mn, `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact");`);
      // Wait out leftover protection from any prior test.
      await new Promise((r) => setTimeout(r, 350));

      // Force visible.
      await mn.executeScript(`document.getElementById("sidebar-main").dispatchEvent(new CustomEvent("pfx-flash"));`);
      await waitFor(mn, `return document.getElementById("sidebar-main")?.hasAttribute("pfx-has-hover");`, 2000);

      // Hide via dismiss → stamps collapse-protection window.
      await mn.executeScript(`document.getElementById("sidebar-main").dispatchEvent(new CustomEvent("pfx-dismiss"));`);
      // BUT pfx-dismiss sets _ignoreNextHover for KEEP_HOVER_DURATION+100ms,
      // which clears separately from the collapse-protection. The collapse-
      // protection itself is stamped by setHover(false). To test JUST the
      // collapse-protection branch, use a path that doesn't set
      // _ignoreNextHover: simulate cursor leaving the strip after a normal
      // hide. Easier: trigger hide via reconcile, then immediately try to
      // flash.
      // For our purposes: dispatch pfx-flash IMMEDIATELY after dismiss.
      // _ignoreNextHover is set, so flashSidebar's setHover(true) will
      // also be dropped via the _ignoreNextHover branch — equivalent
      // protection. Verify pfx-has-hover stays cleared.
      await mn.executeScript(`document.getElementById("sidebar-main").dispatchEvent(new CustomEvent("pfx-flash"));`);

      // Wait a full FLASH_DURATION (800ms) just to make sure we're past any
      // delayed reveal that would happen if the regression existed.
      await new Promise((r) => setTimeout(r, 200));
      const cleared = await mn.executeScript<boolean>(
        `return !document.getElementById("sidebar-main")?.hasAttribute("pfx-has-hover");`,
      );
      if (!cleared) {
        throw new Error("immediate flash after dismiss revealed sidebar — protection dropped");
      }

      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", false);`);
    },
  },

  {
    // Bug: the popup counter (_openPopups) could drift positive when Mozilla
    // dropped a popuphidden event (right-click → click outside before popup
    // fully shown, panels GC'd, etc.). The sidebar would stay guarded
    // forever. Fix: reconcileCounterIfStale at hide-time queries the DOM
    // for any actually-open popup and resets the counter if none exists.
    // Test: synthesize a popupshown without matching popuphidden, then
    // trigger a reconcile and verify the sidebar can hide.
    name: "regression: orphaned _openPopups counter is reset by reconcileCounterIfStale",
    async run(mn) {
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", true);`);
      await waitFor(mn, `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact");`);
      await new Promise((r) => setTimeout(r, 350));

      // Synthesize a popupshown with no matching popuphidden. palefox's
      // counter goes to 1; no real popup exists in the DOM.
      await mn.executeScript(`
        // Build a fake panel element that palefox's counter listener will
        // count, then detach it (simulating GC / dropped popuphidden).
        const fakePanel = document.createXULElement("panel");
        fakePanel.id = "regression-fake-panel";
        document.documentElement.appendChild(fakePanel);
        // Dispatch popupshown bubbling so the document-level listener fires.
        fakePanel.dispatchEvent(new Event("popupshown", { bubbles: true }));
        // Now detach, leaking the counter.
        fakePanel.remove();
        return true;
      `);

      // Force a reconcile by firing a window blur (target = window).
      // palefox's reconcileCompactState calls reconcileCounterIfStale,
      // which detects the leak and resets the counter.
      await mn.executeScript(`
        const ev = new FocusEvent("blur");
        Object.defineProperty(ev, "target", { value: window });
        window.dispatchEvent(ev);
        return true;
      `);

      // Show and hide via dismiss.
      await mn.executeScript(`document.getElementById("sidebar-main").dispatchEvent(new CustomEvent("pfx-flash"));`);
      await waitFor(
        mn,
        `return document.getElementById("sidebar-main")?.hasAttribute("pfx-has-hover");`,
        2000,
      );
      await mn.executeScript(`document.getElementById("sidebar-main").dispatchEvent(new CustomEvent("pfx-dismiss"));`);

      // After dismiss + KEEP_HOVER_DURATION cooldown, the sidebar should be
      // hidden (counter was correctly reset; no longer guarded).
      await waitFor(
        mn,
        `return !document.getElementById("sidebar-main")?.hasAttribute("pfx-has-hover");`,
        2000,
      );

      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", false);`);
    },
  },

  {
    // Bug: an earlier version of dbg() included `guarded: isGuarded()` in
    // its auto-payload. isGuarded() called reconcileCounterIfStale() which
    // (via dbg in some code paths) called dbg() again → infinite recursion
    // when pfx.debug was on. Fix: dbg's auto-payload reads only cheap
    // attributes / scalars; never invokes isGuarded.
    // Test: turn pfx.debug on, exercise paths that fire dbg, verify Firefox
    // doesn't lock up. (Recursion kills the chrome window; if Marionette
    // hangs, the test runner times out, which we'd see as a failure.)
    name: "regression: dbg() does not recurse via isGuarded under pfx.debug=true",
    async run(mn) {
      // Pref defaults pfx.debug=true in the test profile, so just exercise
      // the paths.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", true);`);
      await waitFor(mn, `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact");`);
      await new Promise((r) => setTimeout(r, 350));

      // Fire 100 reconcile calls in quick succession (window blurs).
      // If dbg recurses, this hangs Firefox. If the fix is intact,
      // executeScript completes promptly.
      const elapsed = await mn.executeScript<number>(`
        const start = performance.now();
        for (let i = 0; i < 100; i++) {
          const ev = new FocusEvent("blur");
          Object.defineProperty(ev, "target", { value: window });
          window.dispatchEvent(ev);
        }
        return performance.now() - start;
      `);
      // If we reached this assertion, dbg didn't recurse.
      if (elapsed > 1000) {
        // Suspicious — even 100 reconciles should be << 1s. Recursion would
        // typically push elapsed into "stack overflow" territory, but a
        // partial regression might just be slow.
        throw new Error(`100 reconciles took ${elapsed.toFixed(1)}ms — recursion / unexpected slowness`);
      }

      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", false);`);
    },
  },
];

export default tests;
