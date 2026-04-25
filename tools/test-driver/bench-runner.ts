// Performance benchmark runner.
//
// Same harness as runner.ts (ephemeral profile, headless Firefox, Marionette
// chrome scope) but oriented around timing measurements. Each benchmark
// runs N iterations, reports min/median/max/mean. Output is structured
// JSON so a regression detector (or human eyeball) can spot drift.
//
// Output format (one event per line on stdout):
//   {"type": "bench:start", "name": "...", "iterations": N}
//   {"type": "bench:result", "name": "...", "iterations": N,
//    "min": ms, "median": ms, "max": ms, "mean": ms, "samples": [...]}
//   {"type": "summary", "totalMs": ..., "benches": N}
//
// Run: bun run tools/test-driver/bench-runner.ts
//      bun run bench:integration
//
// Each benchmark file lives in tests/bench/<name>.ts and exports a default
// array of { name, iterations, run(mn) → number }, where `run` returns the
// elapsed time in milliseconds (the bench itself decides what to measure).

import { spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { connectMarionette, type MarionetteClient } from "./marionette.ts";
import { createProfile, type TestProfile } from "./profile.ts";

export interface Benchmark {
  /** Human-readable name; should be unique within a file. */
  name: string;
  /** Number of iterations to time. Higher → tighter percentiles, longer run. */
  iterations: number;
  /** Single iteration. Returns elapsed milliseconds. The benchmark decides
   *  what counts (e.g., a save-event cycle or a full pref-flip + observer
   *  cascade). */
  run(mn: MarionetteClient): Promise<number>;
}

export interface BenchOptions {
  firefoxBin?: string;
  benchDir?: string;
  marionettePort?: number;
  verbose?: boolean;
}

interface JsonEvent { type: string; [k: string]: unknown }
function emit(ev: JsonEvent): void { process.stdout.write(JSON.stringify(ev) + "\n"); }
function logErr(line: string): void { process.stderr.write(`[bench] ${line}\n`); }

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function loadBenches(dir: string): Promise<{ file: string; benches: Benchmark[] }[]> {
  let entries: string[];
  try { entries = await readdir(dir); }
  catch { return []; }
  const files = entries.filter(f => /\.(ts|tsx|mjs|js)$/.test(f) && !f.endsWith(".d.ts"));
  const out: { file: string; benches: Benchmark[] }[] = [];
  for (const f of files) {
    const mod = await import(join(dir, f));
    const benches = (mod.default ?? []) as Benchmark[];
    if (Array.isArray(benches)) out.push({ file: basename(f), benches });
  }
  return out;
}

async function spawnFirefox(opts: {
  firefoxBin: string;
  profilePath: string;
  marionettePort: number;
  verbose?: boolean;
}): Promise<ChildProcess> {
  const child = spawn(opts.firefoxBin, [
    "--profile", opts.profilePath,
    "--marionette",
    "--headless",
    "--no-remote",
    "--remote-allow-system-access",
    "-marionette-port", String(opts.marionettePort),
  ], {
    stdio: opts.verbose ? "inherit" : "pipe",
    env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: "1" },
  });
  if (!opts.verbose) {
    child.stdout?.resume();
    child.stderr?.resume();
  }
  return child;
}

export async function runBenches(opts: BenchOptions = {}): Promise<void> {
  const firefoxBin = opts.firefoxBin ?? process.env.FIREFOX_BIN ?? "firefox";
  const benchDir = opts.benchDir ?? join(process.cwd(), "tests/bench");
  const marionettePort = opts.marionettePort ?? 2828;

  const suites = await loadBenches(benchDir);
  const total = suites.reduce((n, s) => n + s.benches.length, 0);
  if (total === 0) {
    emit({ type: "summary", totalMs: 0, benches: 0, note: "no benchmarks found" });
    return;
  }

  let profile: TestProfile | null = null;
  let firefox: ChildProcess | null = null;
  let mn: MarionetteClient | null = null;
  const start = Date.now();

  try {
    profile = await createProfile();
    firefox = await spawnFirefox({ firefoxBin, profilePath: profile.path, marionettePort, verbose: opts.verbose });
    mn = await connectMarionette({ port: marionettePort });
    await mn.newSession();
    await mn.setContext("chrome");

    for (const suite of suites) {
      for (const b of suite.benches) {
        emit({ type: "bench:start", name: b.name, iterations: b.iterations, file: suite.file });
        const samples: number[] = [];
        for (let i = 0; i < b.iterations; i++) {
          try {
            samples.push(await b.run(mn));
          } catch (e) {
            emit({
              type: "bench:fail", name: b.name, file: suite.file,
              iteration: i,
              error: (e as Error).message ?? String(e),
              stack: (e as Error).stack,
            });
            break;
          }
        }
        if (samples.length === b.iterations) {
          emit({
            type: "bench:result", name: b.name, file: suite.file,
            iterations: samples.length,
            min: Math.min(...samples),
            median: median(samples),
            max: Math.max(...samples),
            mean: samples.reduce((a, b) => a + b, 0) / samples.length,
            samples,
          });
        }
      }
    }
  } catch (e) {
    logErr(`bench runner error: ${(e as Error).stack ?? e}`);
  } finally {
    if (mn) {
      try { await mn.deleteSession(); } catch {}
      mn.disconnect();
    }
    if (firefox && !firefox.killed) {
      firefox.kill("SIGTERM");
      await new Promise<void>((r) => {
        const t = setTimeout(() => { try { firefox!.kill("SIGKILL"); } catch {} r(); }, 3000);
        firefox!.once("exit", () => { clearTimeout(t); r(); });
      });
    }
    if (profile) try { await profile.cleanup(); } catch {}
  }

  emit({ type: "summary", totalMs: Date.now() - start, benches: total });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  runBenches({ verbose })
    .then(() => process.exit(0))
    .catch((e) => { logErr(`fatal: ${(e as Error).stack ?? e}`); process.exit(1); });
}
