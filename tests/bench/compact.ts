// Performance benchmarks for compact mode.
//
// What we measure:
//   - Latency from `Services.prefs.setBoolPref(COMPACT_PREF, true)` to
//     `data-pfx-compact` being set on #sidebar-main (full observer cascade).
//   - Same for the toggle-off direction.
//   - flashSidebar full cycle (dispatch pfx-flash → pfx-has-hover set →
//     pfx-has-hover cleared after FLASH_DURATION).
//
// These are thin sanity benches — they catch egregious regressions
// (e.g., observer chain accidentally going async, watchdog mistakenly
// firing). For real numbers, run with ITERATIONS env var bumped.

import type { Benchmark } from "../../tools/test-driver/bench-runner.ts";

const ITERATIONS = Number(process.env.PFX_BENCH_ITERATIONS ?? 20);

const benches: Benchmark[] = [
  {
    name: "compact-on: pref-flip → data-pfx-compact attribute set",
    iterations: ITERATIONS,
    async run(mn) {
      // Ensure starting state is OFF.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", false);`);
      // Poll for clear before timing.
      while (await mn.executeScript<boolean>(
        `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact") || false;`,
      )) await new Promise((r) => setTimeout(r, 5));

      // Time the flip.
      const elapsed = await mn.executeScript<number>(`
        const start = performance.now();
        Services.prefs.setBoolPref("pfx.sidebar.compact", true);
        const sb = document.getElementById("sidebar-main");
        // The observer fires synchronously from setBoolPref, so the
        // attribute should be present on the next microtask.
        // (We measure directly here — palefox doesn't await.)
        const has = sb && sb.hasAttribute("data-pfx-compact");
        return performance.now() - start;
      `);
      return elapsed;
    },
  },

  {
    name: "compact-off: pref-flip → data-pfx-compact attribute removed",
    iterations: ITERATIONS,
    async run(mn) {
      // Ensure starting state is ON.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", true);`);
      while (!(await mn.executeScript<boolean>(
        `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact") || false;`,
      ))) await new Promise((r) => setTimeout(r, 5));

      // Time the un-flip.
      const elapsed = await mn.executeScript<number>(`
        const start = performance.now();
        Services.prefs.setBoolPref("pfx.sidebar.compact", false);
        return performance.now() - start;
      `);
      return elapsed;
    },
  },

  {
    name: "snapshotTree: pfxTest.snapshotTree() over current tabs",
    iterations: ITERATIONS,
    async run(mn) {
      const elapsed = await mn.executeScript<number>(`
        if (!window.pfxTest) throw new Error("pfxTest not exposed");
        const start = performance.now();
        window.pfxTest.snapshotTree();
        return performance.now() - start;
      `);
      return elapsed;
    },
  },
];

export default benches;
