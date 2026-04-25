// Build script — reads build.config.ts entries, bundles each with bun build,
// prepends the UserScript banner, and writes to chrome/JS/<name>.uc.js.
//
// Run via:
//   bun run build   — one-shot
//   bun run dev     — watch mode (uses Bun's built-in --watch flag)

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { entries, type Entry } from "./build.config.ts";

const OUT_DIR = "chrome/JS";

async function buildOne(entry: Entry): Promise<boolean> {
  const result = await Bun.build({
    entrypoints: [entry.src],
    target: "browser",
    format: "iife",
    minify: false,
    sourcemap: "none", // chrome scripts don't surface external maps cleanly
  });

  if (!result.success) {
    console.error(`✗ ${entry.src}`);
    for (const log of result.logs) console.error(log);
    return false;
  }

  const [artifact] = result.outputs;
  if (!artifact) {
    console.error(`✗ ${entry.src}: no output produced`);
    return false;
  }
  const code = await artifact.text();
  const outPath = join(OUT_DIR, entry.out);
  await writeFile(outPath, entry.banner + "\n\n" + code);
  console.log(`✓ ${outPath}  (${code.length} bytes)`);
  return true;
}

await mkdir(OUT_DIR, { recursive: true });
const results = await Promise.all(entries.map(buildOne));
if (results.some(ok => !ok)) process.exit(1);
