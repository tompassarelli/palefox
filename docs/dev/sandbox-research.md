# Sandboxing palefox: shipping chrome-privileged JS without the
# fx-autoconfig local-attacker problem

**Status.** Research, no code change. Read end-to-end before picking a
direction; the recommendation in section 3 only makes sense in light of
the threat model in section 1 and the option matrix in section 2.

**Audience.** Future-Tom and any agent picking up the install-security
workstream. Assumes you know what fx-autoconfig is and how palefox is
built today (`CLAUDE.md`, `docs/dev/firefox-upstream-stability.md`).

---

## 1. Confirmed / corrected threat model

### 1.1 What the install actually creates

`install.sh` and `nix/module.nix` both follow the same shape (verified
against the live install at `~/.mozilla/firefox/tom/chrome/` and the
fx-autoconfig README):

| Path                                         | Owner / writability        | Privilege at runtime |
| -------------------------------------------- | -------------------------- | -------------------- |
| `<install-root>/config.js`                   | root (or Nix store)        | Bootstrap, run with system principal |
| `<install-root>/defaults/pref/config-prefs.js` | root (or Nix store)      | Sets `general.config.filename = "config.js"` |
| `/etc/firefox/<config>.js` (GTK fallback)    | root                       | Same — checked first on Linux/GTK |
| `<profile>/chrome/utils/chrome.manifest`     | **user**                   | Registered as `chrome://userchromejs/content/`, `chrome://userscripts/content/`, `chrome://userstyles/skin/`, `chrome://userchrome/content/` — full chrome scope |
| `<profile>/chrome/utils/boot.sys.mjs`        | **user**                   | Imported as `ChromeUtils.importESModule(...)` from system-principal context |
| `<profile>/chrome/utils/utils.sys.mjs`, `fs.sys.mjs`, `module_loader.mjs`, `uc_api.sys.mjs` | **user** | Same — chained imports |
| `<profile>/chrome/JS/*.uc.js`, `*.uc.mjs`, `*.sys.mjs` | **user**       | Loaded into every browser window, system principal |
| `<profile>/chrome/CSS/*.uc.css`              | **user**                   | Author/agent stylesheet, can carry chrome:// `@imports` |
| `<profile>/chrome/<arbitrary>.css`           | user                       | Loaded only via `userChrome.css` `@import` (so user-content) |

The privileged path is created by **two stages**:

