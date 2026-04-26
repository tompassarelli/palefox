// Generate program/config.generated.js — the hash-pinned palefox bootstrap.
//
// Reads program/config.template.js, computes SHA-256 of every file in
// chrome/utils/, chrome/JS/, chrome/CSS/ that the bootstrap will hash-check
// at runtime, and substitutes the __PALEFOX_PINNED__ placeholder with the
// resulting JSON literal.
//
// Run via build.ts (after the .uc.js bundling step) so the generated file
// always reflects the current chrome/ contents. Output is gitignored —
// install.sh and nix/module.nix consume program/config.generated.js
// directly.

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";

const TEMPLATE = "program/config.template.js";
const OUTPUT = "program/config.generated.js";

// Mirror of WATCHED in program/config.template.js — keep in sync.
const WATCHED: Array<{ subdir: string; pattern: RegExp }> = [
  { subdir: "chrome/utils", pattern: /./ },
  { subdir: "chrome/JS", pattern: /^[A-Za-z0-9].*\.(uc\.js|uc\.mjs|sys\.mjs)$/i },
  { subdir: "chrome/CSS", pattern: /^[A-Za-z0-9].*\.uc\.css$/i },
];

async function listFiles(dir: string, pattern: RegExp): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const s = await stat(path);
    if (s.isFile() && pattern.test(entry)) out.push(path);
  }
  return out.sort();
}

async function sha256(path: string): Promise<string> {
  const buf = await readFile(path);
  const h = createHash("sha256");
  h.update(buf);
  return "sha256-" + h.digest("base64");
}

async function buildManifest(): Promise<Record<string, string>> {
  const manifest: Record<string, string> = {};
  for (const { subdir, pattern } of WATCHED) {
    const files = await listFiles(subdir, pattern);
    for (const file of files) {
      // Bootstrap looks files up under UChrm = <profile>/chrome/, so the key
      // strips the leading "chrome/" — making it "utils/boot.sys.mjs" etc.
      const relPath = file.slice("chrome/".length).replaceAll("\\", "/");
      manifest[relPath] = await sha256(file);
    }
  }
  return manifest;
}

const template = await readFile(TEMPLATE, "utf8");
const manifest = await buildManifest();

if (Object.keys(manifest).length === 0) {
  console.error("✗ generate-bootstrap: empty manifest — chrome/ directories empty?");
  process.exit(1);
}

const manifestJson = JSON.stringify(manifest, null, 2);
const generated = template.replace("__PALEFOX_PINNED__", manifestJson);

if (generated === template) {
  console.error(`✗ generate-bootstrap: __PALEFOX_PINNED__ placeholder not found in ${TEMPLATE}`);
  process.exit(1);
}

await writeFile(OUTPUT, generated);
console.log(
  `✓ ${OUTPUT}  (${Object.keys(manifest).length} pinned files, ` +
  `${generated.length} bytes)`
);
