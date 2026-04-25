// Integration test runner.
//
// Spawns Firefox in headless+marionette mode against an ephemeral profile
// pre-populated with palefox, then drives the privileged JS scope via
// Marionette to run integration test bodies. Produces structured pass/fail
// output that's easy for an AI agent (or CI) to consume.
//
// Test shape:
//   tests/integration/<name>.ts exports `default` an array of test objects:
//     export default [
//       { name: "compact toggle", run: async (mn) => { ... } },
//       ...
//     ];
//   Each `run` receives a connected, chrome-context Marionette client and
//   may throw to fail. Throw any Error subclass; its message becomes the
//   failure reason in the result JSON.
//
// Output format (stdout):
//   {"type": "test:start", "name": "...", "file": "..."}
//   {"type": "test:pass",  "name": "...", "file": "...", "durationMs": 123}
//   {"type": "test:fail",  "name": "...", "file": "...", "durationMs": 12,
//    "error": "..."}
//   {"type": "summary", "pass": N, "fail": M, "durationMs": ...}
//
// Final exit code: 0 on full pass, 1 on any failure / spawn error.

import { spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { connectMarionette, type MarionetteClient } from "./marionette.ts";
import { createProfile, type TestProfile } from "./profile.ts";

export interface IntegrationTest {
  /** Human-readable test name. Should be unique within a file. */
  name: string;
  /** Function that drives the connected client. Throws to fail. */
  run(mn: MarionetteClient): Promise<void>;
}

export interface RunnerOptions {
  /** Path to the Firefox binary. Default: $FIREFOX_BIN or `firefox`. */
  firefoxBin?: string;
  /** Glob-ish directory of integration test files. Default: tests/integration. */
  testDir?: string;
  /** Marionette port. Default: 2828 (and matches user.js). */
  marionettePort?: number;
  /** Print verbose diagnostics to stderr. */
  verbose?: boolean;
}

interface JsonEvent {
  type: "test:start" | "test:pass" | "test:fail" | "summary" | "log";
  [k: string]: unknown;
}

function emit(ev: JsonEvent): void {
  process.stdout.write(JSON.stringify(ev) + "\n");
}

function logErr(line: string): void {
  process.stderr.write(`[runner] ${line}\n`);
}

/** Load all `tests/integration/*.{ts,js,mjs}` files and concatenate the
 *  default-exported test arrays. */
async function loadTests(testDir: string): Promise<{ file: string; tests: IntegrationTest[] }[]> {
  let entries: string[];
  try {
    entries = await readdir(testDir);
  } catch (e) {
    throw new Error(`could not read ${testDir}: ${(e as Error).message}`);
  }
  const files = entries.filter(f => /\.(ts|tsx|mjs|js)$/.test(f) && !f.endsWith(".d.ts"));
  const out: { file: string; tests: IntegrationTest[] }[] = [];
  for (const f of files) {
    const path = join(testDir, f);
    const mod = await import(path);
    const tests = (mod.default ?? []) as IntegrationTest[];
    if (!Array.isArray(tests)) {
      logErr(`skipping ${f} — default export is not an array`);
      continue;
    }
    out.push({ file: basename(f), tests });
  }
  return out;
}

async function spawnFirefox(opts: {
  firefoxBin: string;
  profilePath: string;
  marionettePort: number;
  verbose?: boolean;
}): Promise<ChildProcess> {
  // --remote-allow-system-access is required for privileged ("chrome")
  // context script eval — landed in Firefox 128+ as a safety gate. Without
  // it, executeScript fails with "System access is required."
  const args = [
    "--profile", opts.profilePath,
    "--marionette",
    "--headless",
    "--no-remote",
    "--remote-allow-system-access",
    `-marionette-port`, String(opts.marionettePort),
  ];
  const child = spawn(opts.firefoxBin, args, {
    stdio: opts.verbose ? "inherit" : "pipe",
    env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: "1" },
  });
  if (!opts.verbose) {
    // Drain pipes so Firefox doesn't block on a full buffer.
    child.stdout?.resume();
    child.stderr?.resume();
  }
  child.once("error", (e) => logErr(`firefox spawn error: ${e.message}`));
  return child;
}

export async function runAll(opts: RunnerOptions = {}): Promise<{ pass: number; fail: number }> {
  const firefoxBin = opts.firefoxBin ?? process.env.FIREFOX_BIN ?? "firefox";
  const testDir = opts.testDir ?? join(process.cwd(), "tests/integration");
  const marionettePort = opts.marionettePort ?? 2828;

  const suites = await loadTests(testDir);
  const totalCount = suites.reduce((n, s) => n + s.tests.length, 0);
  if (totalCount === 0) {
    emit({ type: "summary", pass: 0, fail: 0, durationMs: 0, note: "no tests found" });
    return { pass: 0, fail: 0 };
  }

  let profile: TestProfile | null = null;
  let firefox: ChildProcess | null = null;
  let mn: MarionetteClient | null = null;
  let pass = 0;
  let fail = 0;
  const start = Date.now();

  try {
    profile = await createProfile();
    if (opts.verbose) logErr(`profile: ${profile.path}`);
    firefox = await spawnFirefox({ firefoxBin, profilePath: profile.path, marionettePort, verbose: opts.verbose });

    mn = await connectMarionette({ port: marionettePort });
    await mn.newSession();
    await mn.setContext("chrome");

    for (const suite of suites) {
      for (const t of suite.tests) {
        const file = suite.file;
        emit({ type: "test:start", name: t.name, file });
        const tStart = Date.now();
        try {
          await t.run(mn);
          emit({ type: "test:pass", name: t.name, file, durationMs: Date.now() - tStart });
          pass++;
        } catch (e) {
          emit({
            type: "test:fail", name: t.name, file,
            durationMs: Date.now() - tStart,
            error: (e as Error).message ?? String(e),
            stack: (e as Error).stack,
          });
          fail++;
        }
      }
    }
  } catch (e) {
    logErr(`runner failure: ${(e as Error).message}`);
    fail++; // count the runner crash itself as a failure for exit-code purposes
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
    if (profile) {
      try { await profile.cleanup(); } catch {}
    }
  }

  emit({ type: "summary", pass, fail, durationMs: Date.now() - start });
  return { pass, fail };
}

if (import.meta.main) {
  const verbose = process.argv.includes("--verbose");
  runAll({ verbose })
    .then(({ fail }) => process.exit(fail > 0 ? 1 : 0))
    .catch((e) => {
      logErr(`fatal: ${(e as Error).stack ?? e}`);
      process.exit(1);
    });
}