1. **The bootstrap stage** (`config.js`): lives in the install root, is
   read by `nsReadConfig::readConfigFile()`
   (`firefox/extensions/pref/autoconfig/src/nsReadConfig.cpp:123-236`).
   Two locations are tried, *in this order on GTK builds*:
   - `NS_OS_SYSTEM_CONFIG_DIR` → `/etc/firefox/<filename>` (GTK only)
   - `NS_GRE_DIR` → `/usr/lib/firefox/<filename>` (or `.../Resources/` on macOS, `Program Files\Mozilla Firefox\` on Windows)
   Both are root-owned. The sandbox is *enabled by default in release
   and beta channels* (line 138-141 of nsReadConfig.cpp) but
   `general.config.sandbox_enabled = false` (set by
   `defaults/pref/config-prefs.js`) lifts that, granting full XPCOM.

2. **The chain-load stage** (`boot.sys.mjs`): the bootstrap invokes
   ```js
   let cmanifest = ...get('UChrm', Ci.nsIFile);
   cmanifest.append('utils');
   cmanifest.append('chrome.manifest');
   if (cmanifest.exists()) {
     Components.manager.QueryInterface(Ci.nsIComponentRegistrar).autoRegister(cmanifest);
     ChromeUtils.importESModule('chrome://userchromejs/content/boot.sys.mjs');
   }
   ```
   `UChrm` resolves to `<profile>/chrome/`
   (`firefox/toolkit/xre/nsXREDirProvider.cpp:495-505` —
   `GetProfileStartupDir()` + `AppendNative("chrome")`).

   That's the security boundary. The bootstrap is locked away in
   root-only territory, but the moment it's invoked it goes looking for
   files in a directory the user can write — and registers them as
   chrome:// URLs.

3. **boot.sys.mjs's own scan** (`firefox/.../boot.sys.mjs:418-449`): it
   iterates `chrome://userscripts/content/` (= `<profile>/chrome/JS/`)
   and `chrome://userstyles/skin/` (= `<profile>/chrome/CSS/`). Every
   matching `*.uc.js`/`*.uc.mjs`/`*.sys.mjs` file becomes
   chrome-privileged JS injected into every browser window via
   `Services.scriptloader.loadSubScriptWithOptions(...)`.

Confirmation that the loader's own readme acknowledges this:

> Please note that malicious external programs can now inject custom
> logic to Firefox even without elevated privileges just by modifying
> boot.sys.mjs or adding their own script files.

(`fx-autoconfig/readme.md:21`)

### 1.2 Adversary model

Picking the most realistic worst-case the user described:

- **Local user-mode attacker.** A compromised npm package, malicious
  installer, RCE through some other process running as the user.
- **Capability**: arbitrary write to anywhere `$HOME` is writable.
- **Cannot**: write to `/etc`, `/usr/lib`, `/Applications/Firefox.app/`,
  `Program Files`, `/nix/store`, or otherwise escalate to root.

### 1.3 Attack surface, ranked

Given that adversary, every one of these is fatal:

1. **Drop a new file** in `<profile>/chrome/JS/foo.uc.js`. Loads
   automatically on next startup. The metadata header parsing is
   permissive — almost any file with a `.uc.js` suffix that starts with
   alphanumeric runs (boot.sys.mjs:420). No signature, no hash check,
   no allowlist.

2. **Replace `<profile>/chrome/utils/boot.sys.mjs`**. The bootstrap
   imports whatever sits there. Total compromise — attacker controls
   the loader itself, can lie about which scripts are running.

3. **Replace `<profile>/chrome/utils/chrome.manifest`**. Lets the
   attacker re-point `chrome://userscripts/content/` to anywhere on
   disk. Same effect as #2 with one extra hop.

4. **Drop a `*.uc.css` with `@import chrome:// ...`** that pulls in
   resources from places the manifest already maps. Less powerful (CSS
   only) but persistent.

5. **Drop a `*.sys.mjs`** anywhere boot.sys.mjs scans (note: file naming
   `*.sys.mjs` triggers automatic background-module loading at startup,
   *before* any window opens — `boot.sys.mjs:425-435`). Earliest
   possible execution, most dangerous.

#### Comparison with vanilla Firefox

Out of the box, Firefox release blocks all of those:

- Adding executable extension code requires either (a) an AMO-signed
  XPI, (b) Mozilla-signed `SIGNEDSTATE_PRIVILEGED` extension, (c) a
  built-in addon shipped inside `omni.ja` (= install root), or (d) a
  side-load via `xpinstall.signatures.required = false` on a build
  with `MOZ_REQUIRE_SIGNING = 0` (Nightly, Dev Edition, unbranded,
  ESR-Dev — *not* the official release the user installs).
  - `firefox/toolkit/mozapps/extensions/internal/AddonSettings.sys.mjs:32-48`:
    on official Firefox, `REQUIRE_SIGNING` is hard-coded `true`, the
    pref is ignored.
- The signing root certificate is Mozilla's; only Mozilla can mint
  privileged-tier signatures
  (`firefox-source-docs/.../addon-manager/SystemAddons.html` —
  "addons.mozilla.org will not work for system add-ons").

So **palefox today widens the attack surface from "needs Mozilla
signature OR install-root write" to "needs $HOME write."** The user's
description of the threat model is accurate; we're not making it up.

### 1.4 Caveats / things that don't actually help us

- **omni.ja is not signature-verified at runtime** in current release
  builds. Bug 1515712 ("corruption detection") landed for telemetry
  in Firefox 68 but does **not** refuse to load a modified
  omni.ja. Bug 1515173 was resolved FIXED with the system-addon-signing
  scope dropped. We can read a modified omni.ja, but a local attacker
  who can write inside `/nix/store` or `/usr/lib/firefox/` is already
  privileged enough to do anything else; it's not a useful boundary
  for our model.
- **`MOZ_REQUIRE_SIGNING` doesn't help the loader.** It's an
  AMO-signature gate on **WebExtension XPIs**, not on profile-side
  chrome code. fx-autoconfig sidesteps the entire add-on framework.
- **Firefox sandboxing** (the e10s content sandbox, the new socket
  process, etc.) is about isolating *content* from chrome. fx-autoconfig
  runs in chrome scope; sandbox flags don't constrain it.

---

## 2. Options inventory

For each: install UX, what palefox keeps/loses, threat model achieved,
implementation effort, ongoing maintenance cost.

### Option A — Status quo (do nothing)

Mention only for the comparison baseline.

- **Capabilities**: full. Touches `gBrowser`, `gURLBar`, `Services`,
  `IOUtils`, `TabContextMenu`, `SessionStore`, registers JSWindowActor
  via `boot.sys.mjs`'s experimental WindowActor support
  (palefox uses this for `content-focus.ts`).
- **Install UX**: `install.sh` (curl|bash with sudo prompt for
  install-root write) or `nix/module.nix` (declarative).
- **Threat model**: any user-mode malware writes to
  `<profile>/chrome/...` and gets full browser authority on next
  start. Acknowledged-broken.
- **Effort/maint**: zero.

### Option B — Move to a WebExtension (Manifest V3)

Rebuild palefox as a sidebar extension, signed and distributed via AMO.

- **What survives**: tab list / vim shortcuts / drag-and-drop within
  the *sidebar* surface. Tree view of tabs. Per-tab metadata stored in
  `extension.storage`. Maybe basic history / picker if scoped to the
  sidebar UI. Sidebery is the existence proof.
- **What dies**:
  - Chrome restructuring (`src/drawer/`): everything in `compact.ts`,
    `urlbar.ts`, `layout.ts`, `sidebar-button.ts`, `drag-overlay.ts` —
    these reparent native Firefox elements (#urlbar, #navbar,
    #sidebar-main). WebExtensions have **no API** for any of this.
  - The native sidebar take-over (`src/tabs/layout.ts` mounts our
    panel into the chrome XUL, replacing the default sidebar
    contents). MV3 sidebars are HTML iframes, not chrome injection.
  - `j`/`k` content scrolling via the JSWindowActor in
    `content-focus.ts`. WebExtensions can run content scripts but they
    cannot call into chrome to react to focus state with <16ms
    latency, and the scrolling itself would lose the rAF-driven
    smoothness.
  - The tabs context menu integration (`src/tabs/menu.ts` calls
    `TabContextMenu.contextTab = ...; TabContextMenu.moveTabsToSplitView?.()`)
    — only chrome scope can poke that.
  - `gURLBar` parity (the `:` ex-command picker, leader-key ex-mode,
    history nav). The urlbar internal commands aren't exposed to MV3.
  - Rebuilding tabs from `SessionStore` after restart, persisting the
    tree across crashes. MV3 has `tabs.onCreated` but no equivalent of
    `SessionStore.persistTabAttribute`.
- **Install UX**: AMO listing, normal `addons.mozilla.org` install. Best
  in class — one click, signed, sandboxed by Firefox itself.
- **Threat model achieved**: matches vanilla Firefox. Strong.
- **Effort**: this is **not a port; it's a rewrite.** Probably 3-4×
  the current code volume to recover the ~60% of features that are
  recoverable. Many palefox features become impossible. The tabs
  module is `~3500 lines of TS` and most of it is gBrowser-shaped; the
  WebExtension `tabs` API is enough to mirror tab state but not the
  XUL element tree.
- **Maintenance**: trivial — Mozilla owns the API surface.
- **Verdict**: this is the "give up and become a different project"
  option. We lose what makes palefox palefox.

### Option C — Ship as a privileged WebExtension via xpi-manifest

Mozilla's `xpi-manifest` repo (mozilla-extensions GitHub org) exists to
sign privileged extensions for distribution via Balrog/Normandy.
Privileged extensions can declare `experiment_apis` and access privileged
permissions like `mozillaAddons`, `activityLog`, `telemetry`,
`normandyAddonStudy`.

Per `firefox/toolkit/components/extensions/Extension.sys.mjs:973-980`,
`isPrivileged` requires one of:
- `signedState === SIGNEDSTATE_PRIVILEGED` (Mozilla-signed with the
  privileged cert)
- `signedState === SIGNEDSTATE_SYSTEM` (system addon)
- `builtIn` (inside omni.ja)
- `temporarilyInstalled` AND `EXPERIMENTS_ENABLED` (Nightly/Dev only)

- **Even privileged extensions can't fully replicate palefox.**
  `experiment_apis` can expose chrome-privileged JS to the extension's
  background page, so we *could* re-create most of `gBrowser`/`Services`
  bridges. But the per-window XUL element manipulation we do in
  `drawer/layout.ts`/`urlbar.ts`/`compact.ts` would have to go through
  experiment-API-defined helpers — workable, but a lot of plumbing.
- **The signing pipeline is closed.** From the Mozilla extension docs
  ([basics.rst:155-158](file:///home/tom/code/firefox/toolkit/components/extensions/docs/basics.rst)):
  > Out-of-tree privileged extensions cannot be signed by
  > addons.mozilla.org. A different pipeline is used to sign them with
  > a privileged certificate. You'll find more information in the
  > xpi-manifest repository on GitHub.

  Reading xpi-manifest's docs (`mozilla-extensions/xpi-manifest`):
  the ostensibly-open process requires the source repo to be moved
  into the `mozilla-extensions` GitHub org or, at minimum, audited by
  Mozilla SecOps; both `moz-releng-automation` and
  `moz-releng-automation-stage` need access; "SecOps will be auditing
  the repositories in the `mozilla-extensions` organization for
  compliance." In practice this is gated to Mozilla-affiliated
  projects (Multi-Account Containers, Form Autofill, Translations,
  etc.). There's no public application process and no precedent of a
  hobbyist project being signed.
- **Threat model achieved**: matches vanilla Firefox.
- **Effort**: Option B's rewrite + the experiment API plumbing +
  whatever it takes to convince Mozilla to sign the thing. Probably
  unattainable for a single-developer project.
- **Verdict**: dead end unless Mozilla's policy on this changes.

### Option D — Ship the entire loader bundled with Firefox via a fork

This is what Floorp, Zen, LibreWolf, Mullvad Browser, Tor Browser do.
Build palefox into a Firefox patchset, ship binaries, distribute through
your own channel.

- **Capabilities**: full, plus we control the install image so we can
  ship privileged-signed extensions to ourselves (Tor + Mullvad bundle
  uBlock and NoScript this way).
- **Install UX**: separate browser binary. User uninstalls Firefox or
  runs both. This is a different product.
- **Threat model achieved**: matches the equivalent vanilla browser —
  attacker needs install-root write to inject code.
- **Effort**: enormous *and* recurring. Zen rebases against
  mozilla-central regularly; LibreWolf maintains ~30+ patches. You
  inherit the full Firefox build pipeline (~30GB checkout, 1-3 hour
  builds, signing infrastructure for each platform), update server,
  release engineering. This is a 1-FTE-minimum operation.
- **Maintenance**: tracks Firefox upstream forever. Every Firefox ESR
  bump = a patch-rebase sprint.
- **Verdict**: only viable if palefox grows into something that wants
  to be a distinct product. Wildly disproportionate to current scope.

### Option E — Hash-pin the script directory from the bootstrap

Write a *palefox-specific* bootstrap (`config.js` replacement) that:

1. Computes SHA-256 of `<profile>/chrome/utils/boot.sys.mjs` and every
   file in `<profile>/chrome/JS/` and `<profile>/chrome/CSS/`.
2. Compares against a hash manifest baked into the bootstrap itself
   (which lives in the install root, only writable by root / Nix
   store).
3. Refuses to load any file whose hash isn't in the manifest.

The bootstrap is in `/usr/lib/firefox/` (or `/etc/firefox/`, or the Nix
store) — the same protected location as fx-autoconfig's existing
bootstrap. The manifest is part of that file, so it inherits the same
protection.

Concretely the bootstrap looks like (pseudo-code):

```js
// in /usr/lib/firefox/config.js (root-owned)
const PALEFOX_HASHES = {
  "utils/boot.sys.mjs":   "sha256:abc...",
  "utils/utils.sys.mjs":  "sha256:def...",
  "JS/palefox-tabs.uc.js":   "sha256:...",
  "JS/palefox-drawer.uc.js": "sha256:...",
};

try {
  const chromeDir = ...get('UChrm', Ci.nsIFile);
  for (const [relPath, expected] of Object.entries(PALEFOX_HASHES)) {
    if (!fileMatches(chromeDir, relPath, expected)) {
      console.error(`palefox: refusing to load — ${relPath} hash mismatch`);
      return;  // bail completely
    }
  }
  // also: refuse to load if there are EXTRA files not in the manifest
  if (extraFilesPresent(chromeDir)) return;
  Components.manager.QueryInterface(Ci.nsIComponentRegistrar)
    .autoRegister(chromeDir.append("utils").append("chrome.manifest"));
  ChromeUtils.importESModule("chrome://userchromejs/content/boot.sys.mjs");
} catch (ex) { /* swallow per autoconfig contract */ }
```

- **Capabilities**: identical to today. Loader still runs the same
  scripts; we've only gated *which* scripts are allowed.
- **Install UX**: same install requires a one-time elevated copy to
  `/usr/lib/firefox/` (or `/etc/firefox/`), plus a profile-side copy
  of the JS files. **Updates are now coupled**: installing a new
  palefox version requires both writing the new `chrome/JS/` files
  and updating the bootstrap manifest. The install script handles
  this; the user just re-runs `install.sh`. Nix users get this for
  free because the manifest can be generated from the same chrome/
  source that's hashed into `/nix/store`.
- **Threat model achieved**: **strong against the npm-compromise
  scenario.** A local attacker can drop new files in
  `<profile>/chrome/JS/` but the bootstrap refuses to load anything
  whose hash isn't pinned. Modifying `boot.sys.mjs` itself fails the
  hash check. The bootstrap itself is in a root-protected location,
  so the attacker can't change which hashes are pinned.
  **Limitations**:
  - Doesn't cover existing-file *modification by chrome.manifest
    re-registration*. The chrome.manifest registers
    `chrome://userscripts/content/ ../JS/` — if we hash `JS/` and the
    manifest, we're fine.
  - Doesn't help for attacks delivered through palefox itself
    (a malicious upstream commit, a compromised release artifact).
    That's a different threat model — release-artifact integrity, not
    local-malware. We can layer on Sigstore / GitHub-attestation /
    Cosign for that, but it's orthogonal.
  - The user could disable the gate by removing the install-root
    bootstrap (downgrade to vanilla Firefox + their own scripts).
    That's fine — it requires sudo, which is the bar we wanted.
- **Effort**: realistic. Order of a week of focused work.
  1. Replace `program/config.js` with the hash-checking variant.
     (~150 lines of cautious JS, including the Ci.nsIScriptableInputStream
     + nsICryptoHash plumbing for SHA-256. All XPCOM that's been stable for a decade.)
  2. Add a `bun run build:install-bundle` step that, after building
     the .uc.js files, computes SHA-256 of every chrome/utils/ and
     chrome/JS/ file and stamps them into the bootstrap source.
  3. Update `install.sh` to copy the *generated* bootstrap (not the
     stock fx-autoconfig one) to `/usr/lib/firefox/config.js`.
  4. Update `nix/module.nix` to build the manifest at evaluation time
     (Nix can read the chrome/ files at build, hash them, and produce
     the bootstrap, which goes into the Firefox `extraPrefsFiles`).
  5. Document the trade: users who want to add their own personal
     `*.uc.js` to the same profile can't, unless they re-run the
     install with their files included so they get hashed in. This is
     the deliberate cost of the security model.
- **Maintenance**: low. The XPCOM APIs we'd touch (nsIFile,
  nsIScriptableInputStream, nsICryptoHash, ChromeUtils.importESModule)
  are some of the most stable surfaces in Firefox. We'd add them to
  the `tools/firefox-canary.ts` manifest. Hash check itself is a
  ~30-line function.

This is the option I'm recommending. Section 3 has the full case.

### Option F — Move the JS into the install root

Variation of E: instead of hash-pinning the profile-side scripts, copy
them into the install root and have the bootstrap chain-load from
*there*, not from `<profile>/chrome/`. Manifest path becomes
`/usr/lib/firefox/palefox/...` instead of `<profile>/chrome/`.

- **Capabilities**: same as today.
- **Install UX**: every install (and every update) requires a sudo
  copy of the entire `chrome/` tree to `/usr/lib/firefox/palefox/`.
  Slightly more annoying than option E (whose `chrome/` lives in the
  profile, which is per-user).
- **Threat model**: same as option E. A local attacker without sudo
  can't write to `/usr/lib/firefox/`, so no extra scripts can be
  injected.
- **Effort**: lower than E (no hashing — just relocation and a
  `chrome.manifest` path edit). But **it costs us per-profile
  scripting** — the same install would run for every Firefox profile
  on the machine. For palefox this is fine; we're already global per
  the `program/` install model.
- **Maintenance**: low — but the install is friction-heavy (sudo on
  every update). Less elegant than E for the Nix path because option
  E lets the manifest live in the immutable Nix store while the
  scripts live in the profile (where Firefox expects them); option F
  moves the scripts to the store too, which is fine for Nix but
  uglier for `install.sh` users.
- **Verdict**: simpler than E; pick this if the hashing apparatus
  feels like overkill. The install-friction trade-off is real but
  not terrible.

### Option G — Use Firefox enterprise policies (`policies.json`)

`policies.json` lives at `<install-root>/distribution/policies.json` (or
`/etc/firefox/policies/policies.json`). The schema
(`firefox/browser/components/enterprisepolicies/schemas/policies-schema.json`)
includes `ExtensionSettings`, `Preferences`, `Containers`, etc. — but
**not "execute custom JS in chrome scope"**.

The policies engine is intentionally constrained to "deployment knobs an
IT admin would want." There's no `RunCustomScript` policy, no
`AllowedAutoconfig` policy. (And the policies file would itself be a
local-privilege grant target if there were such a policy — but Mozilla
correctly never built it.)

- **Verdict**: dead end for our purpose. Mention only because the user
  asked.

### Option H — Use `userScripts` API (MV3)

`browser.userScripts` is now MV3-native (replaced the legacy MV2 API).
But the docs are explicit: scripts run in the **content** scope, in an
isolated world, and **cannot access extension APIs or chrome scope**
([MDN — userScripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts)).
This is for things like Tampermonkey, not for replacing the sidebar.

- **Verdict**: dead end. Wrong scope.

### Option I — Restrict the loader's scope from inside `boot.sys.mjs`

Modify boot.sys.mjs to only load scripts whose filenames match a
hard-coded allowlist (`palefox-tabs.uc.js`, `palefox-drawer.uc.js`).

- **Defeats**: a casual attacker dropping `evil.uc.js`. Doesn't
  defeat: an attacker who **modifies boot.sys.mjs**, since it's also
  in `<profile>/chrome/utils/` and writable. Could also be defeated
  by writing `palefox-tabs.uc.js` (overwriting our own scripts,
  matches the allowlist).
- **Verdict**: false sense of security. Don't ship.

### Option J — Sigstore / attestation for the GitHub release artifact

Generate Cosign / GitHub-attestation signatures for the release tarball;
have `install.sh` verify against a public key embedded in the script.

- **Defeats**: a compromised CDN serving a tampered tarball.
- **Doesn't defeat**: the local-malware threat model (attacker is on
  the user's machine post-install; they don't need to MITM the
  release).
- **Verdict**: useful complement but addresses a different threat.

---

## 3. Recommendation

**Adopt Option E (hash-pinned bootstrap) as the install-time architecture
for palefox.** Pursue Option F-style relocation of the loader files
(`chrome/utils/`) to the install root *as part of the same change*, so
that only the workload scripts (`chrome/JS/*.uc.js`) live profile-side
and need hashing. That gives us:

- **Install root**: `/usr/lib/firefox/config.js` (custom bootstrap with
  baked-in SHA-256 manifest) + `/usr/lib/firefox/palefox-loader/` (the
  copy of `boot.sys.mjs`, `utils.sys.mjs`, etc., chain-loaded from the
  bootstrap, **no longer from `<profile>/chrome/utils/`**).
- **Profile**: `<profile>/chrome/JS/palefox-tabs.uc.js` and
  `<profile>/chrome/JS/palefox-drawer.uc.js`. These are still where
  fx-autoconfig expects scripts, but the bootstrap refuses to load any
  file whose hash isn't in the manifest.

### Why this option

1. **Achieves the bar.** A local attacker without sudo cannot inject
   privileged JS. The bootstrap is in `/usr/lib/firefox/` (or
   `/etc/firefox/`, or the Nix store) — all root-only. Any
   modification of profile-side files fails the hash check; any extra
   profile-side `.uc.js` file isn't in the manifest and is rejected.

2. **Preserves all current capabilities.** The script execution
   environment is identical to today. `gBrowser`, `gURLBar`,
   `Services`, JSWindowActor, content-focus bridge, frame scripts,
   XUL element manipulation — all unchanged. The hash gate is purely
   additive: same JS gets the same privileges if and only if it
   matches the pinned hash.

3. **Doesn't depend on Mozilla.** No signing certificate, no AMO
   review, no xpi-manifest gate. We control the bootstrap, we control
   the manifest. No Mozilla policy change can break this.

4. **Install UX stays close to today's.** `install.sh` already prompts
   for sudo to copy `program/config.js` to the install root. The
   change is: that file is now generated from the chrome/ contents
   instead of being a static fx-autoconfig fork. One-time cost: the
   user sees one extra line in the `install.sh` output. Updates: same
   sudo prompt as today.

5. **Nix users get it for free.** The hash manifest can be computed at
   evaluation time from the same chrome/ source that goes into
   `/nix/store`, baked into `extraPrefsFiles`. Nix already trusts
   `/nix/store` integrity; we're just reusing that trust root.

6. **Effort is reasonable.** ~1 week of focused work. The trickiest
   part is the SHA-256 plumbing in privileged JS, and the interfaces
   we'd use (`nsIScriptableInputStream`, `nsICryptoHash`,
   `nsIFileInputStream`) have been stable since Firefox 1.x.

7. **Maintenance is low.** Add the hashing-relevant XPCOM symbols to
   `tools/firefox-canary.ts`. Tier-3 integration test that intentionally
   adds a wrong-hash file and asserts the bootstrap bails. We're not
   chasing a moving Firefox internal.

### Compared to the alternatives

| Option | Threat model | Capabilities kept | Effort | Maint cost | Practical |
| --- | --- | --- | --- | --- | --- |
| A. Status quo | Bad | All | 0 | 0 | — |
| B. Plain WebExtension | Strong | ~40% (sidebar only) | Rewrite | Trivial | Different project |
| C. Privileged WebExtension | Strong | ~80% | Rewrite + Mozilla approval | Low | Mozilla won't sign us |
| D. Browser fork | Strong | All | Enormous + ongoing | Very high | Not a 1-dev project |
| **E. Hash-pinned bootstrap** | **Strong** | **All** | **~1 week** | **Low** | **Yes** |
| F. Loader in install root | Strong | All | ~3 days | Low (sudo on every update) | Slightly clumsier than E |
| G. policies.json | N/A | N/A | N/A | N/A | Not a policy that exists |
| H. userScripts MV3 | Strong | ~5% | Rewrite | Trivial | Wrong scope |
| I. Allowlist in boot.sys.mjs | Bad | All | hours | Low | False security |
| J. Sigstore release | Different threat | All | ~2 days | Low | Layer on top of E |

E + F are basically the same shape; the difference is whether the
loader files live in the profile (E) or install root (F+E). I recommend
**combining them**: relocate the loader to install root (so its
integrity is naturally protected by FS perms) and keep hash-pinning for
the profile-side script files (because that's where users would
naturally want to drop their own `.uc.js` and we want to fail closed).

### Sketch of the implementation plan

1. **`program/palefox-bootstrap.js`** (new file, replaces fx-autoconfig's `config.js`):
   - First, register a chrome.manifest from `<install-root>/palefox-loader/`
     (so `chrome://palefox-loader/content/` points there, not to the
     profile).
   - Compute SHA-256 of every file in
     `<profile>/chrome/JS/` (directory iteration via nsIFile).
   - Compare against a `PALEFOX_PINNED_HASHES` map baked into this
     file at build time.
   - If any mismatch OR any extra file: log to console, bail.
   - If all match: `ChromeUtils.importESModule("chrome://palefox-loader/content/boot.sys.mjs")`.

2. **`program/palefox-loader/`** (new directory):
   - Contains the renamed `boot.sys.mjs`, `utils.sys.mjs`, `fs.sys.mjs`,
     `module_loader.mjs`, `uc_api.sys.mjs` from fx-autoconfig.
   - Modified to look at `<profile>/chrome/JS/` only for *script
     content*, not for the loader itself (paths in chrome.manifest
     change accordingly).

3. **`build.ts`**: after building `chrome/JS/*.uc.js`, generate
   `program/palefox-bootstrap.generated.js` with the hash map filled in.

4. **`install.sh`**:
   - Copy `program/palefox-bootstrap.generated.js` →
     `<install-root>/config.js` (sudo as needed).
   - Copy `program/palefox-loader/` → `<install-root>/palefox-loader/`.
   - Copy `chrome/JS/*.uc.js` → `<profile>/chrome/JS/` (no sudo).
   - **Remove** `<profile>/chrome/utils/` (cleanup; the loader is no
     longer chain-loaded from there).

5. **`nix/module.nix`**:
   - Compute the bootstrap derivation with hashes baked in via Nix
     builtins (`builtins.hashFile "sha256" ...`).
   - `extraPrefsFiles = [ palefoxBootstrap ]` so it's baked into
     `mozilla.cfg` at the install-root level (via wrapFirefox).

6. **Tier 3 integration test**:
   - Build profile, install, drop `<profile>/chrome/JS/evil.uc.js`,
     start Firefox, assert nothing palefox-y loads (or that an explicit
     "hash mismatch" warning is logged).
   - Drop a corrupted `palefox-tabs.uc.js`, assert same.
   - Restore correct files, assert palefox loads.

7. **`docs/dev/firefox-stability-roadmap.md`**: add the hashing
   primitives (`nsICryptoHash`, `nsIScriptableInputStream`) to the
   manifest. They're unlikely to move but should be in the canary.

8. **README**: section "Why palefox needs install-root access" with a
   one-paragraph honest threat-model explanation. Lift wording from
   section 1 of this doc.

### Migration path for existing users

- v0.X (current): fx-autoconfig as today.
- v0.Y (next minor): ship the new bootstrap *alongside* the old one.
  install.sh removes the old `<profile>/chrome/utils/` directory and
  installs the hash-pinned bootstrap. Users running the old loader
  fall back to it gracefully if the new bootstrap fails (we keep the
  fx-autoconfig contract: errors are swallowed). One sudo prompt.
- v1.0: drop the fx-autoconfig fallback entirely.

### What we're NOT solving

- **Release-artifact tampering** (compromised GitHub release tarball,
  CDN MITM). Solve with Option J (sigstore/attestation) layered on top.
  Out of scope for the in-browser threat model.
- **Compromised palefox commit upstream.** That's a code-review
  problem, not a loader problem.
- **The user deliberately weakening their security** (running
  `sudo rm /usr/lib/firefox/config.js`, then installing rogue
  scripts). Out of scope by definition.

---

## 4. Open questions blocking the recommendation

1. **Snap / Flatpak Firefox.** `install.sh` already detects Snap and
   exits with an error because the install root is read-only. Flatpak
   Firefox keeps its install root in `/var/lib/flatpak/app/...` —
   immutable from the user's perspective but writable as root via
   `flatpak`. Need to verify that copying our bootstrap into the
   Flatpak install actually works (the Flatpak sandbox may prevent
   nsReadConfig from finding it in `NS_GRE_DIR`). If not, Flatpak
   users get the same "use Mozilla PPA" message as Snap users today.
   — Investigate before committing to E.

2. **macOS code signing.** `Firefox.app/Contents/Resources/config.js`
   placement works today (per the fx-autoconfig readme) but I haven't
   verified that recent macOS Firefox builds with notarization /
   code-signing requirements still allow autoconfig to run when an
   external file is added to `Contents/Resources/`. macOS may
   silently invalidate the signature, which could break Gatekeeper.
   — Test on macOS before shipping.

3. **Hash-check perf.** SHA-256 of a few hundred KB of `*.uc.js` at
   startup is sub-millisecond, but `nsIScriptableInputStream` is sync
   I/O on the main thread before any window paints. Need to confirm
   we don't move the startup-paint number measurably. — Easy to
   measure once the bootstrap exists.

4. **What about CSS?** The fx-autoconfig loader scans `<profile>/chrome/CSS/`
   for `*.uc.css` and registers them via `chrome://userstyles/skin/`.
   CSS can include `chrome://` URLs in `@import`, but it can't execute
   JS. **However**, CSS loaded as `agent_sheet` mode applies globally
   and could exfiltrate via background-image: url(...) leaks. Probably
   want to hash-pin the CSS files too. — Decide whether to gate CSS
   the same as JS (probably yes; cheap).

5. **`palefox.css` lives in the profile.** Today `chrome/palefox.css`
   is loaded via `userChrome.css`'s `@import`. If we hash-pin
   everything, we need to include `palefox.css` and all its
   sub-sheets. If we don't, an attacker can replace `palefox.css`
   with one that does ARIA-leak attacks via CSS. — Probably hash-pin
   all of it.

6. **Userland `user.css` carve-out.** The whole point of `user.css`
   is that the user can edit it without touching palefox. If we
   hash-pin `userChrome.css`, the user can't add their own imports.
   Solution: keep `user.css` *intentionally outside the hashed set*,
   require it to be loaded only via a final `@import url("user.css");`
   in `palefox.css`. The user can still inject CSS but not JS — the
   threat-model bar we're aiming for. — Document this explicitly.

7. **Multi-profile users.** A user with multiple profiles
   (`-p` switching) gets the same bootstrap (install-root) but
   different `<profile>/chrome/JS/`. The bootstrap needs to use the
   actually-active `UChrm` directory, which it already does. Just
   confirm in testing that switching profiles between palefox and
   non-palefox profiles works (the bootstrap should silently bail on
   profiles without our pinned files).

8. **What if someone wants to add their own uc.js to the same
   profile?** This is the deliberate downside. The escape hatch:
   either (a) build palefox locally with their files included so
   they get hashed in (Nix users do this naturally), or (b) opt
   out of the hash gate via a separate, explicit, sudo-required
   pref. Don't add (b) silently.

---

## Appendix — Sources

### In-tree (verified by reading)

- `fx-autoconfig/program/config.js`
- `fx-autoconfig/program/defaults/pref/config-prefs.js`
- `fx-autoconfig/profile/chrome/utils/chrome.manifest`
- `fx-autoconfig/profile/chrome/utils/boot.sys.mjs` (full read)
- `fx-autoconfig/readme.md` (the loader's own warning, line 21)
- `firefox/extensions/pref/autoconfig/src/nsReadConfig.cpp`
- `firefox/toolkit/xre/nsXREDirProvider.cpp` (UChrm resolution)
- `firefox/toolkit/mozapps/extensions/internal/AddonSettings.sys.mjs`
- `firefox/toolkit/mozapps/extensions/internal/XPIDatabase.sys.mjs`
- `firefox/toolkit/mozapps/extensions/internal/XPIProvider.sys.mjs`
- `firefox/toolkit/mozapps/extensions/internal/XPIInstall.sys.mjs`
- `firefox/toolkit/components/extensions/Extension.sys.mjs`
- `firefox/toolkit/components/extensions/docs/basics.rst`
- `firefox/browser/components/enterprisepolicies/schemas/policies-schema.json`
- `palefox/install.sh`, `palefox/nix/module.nix`
- `palefox/src/tabs/content-focus.ts` (frame-script use case)
- `palefox/src/tabs/menu.ts` (TabContextMenu access)
- `palefox/src/tabs/log.ts` (IOUtils + Services.dirsvc usage)
- `palefox/src/firefox/*.ts` (semantic-layer adapters)
- `~/code/zen-browser/surfer.json` (confirmed Zen is a Firefox patchset
  fork shipping its own binary)
- `~/code/librewolf/patches/` (confirmed LibreWolf is a patch overlay
  on Firefox source)

### External

- [fx-autoconfig README — known-malicious-write warning](https://github.com/MrOtherGuy/fx-autoconfig#warning)
- [Mozilla — System Add-ons Overview](https://firefox-source-docs.mozilla.org/toolkit/mozapps/extensions/addon-manager/SystemAddons.html) — third parties cannot ship system addons; only Mozilla signs the system-addon root.
- [Mozilla — Firefox extensions basics — privileged extensions](https://firefox-source-docs.mozilla.org/toolkit/components/extensions/webextensions/basics.html) — out-of-tree privileged extensions cannot be signed by AMO; xpi-manifest pipeline is gated.
- [bug 1515712 — corruption detection (telemetry only, doesn't refuse to load modified omni.ja)](https://bugzilla.mozilla.org/show_bug.cgi?id=1515712)
- [bug 1515173 — RESOLVED FIXED, system-addon signing dropped from scope](https://bugzilla.mozilla.org/show_bug.cgi?id=1515173)
- [Mozilla — Third-Party Software Injection Policy](https://www.mozilla.org/en-US/security/third-party-software-injection/) — Mozilla reserves the right to blocklist third-party injectors but doesn't specifically address userscript loaders.
- [MDN — userScripts API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts) — content scope only, no chrome access.
- [MDSec — Abusing Firefox in Enterprise Environments](https://www.mdsec.co.uk/2020/04/abusing-firefox-in-enterprise-environments/) — confirms autoconfig is an attractive RCE persistence target if attacker has install-root write.
- [NixOS Firefox wrapper.nix](https://github.com/NixOS/nixpkgs/blob/master/pkgs/applications/networking/browsers/firefox/wrapper.nix) — `extraPrefsFiles` ends up in `/nix/store/.../lib/firefox/mozilla.cfg`, immutable.
- [xpi-manifest repo](https://github.com/mozilla-extensions/xpi-manifest) — privileged-extension signing pipeline; gated through Mozilla SecOps.
