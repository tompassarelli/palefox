#!/usr/bin/env bun
// Firefox upstream stability canary.
//
// Reads the manifest below, diffs each entry's source path between the
// pinned Firefox revision (`tools/firefox-pin.json`) and the current
// HEAD of `~/code/firefox`. Reports which palefox dependencies have
// upstream changes since we last verified, grouped by stability bucket.
//
// Runtime: bun run firefox:canary
//          bun run firefox:canary --pin HEAD          (record current Firefox HEAD as pinned)
//          bun run firefox:canary --firefox <path>    (override Firefox checkout location)
//
// See docs/dev/firefox-upstream-stability.md for the strategy this is part of.

import { readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// =============================================================================
// MANIFEST
// =============================================================================
//
// Each entry pins palefox's expectation against a specific spot in Firefox
// source. Add an entry whenever palefox starts depending on a new Firefox
// internal — or remove one when the dependency goes away.
//
// `stability` drives canary verbosity:
//   - rock         decade+ unchanged. Surfaced only if the source file
//                  literally moved or the symbols vanished.
//   - stable       a few years stable. Surfaced quietly when changed.
//   - moving       active development. Surfaced loudly when changed.
//   - experimental new in the last year, or actively being reorganized.
//                  Surfaced on every change, however minor.

type Stability = "rock" | "stable" | "moving" | "experimental";

type ManifestEntry = {
  name: string;
  stability: Stability;
  sourcePath: string;
  symbols: readonly string[];
  palefoxOwner: string;
  tests: readonly string[];
  expects: string;
  failureMode: string;
};

const MANIFEST: readonly ManifestEntry[] = [
  // --- rock-stable: prefs / observers / fast IO -----------------------------
  {
    name: "Services.prefs",
    stability: "rock",
    sourcePath: "modules/libpref/init/all.js",
    symbols: ["nsIPrefBranch", "getBoolPref", "setBoolPref", "addObserver", "removeObserver"],
    palefoxOwner: "src/tabs/vim.ts (and others)",
    tests: ["tests/integration/global-keys.ts"],
    expects: "Pref get/set is synchronous; addObserver fires on change with the pref name as data.",
    failureMode: "Per-key enable/disable toggles stop reacting; blacklist stops applying.",
  },
  {
    name: "Services.obs",
    stability: "rock",
    sourcePath: "xpcom/ds/nsObserverService.cpp",
    symbols: ["addObserver", "removeObserver", "notifyObservers"],
    palefoxOwner: "src/tabs/index.ts (quit-application listener)",
    tests: [],
    expects: "Topic-based pubsub; quit-application fires with weak=false on profile teardown.",
    failureMode: "Session retention pass doesn't run on shutdown.",
  },
  {
    name: "IOUtils + PathUtils",
    stability: "rock",
    sourcePath: "dom/system/IOUtils.cpp",
    symbols: ["write", "read", "stat"],
    palefoxOwner: "src/tabs/history.ts",
    tests: ["tests/integration/history-events.ts"],
    expects: "Promise-based async file IO. Encoding defaults to utf-8 for text writes.",
    failureMode: "SQLite path resolution or fallback writes break.",
  },

  // --- rock-stable: tab operations ------------------------------------------
  {
    name: "gBrowser tab ops",
    stability: "rock",
    sourcePath: "browser/components/tabbrowser/content/tabbrowser.js",
    symbols: ["pinTab", "unpinTab", "removeTab", "duplicateTab", "reloadTab", "moveTabTo", "addTab", "tabs", "selectedTab", "selectedBrowser", "tabContainer"],
    palefoxOwner: "src/tabs/vim.ts, src/tabs/rows.ts",
    tests: ["tests/integration/tabs-picker.ts", "tests/integration/global-keys.ts"],
    expects: "Synchronous mutations on the tab strip; events (TabOpen/TabClose/TabMove/TabSelect) fire on tabContainer.",
    failureMode: "Pin/unpin/close/duplicate keys are no-ops; tree resync drifts.",
  },
  {
    name: "tab.linkedBrowser.currentURI",
    stability: "rock",
    sourcePath: "browser/components/tabbrowser/content/tab.js",
    symbols: ["linkedBrowser", "currentURI"],
    palefoxOwner: "src/tabs/helpers.ts (tabUrl)",
    tests: ["tests/integration/history-events.ts"],
    expects: "currentURI.spec returns the current document URL; nsIURI interface stable.",
    failureMode: "Tab URL persistence and restore-pairing break (Class F).",
  },

  // --- rock-stable: XUL DOM construction ------------------------------------
  {
    name: "createXULElement",
    stability: "rock",
    sourcePath: "dom/xul/XULDocument.cpp",
    symbols: ["createXULElement"],
    palefoxOwner: "src/tabs/rows.ts, src/drawer/index.ts (legacy)",
    tests: ["tests/integration/groups.ts"],
    expects: "Document method; hbox/vbox/box/label/menupopup/menuitem/menuseparator are first-class XUL tags.",
    failureMode: "Row construction throws; no UI renders.",
  },

  // --- stable: ChromeUtils / ESM loader -------------------------------------
  {
    name: "ChromeUtils.importESModule",
    stability: "stable",
    sourcePath: "js/xpconnect/loader/mozJSModuleLoader.cpp",
    symbols: ["importESModule"],
    palefoxOwner: "src/tabs/history.ts (Sqlite.sys.mjs)",
    tests: ["tests/integration/history-events.ts"],
    expects: "Synchronous import of a system module by chrome:// or resource:// URL.",
    failureMode: "SQLite open fails on startup; history substrate dies.",
  },

  // --- stable: SessionStore -------------------------------------------------
  {
    name: "SessionStore.getTabState",
    stability: "stable",
    sourcePath: "browser/components/sessionstore/SessionStore.sys.mjs",
    symbols: ["getTabState"],
    palefoxOwner: "src/tabs/helpers.ts (tabUrl fallback for lazy tabs)",
    tests: ["tests/integration/restore-tree.ts"],
    expects: "Returns serialized JSON string with at least .entries[].url for navigated tabs; may be sparse for lazy tabs.",
    failureMode: "Lazy-tab URL recovery returns wrong URL → restore-pairing mismatches (Class F).",
  },
  {
    name: "SessionStore custom-value APIs",
    stability: "stable",
    sourcePath: "browser/components/sessionstore/SessionStore.sys.mjs",
    symbols: ["persistTabAttribute", "setCustomTabValue", "getCustomTabValue", "setCustomGlobalValue"],
    palefoxOwner: "src/tabs/index.ts, src/tabs/history.ts",
    tests: ["tests/integration/restore-tree.ts"],
    expects: "Per-tab key/value persistence survives session restore; persistTabAttribute round-trips DOM attributes through serialized state.",
    failureMode: "Tree IDs lost on restart; restored tabs come back without their pfx-id.",
  },

  // --- stable: urlbar focus -------------------------------------------------
  {
    name: "gURLBar.focus / select",
    stability: "stable",
    sourcePath: "browser/components/urlbar/UrlbarInput.sys.mjs",
    symbols: ["focus", "select"],
    palefoxOwner: "src/drawer/urlbar.ts",
    tests: ["tests/integration/global-keys.ts"],
    expects: "focus() moves keyboard focus into the urlbar input; select() selects the input value.",
    failureMode: "Floating urlbar activation no-ops on Ctrl+L / o / O.",
  },

  // --- stable: well-known XUL IDs -------------------------------------------
  {
    name: "Well-known chrome IDs",
    stability: "stable",
    sourcePath: "browser/base/content/browser.xhtml",
    symbols: ["sidebar-main", "navigator-toolbox", "urlbar", "nav-bar", "urlbar-container", "tabbrowser-tabs", "TabsToolbar", "mainPopupSet", "unified-extensions-button"],
    palefoxOwner: "src/drawer/index.ts",
    tests: ["tests/integration/compact.ts"],
    expects: "Element IDs present and parented as documented; hierarchy stable across sidebar-revamp era.",
    failureMode: "Drawer expand/collapse no-ops; compact mode fails to attach.",
  },

  // --- moving: UrlbarView ---------------------------------------------------
  {
    name: "gURLBar.view.selectBy",
    stability: "moving",
    sourcePath: "browser/components/urlbar/UrlbarView.sys.mjs",
    symbols: ["selectBy"],
    palefoxOwner: "src/drawer/urlbar.ts (Ctrl+J/K nav)",
    tests: ["tests/integration/global-keys.ts"],
    expects: "selectBy(±n) moves the selection within an open dropdown by n results, wrapping at boundaries.",
    failureMode: "Ctrl+J/K stops navigating suggestions; user falls back to ArrowUp/ArrowDown.",
  },

  // --- moving: urlbar popover lifecycle -------------------------------------
  {
    name: "Urlbar popover attribute / showPopover / hidePopover",
    stability: "moving",
    sourcePath: "browser/components/urlbar/UrlbarInput.sys.mjs",
    symbols: ["popover", "showPopover", "hidePopover", "breakout-extend"],
    palefoxOwner: "src/drawer/urlbar.ts, src/drawer/compact.ts",
    tests: ["tests/integration/global-keys.ts"],
    expects: "popover='manual' + showPopover() puts the urlbar in the top layer (immune to ancestor transforms); breakout-extend attribute toggled on focus.",
    failureMode: "Class C/D — floating urlbar stuck visible after Enter, or sidebar flashes spuriously on breakout-close (the v0.40.0 horizontal-mode regression).",
  },

  // --- moving: messageManager / loadFrameScript -----------------------------
  {
    name: "messageManager.loadFrameScript",
    stability: "moving",
    sourcePath: "dom/base/MessageManagerGlobal.cpp",
    symbols: ["loadFrameScript", "addMessageListener", "sendAsyncMessage"],
    palefoxOwner: "src/tabs/content-focus.ts",
    tests: ["tests/integration/content-focus.ts"],
    expects: "loadFrameScript(dataUrl, /*allowDelayedLoad*/ true) injects a script into every existing AND future content frame loader; sendAsyncMessage round-trips structured-cloned data.",
    failureMode: "Cross-process focus bridge breaks; o/x stops respecting content input focus. Note: deprecated in favor of JSWindowActor; ETA on removal unknown.",
  },

  // --- moving: SQLite chrome module -----------------------------------------
  {
    name: "Sqlite.sys.mjs",
    stability: "moving",
    sourcePath: "toolkit/modules/Sqlite.sys.mjs",
    symbols: ["openConnection"],
    palefoxOwner: "src/tabs/history.ts",
    tests: ["tests/integration/history-events.ts"],
    expects: "openConnection({ path }) returns a connection with executeStatement / executeTransaction / close; comment-LIKE check rejects schema with bare LIKE in comments.",
    failureMode: "History substrate fails on init; :checkpoint / :restore / :sessions / :history all error.",
  },

  // --- experimental: split view --------------------------------------------
  {
    name: "TabContextMenu split-view APIs",
    stability: "experimental",
    sourcePath: "browser/base/content/tabbrowser-tabs.js",
    symbols: ["moveTabsToSplitView", "contextTab", "contextTabs"],
    palefoxOwner: "src/tabs/menu.ts",
    tests: [],
    expects: "Split view exposes moveTabsToSplitView(); contextTab / contextTabs settable to redirect native context-menu actions.",
    failureMode: "Context-menu split-view item missing or breaks. UX regression but not blocking.",
  },

  // --- experimental: FirefoxView ------------------------------------------
  {
    name: "FirefoxViewHandler.tab",
    stability: "experimental",
    sourcePath: "browser/base/content/browser-firefoxView.js",
    symbols: ["tab"],
    palefoxOwner: "src/tabs/types.ts (Tab.isOpen check)",
    tests: [],
    expects: "FirefoxViewHandler.tab returns the singleton 'Firefox View' tab if open, or null. Used to exclude it from palefox tree.",
    failureMode: "Firefox View tab appears in palefox tree as a regular tab.",
  },

  // --- rock-stable: hash-pinned bootstrap primitives -----------------------
  // These XPCOM interfaces are used by program/config.template.js to verify
  // SHA-256 of every chrome/{utils,JS,CSS}/ file at startup. They've been
  // stable since Firefox 1.x and are unlikely to move, but the bootstrap is
  // load-bearing for our security model — track them here so any future
  // upstream rename surfaces immediately.
  {
    name: "nsICryptoHash",
    stability: "rock",
    sourcePath: "security/manager/ssl/nsICryptoHash.idl",
    symbols: ["init", "updateFromStream", "finish", "SHA256"],
    palefoxOwner: "program/config.template.js (hash-pinned bootstrap)",
    tests: [],
    expects: "Synchronous SHA-256 of an nsIInputStream; finish(true) returns base64.",
    failureMode: "Bootstrap throws on every file → palefox refuses to load entirely.",
  },
  {
    name: "nsIFileInputStream",
    stability: "rock",
    sourcePath: "netwerk/base/nsIFileInputStream.idl",
    symbols: ["init"],
    palefoxOwner: "program/config.template.js",
    tests: [],
    expects: "Sync read from nsIFile via @mozilla.org/network/file-input-stream;1.",
    failureMode: "Bootstrap can't read chrome/ files → palefox refuses to load.",
  },
  {
    name: "nsIComponentRegistrar.autoRegister",
    stability: "rock",
    sourcePath: "xpcom/components/nsIComponentRegistrar.idl",
    symbols: ["autoRegister"],
    palefoxOwner: "program/config.template.js, chrome/utils/boot.sys.mjs (chained)",
    tests: [],
    expects: "Registers a chrome.manifest from a profile-relative nsIFile path.",
    failureMode: "chrome:// URIs don't resolve → fx-autoconfig loader can't find boot.sys.mjs → palefox doesn't load.",
  },
];

// =============================================================================
// CANARY
// =============================================================================

type PinFile = {
  firefoxRevision: string;
  firefoxVersion: string;
  verifiedAt: string;
  verifiedBy?: string;
};

type EntryStatus = {
  entry: ManifestEntry;
  changed: boolean;
  commits: Array<{ sha: string; subject: string }>;
};

const REPO_ROOT = resolve(import.meta.dir, "..");
const PIN_PATH = join(REPO_ROOT, "tools", "firefox-pin.json");

function parseArgs(argv: string[]): { pin?: string; firefox: string } {
  const args = { firefox: process.env.FIREFOX_SOURCE ?? `${process.env.HOME}/code/firefox` } as { pin?: string; firefox: string };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pin") args.pin = argv[++i] ?? "HEAD";
    else if (a === "--firefox") args.firefox = argv[++i] ?? args.firefox;
  }
  return args;
}

