# Hash-pinned loader — implementation plan

**Status.** Active workstream. Sister doc to `sandbox-research.md` (which
explains the *why*); this one is the *how*.

**Goal.** Replace fx-autoconfig's permissive `config.js` bootstrap with a
hash-pinning bootstrap that refuses to load any chrome JS or CSS whose
SHA-256 doesn't match a manifest baked in at palefox build time. Net
effect: a local attacker with `$HOME` write can no longer inject
chrome-privileged JS — they need `sudo` (or write access to the Nix
store), matching the trust bar of vanilla Firefox.

This work happens on the `js-legacy` branch. `main` is reserved for the
upcoming Firefox-fork direction.

---

## What changes, by area

### 1. CSS migration — drop the legacy stylesheets pref

**Why.** As long as `toolkit.legacyUserProfileCustomizations.stylesheets`
is true, Firefox itself loads `<profile>/chrome/userChrome.css` directly
(independent of our bootstrap). An attacker modifying that file or its
`@import` chain bypasses the hash gate entirely. The fix is to load all
palefox CSS through fx-autoconfig's CSS registration (which IS gated by
the bootstrap) and turn the legacy pref off.

- Move `chrome/palefox.css`, `chrome/palefox-tabs.css`, etc. → `chrome/CSS/<name>.uc.css` with a UserStyle header.
- Drop `chrome/userChrome.css` (no longer needed; nothing loads it).
- Drop `chrome/user.css` (no carve-out — see sandbox-research.md §3 for the threat-model reasoning).
- Set `userChromeJS.enabled = true` in install.sh / nix module / test profile (fx-autoconfig's CSS+JS loader gate).
- Set `toolkit.legacyUserProfileCustomizations.stylesheets = false`.

### 2. Hash-pinning bootstrap (`program/config.js`)

Replace the existing 12-line bootstrap with a verifying one (~100 lines):

1. Compute SHA-256 of every file in `<profile>/chrome/utils/`, `<profile>/chrome/JS/`, `<profile>/chrome/CSS/`.
2. Compare each against the `PINNED` manifest baked into the file at build time.
3. Reject if any pinned file is missing OR any hash doesn't match OR any extra `.uc.js`/`.uc.mjs`/`.uc.css`/`.sys.mjs` file exists.
4. If all checks pass, register the chrome.manifest and import boot.sys.mjs (same chain as today).
5. Leave a `PERSONAL` slot (read from `/etc/palefox/personal-hashes.json` or platform equivalent) that's ignored if absent. The personalize CLI tool comes later; the bootstrap is forward-compatible.

The bootstrap file lives at `program/config.js` in source. The build step generates `program/config.generated.js` with the actual hashes baked in, which is what install.sh copies to the install root.

### 3. Build-time hash generator

New script `tools/generate-bootstrap.ts`:

- Reads every file in `chrome/utils/`, `chrome/JS/`, `chrome/CSS/`.
- SHA-256 each, base64-encode.
- Writes `program/config.generated.js` — a copy of `program/config.template.js` with `__PINNED_HASHES__` substituted with the JSON literal.

Hooked into `bun run build` so it runs after the .uc.js bundling step.

### 4. install.sh updates

- Remove the `set_pref toolkit.legacyUserProfileCustomizations.stylesheets true` line.
- Add `set_pref userChromeJS.enabled true`.
- Add `set_pref toolkit.legacyUserProfileCustomizations.stylesheets false` (explicitly off — old installs may have it true).
- Copy `chrome/CSS/*.uc.css` to `<profile>/chrome/CSS/`.
- Stop copying `userChrome.css` and `user.css` (no longer used).
- Install `program/config.generated.js` (not the static `config.js`) to the install root.
- Add a cleanup pass: remove old `<profile>/chrome/userChrome.css`, `chrome/user.css`, `chrome/palefox*.css` if present (migration from previous palefox versions).

### 5. nix/module.nix updates

- Compute hashes at Nix evaluation time via `builtins.hashFile "sha256" ...`.
- Generate the bootstrap derivation with hashes baked in.
- Include in `extraPrefsFiles` (via the wrapFirefox path) so it lands in the install-root immutable location.
- Update `programs.firefox.profiles.<name>.settings`:
  - `toolkit.legacyUserProfileCustomizations.stylesheets = false`
  - `userChromeJS.enabled = true`
- Drop the `userChromeContent` / `userCssContent` builders (no longer used).
- Move CSS files into `chrome/CSS/` using `home.file`.

### 6. Test profile updates

- Drop the `toolkit.legacyUserProfileCustomizations.stylesheets = true` pref + comment.
- Add `userChromeJS.enabled = true`.
- Test profiles can't easily install a bootstrap into the system Firefox install root, so for tests we either:
  - (a) Bypass the bootstrap entirely for tests (chrome scripts loaded via test-only path), OR
  - (b) Install the bootstrap into Firefox's install root from the test driver before each run.
  
  Option (a) is simpler — the bootstrap's job is purely security gating; functional tests don't need to run it. We can keep the existing test path (Firefox loads chrome/utils/ directly via the pre-installed fx-autoconfig that the dev's machine has) and add a SEPARATE Tier 3 test that exercises the bootstrap specifically.

### 7. New Tier 3 test: bootstrap verification

`tests/integration/bootstrap-hash.ts`:

- **Test 1 — clean install loads.** Install a hash-pinned bootstrap pointing at the test profile, start Firefox, assert palefox loads (e.g., `pfxTest.api()` returns).
- **Test 2 — tampered file rejected.** Modify `<profile>/chrome/JS/palefox-tabs.uc.js` (append a comment), start Firefox, assert palefox does NOT load (assert by absence of `pfxTest`).
- **Test 3 — extra file rejected.** Drop `<profile>/chrome/JS/evil.uc.js`, start Firefox, assert palefox does NOT load.
- **Test 4 — missing file silent-bail.** Remove `<profile>/chrome/JS/palefox-tabs.uc.js`, start Firefox, assert no palefox load AND no error noise (multi-profile case).

Requires the test driver to be able to install a bootstrap into Firefox's install root. Probably gate this entire test file behind a `PALEFOX_TEST_BOOTSTRAP=1` env var so it's opt-in (developer must run it manually, since CI environments may not have writable install roots).

### 8. README + docs updates

- README install warning: drop the "actively exploring lower-risk substrates" line — we ARE the lower-risk substrate now.
- New section in README: "Why palefox needs sudo" (one paragraph honest threat-model explanation).
- `docs/install.md` — update for the new flow.
- `docs/dev/firefox-stability-roadmap.md` — add `nsICryptoHash`, `nsIScriptableInputStream`, `nsIFileInputStream`, `nsIComponentRegistrar` to the canary manifest.

---

## Execution order

1. Branch off main → `js-legacy`.
2. CSS migration (mechanical move + header rewrite).
3. Bootstrap template + hash generator + build hook.
4. install.sh changes.
5. nix/module.nix changes.
6. Test profile changes.
7. Tier 3 bootstrap-hash test (opt-in).
8. README + docs.
9. Validate: typecheck, build, integration tests pass with new CSS path.
10. Commit + push.

## What's explicitly out of scope for v1

- The `palefox personalize` CLI tool. Bootstrap is forward-compatible; tool ships later.
- Relocating `chrome/utils/` to the install root (Option F from sandbox-research.md). Hashing it in-profile is sufficient for v1; relocation is an additive future change.
- Sigstore/attestation on the GitHub release artifact. Different threat model (release-artifact integrity, not local-malware), addressed separately.
- macOS notarization compatibility testing — we'll discover this when a macOS user reports it. Linux/Nix is the primary path.
- Snap/Flatpak Firefox support. Already broken today (read-only install root); not regressed by this work.
