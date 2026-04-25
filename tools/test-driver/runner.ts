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

/** Throw a `SkipError` from a test body to mark the run as skipped (vs failed).
 *  The runner emits a `test:skip` event with the reason. Skipped tests don't
 *  contribute to the fail count and don't affect exit code. */
export class SkipError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SkipError";
  }
}

export interface TestContext {
  /** Path to the ephemeral profile directory. Stable across restarts within
   *  one test run; auto-cleaned at the end. */
  readonly profilePath: string;
  /** True iff the runner is launching Firefox without --headless. Tests that
   *  need toolbar UI / real hover should call `ctx.skip(reason)` to skip
   *  with a clear message rather than failing silently. */
  readonly headed: boolean;
  /** Throw a SkipError to mark the test as skipped. Convenience for the
   *  common headed-only / setup-required pattern. */
  skip(reason: string): never;
  /** Kill Firefox, respawn with the SAME profile, reconnect Marionette, set
   *  chrome context. Returns the new client; the prior client is dead.
   *
   *  Use for state-persistence tests (tree round-trip across session
   *  restore). The profile's `chrome/` directory and any palefox-written
   *  files (palefox-tab-tree.json, palefox-debug.log) survive the restart. */
  restartFirefox(): Promise<MarionetteClient>;
}

export interface IntegrationTest {
  /** Human-readable test name. Should be unique within a file. */
  name: string;
  /** Function that drives the connected client. Throws to fail. */
  run(mn: MarionetteClient, ctx: TestContext): Promise<void>;
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
  /** Substring filter on test names; non-matches are skipped. Useful for
   *  fast iteration on a single test. Case-insensitive. */
  grep?: string;
  /** Drop --headless from spawn args. Necessary for tests that depend on
   *  toolbar UI (#sidebar-button etc.) or real input events / hover state. */
  headed?: boolean;
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
  headed?: boolean;
}): Promise<ChildProcess> {
  // --remote-allow-system-access is required for privileged ("chrome")
  // context script eval — landed in Firefox 128+ as a safety gate. Without
  // it, executeScript fails with "System access is required."
  const args = [
    "--profile", opts.profilePath,
    "--marionette",
    ...(opts.headed ? [] : ["--headless"]),
    "--no-remote",
    "--remote-allow-system-access",
    `-marionette-port`, String(opts.marionettePort),
  ];
  // We don't disable the sandbox — earlier code did via
  // MOZ_DISABLE_CONTENT_SANDBOX=1, which surfaced a "your configuration
  // is unsupported and less secure" infobar in headed mode and didn't
  // actually buy us anything for chrome-context tests.
  const child = spawn(opts.firefoxBin, args, {
    stdio: opts.verbose ? "inherit" : "pipe",
    env: { ...process.env },
  });
  if (!opts.verbose) {
    // Drain pipes so Firefox doesn't block on a full buffer.
    child.stdout?.resume();
    child.stderr?.resume();
  }
  child.once("error", (e) => logErr(`firefox spawn error: ${e.message}`));
  return child;
}