async function readPin(): Promise<PinFile | null> {
  try {
    await access(PIN_PATH);
    return JSON.parse(await readFile(PIN_PATH, "utf-8")) as PinFile;
  } catch {
    return null;
  }
}

function gitInDir(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

function commitsTouching(firefoxDir: string, fromSha: string, toSha: string, path: string): Array<{ sha: string; subject: string }> {
  if (fromSha === toSha) return [];
  let out: string;
  try {
    out = gitInDir(firefoxDir, ["log", `${fromSha}..${toSha}`, "--pretty=format:%H\t%s", "--", path]);
  } catch (e) {
    // Path may not exist at fromSha (file added later) — treat as full history.
    out = gitInDir(firefoxDir, ["log", toSha, "--pretty=format:%H\t%s", "--", path]);
  }
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [sha, ...rest] = line.split("\t");
    return { sha: (sha ?? "").slice(0, 7), subject: rest.join("\t") };
  });
}

const STABILITY_ORDER: readonly Stability[] = ["experimental", "moving", "stable", "rock"];
const STABILITY_LABEL: Record<Stability, string> = {
  experimental: "EXPERIMENTAL — RE-VERIFY",
  moving: "MOVING — CHECK",
  stable: "STABLE — note",
  rock: "ROCK — unchanged (suppressed when clean)",
};

