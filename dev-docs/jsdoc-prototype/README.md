# JSDoc + interface/implementation prototype

A small slice of palefox-tabs (the pinned-tab handlers) ported to:
- `// @ts-check` JSDoc, so VSCode/tsserver type-checks the file
- "interface" section at the top with type defs and the public API shape
- "implementation" section below with the actual function bodies

## Try it

Open `tabs-pinned.js` in VSCode. Things to notice:

- **Hover any identifier** — `TreeData`, `Tab`, `Row`, `placeRowInFirefoxOrder`, etc. — and you get the docstring inline. Same for parameters.
- **Autocomplete** on `td.<TAB>` lists `id`, `parentId`, `name`, `state`, `collapsed`. Same on `deps.<TAB>`.
- **Errors inline.** Try editing line ~155 to set `td.parentId = "oops"` — red squiggle. Try `treeData(somerandom)` where `somerandom` isn't a Tab — red squiggle.
- **Jump to type definition** with F12 on any typedef name.

To run the checker from the CLI:

```bash
cd dev-docs/jsdoc-prototype
npx -p typescript tsc --noEmit --allowJs --checkJs tabs-pinned.js
```

(No package.json needed — `tsc` will infer settings, or use `tsconfig.json` if present.)

## Tradeoffs

**For:**
- Zero runtime cost. Comments-only. The `.uc.js` loader doesn't care.
- Per-file opt-in via `// @ts-check`. We can convert one file at a time.
- The interface/implementation split makes a 3000-line file readable: the contract is in the top 50 lines, the rest is plumbing.
- VSCode does the checking out of the box, no setup beyond opening the folder.

**Against:**
- `// @ts-ignore` peppered around chrome globals (`gBrowser`, `Services`, `Ci`, etc.) until we add ambient `.d.ts` for them.
- JSDoc for complex types (intersections, conditional types) is verbose vs TS syntax.
- Maintenance: type comments drift if not enforced. CI would need a `tsc --noEmit` step to catch drift.

## What this prototype does NOT solve

- File length. JSDoc doesn't make a file shorter — it just makes it more navigable. The interface/implementation split helps with that, but the real win comes from splitting code into multiple files.
- Cross-file types. To share `TreeData` etc. across split files, we'd put the typedefs in a single `types.js` (or `types.d.ts`) and `@import` them.