export async function runAll(opts: RunnerOptions = {}): Promise<{ pass: number; fail: number; skip: number }> {
  const firefoxBin = opts.firefoxBin ?? process.env.FIREFOX_BIN ?? "firefox";
  const testDir = opts.testDir ?? join(process.cwd(), "tests/integration");
  const marionettePort = opts.marionettePort ?? 2828;

  if (opts.headed) {
    logErr("WARNING: --headed mode will pop a real Firefox window on your");
    logErr("WARNING: display. For unattended runs, drop --headed.");
  }

  const suites = await loadTests(testDir);
  // Apply --grep filter. We filter at the suite level so empty suites get
  // dropped entirely rather than emitting a misleading "test:start"-then-
  // -nothing pattern.
  if (opts.grep) {
    const needle = opts.grep.toLowerCase();
    for (const s of suites) {
      s.tests = s.tests.filter((t) => t.name.toLowerCase().includes(needle));
    }
  }
  const totalCount = suites.reduce((n, s) => n + s.tests.length, 0);
  if (totalCount === 0) {
    emit({
      type: "summary", pass: 0, fail: 0, skip: 0, durationMs: 0,
      note: opts.grep ? `no tests match --grep "${opts.grep}"` : "no tests found",
    });
    return { pass: 0, fail: 0, skip: 0 };
  }

  let profile: TestProfile | null = null;
  let firefox: ChildProcess | null = null;
  let mn: MarionetteClient | null = null;
  let pass = 0;
  let fail = 0;
  let skip = 0;
  const start = Date.now();

  async function killFirefox(): Promise<void> {
    if (!firefox || firefox.killed) return;
    firefox.kill("SIGTERM");
    await new Promise<void>((r) => {
      const timer = setTimeout(() => {
        try { firefox!.kill("SIGKILL"); } catch {}
        r();
      }, 3000);
      firefox!.once("exit", () => { clearTimeout(timer); r(); });
    });
  }

  async function bootFirefox(profilePath: string): Promise<MarionetteClient> {
    firefox = await spawnFirefox({
      firefoxBin, profilePath, marionettePort,
      verbose: opts.verbose, headed: opts.headed,
    });
    const client = await connectMarionette({ port: marionettePort });
    await client.newSession();
    await client.setContext("chrome");
    return client;
  }

  try {
    profile = await createProfile();
    if (opts.verbose) logErr(`profile: ${profile.path}`);
    mn = await bootFirefox(profile.path);

    for (const suite of suites) {
      for (const t of suite.tests) {
        const file = suite.file;
        emit({ type: "test:start", name: t.name, file });
        const tStart = Date.now();
        const ctx: TestContext = {
          profilePath: profile.path,
          headed: !!opts.headed,
          skip(reason: string): never {
            throw new SkipError(reason);
          },
          async restartFirefox() {
            // Graceful Firefox shutdown via Marionette:Quit so
            // sessionstore.jsonlz4 gets written. SIGTERM-only restarts
            // skip session save, which breaks tree-reconciliation tests.
            try { await mn!.quit(); } catch {}
            mn!.disconnect();
            await killFirefox(); // belt-and-suspenders if quit didn't fully exit
            mn = await bootFirefox(profile!.path);
            return mn;
          },
        };
        try {
          await t.run(mn, ctx);
          emit({ type: "test:pass", name: t.name, file, durationMs: Date.now() - tStart });
          pass++;
        } catch (e) {
          if (e instanceof SkipError) {
            emit({
              type: "test:skip", name: t.name, file,
              durationMs: Date.now() - tStart,
              reason: e.message,
            });
            skip++;
          } else {
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
    }
  } catch (e) {
    logErr(`runner failure: ${(e as Error).message}`);
    fail++; // count the runner crash itself as a failure for exit-code purposes
  } finally {
    if (mn) {
      try { await mn.deleteSession(); } catch {}
      mn.disconnect();
    }
    await killFirefox();
    if (profile) {
      if (opts.verbose) {
        logErr(`profile preserved at ${profile.path} for inspection`);
      } else {
        try { await profile.cleanup(); } catch {}
      }
    }
  }

  emit({ type: "summary", pass, fail, skip, durationMs: Date.now() - start });
  return { pass, fail, skip };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const headed = args.includes("--headed");
  // --grep <substring> OR --grep=<substring>
  let grep: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--grep" && args[i + 1]) { grep = args[i + 1]; i++; continue; }
    if (args[i]!.startsWith("--grep=")) { grep = args[i]!.slice("--grep=".length); }
  }
  runAll({ verbose, grep, headed })
    .then(({ fail }) => process.exit(fail > 0 ? 1 : 0)) // skips don't fail the run
    .catch((e) => {
      logErr(`fatal: ${(e as Error).stack ?? e}`);
      process.exit(1);
    });
}