function report(statuses: EntryStatus[], pin: PinFile, currentSha: string) {
  const shortPin = pin.firefoxRevision.slice(0, 7);
  const shortCur = currentSha.slice(0, 7);
  console.log(`Pinned: ${shortPin} (Firefox ${pin.firefoxVersion}, verified ${pin.verifiedAt})`);
  console.log(`Current: ${shortCur}`);
  console.log("");

  let anyChange = false;
  const affectedTests = new Set<string>();

  for (const stability of STABILITY_ORDER) {
    const inBucket = statuses.filter((s) => s.entry.stability === stability);
    const changed = inBucket.filter((s) => s.changed);

    if (stability === "rock" && changed.length === 0) {
      console.log(`${STABILITY_LABEL[stability]}: ${inBucket.length} entries, all unchanged`);
      continue;
    }
    if (changed.length === 0 && stability === "stable") {
      console.log(`${STABILITY_LABEL[stability]}: ${inBucket.length} entries, all unchanged`);
      continue;
    }

    console.log(`\n${STABILITY_LABEL[stability]}`);
    if (changed.length === 0) {
      console.log(`  (clean — ${inBucket.length} entries unchanged)`);
      continue;
    }
    anyChange = true;
    for (const s of changed) {
      console.log(`  ${s.entry.name}`);
      console.log(`    ${s.entry.sourcePath} (${s.commits.length} commit${s.commits.length === 1 ? "" : "s"})`);
      for (const c of s.commits.slice(0, 5)) {
        console.log(`      ${c.sha} ${c.subject}`);
      }
      if (s.commits.length > 5) {
        console.log(`      …and ${s.commits.length - 5} more`);
      }
      console.log(`    Owner: ${s.entry.palefoxOwner}`);
      console.log(`    Failure mode: ${s.entry.failureMode}`);
      for (const t of s.entry.tests) affectedTests.add(t);
    }
  }

  if (!anyChange) {
    console.log("\nNo upstream changes for any tracked dependency. Safe.");
    return;
  }

  if (affectedTests.size > 0) {
    console.log("\nAffected Tier 3 test files:");
    for (const t of [...affectedTests].sort()) console.log(`  ${t}`);
    const greps = [...affectedTests].map((t) => t.replace(/^tests\/integration\//, "").replace(/\.ts$/, "")).join("|");
    console.log(`\nRun: bun run test:integration -- --grep "${greps}"`);
  }
}

async function pinHead(firefoxDir: string, label: string) {
  const sha = gitInDir(firefoxDir, ["rev-parse", label]);
  const versionFile = await readFile(join(firefoxDir, "browser", "config", "version.txt"), "utf-8").catch(() => "unknown\n");
  const version = versionFile.trim();
  const today = new Date().toISOString().slice(0, 10);
  const data: PinFile = {
    firefoxRevision: sha,
    firefoxVersion: version,
    verifiedAt: today,
    verifiedBy: process.env.USER ?? "unknown",
  };
  await writeFile(PIN_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(`Pinned ${PIN_PATH}:`);
  console.log(`  revision: ${sha.slice(0, 7)} (full SHA written)`);
  console.log(`  version:  ${version}`);
  console.log(`  date:     ${today}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const firefoxDir = args.firefox;

  try {
    await access(join(firefoxDir, ".git"));
  } catch {
    console.error(`error: ${firefoxDir} is not a git repo. Set FIREFOX_SOURCE or pass --firefox <path>.`);
    process.exit(2);
  }

  if (args.pin) {
    await pinHead(firefoxDir, args.pin);
    return;
  }

  const pin = await readPin();
  if (!pin) {
    console.error(`error: no pin file at ${PIN_PATH}.`);
    console.error(`  bootstrap with: bun run firefox:canary --pin HEAD`);
    process.exit(2);
  }

  const currentSha = gitInDir(firefoxDir, ["rev-parse", "HEAD"]);
  const statuses: EntryStatus[] = [];
  for (const entry of MANIFEST) {
    const commits = commitsTouching(firefoxDir, pin.firefoxRevision, currentSha, entry.sourcePath);
    statuses.push({ entry, changed: commits.length > 0, commits });
  }

  report(statuses, pin, currentSha);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
