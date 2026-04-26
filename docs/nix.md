# Nix / Home Manager

Palefox can be installed declaratively via a Home Manager module — this handles CSS, prefs, and Sideberry in one step.

1. Add palefox to your flake inputs:
```nix
inputs.palefox.url = "github:tompassarelli/palefox";
```

2. Import the module in your Home Manager config:
```nix
imports = [ inputs.palefox.homeManagerModules.default ];
```

3. Enable it:
```nix
programs.palefox = {
  enable = true;
  profile = "your-profile-name";  # optional, defaults to "default-release"
  autohide = false;               # optional
  jsLoader = true;                # optional, enables tabs panel + drawer JS
};
```

4. Rebuild with `nixos-rebuild switch` or `home-manager switch`

> Note: Sideberry is installed automatically via [NUR](https://github.com/nix-community/NUR). Ensure NUR is in your flake inputs and overlays. Set `sideberry = false` if you manage extensions separately.

## JS loader (hash-pinned bootstrap)

When `jsLoader = true`, Home Manager deploys profile-side files
(`chrome/utils/`, `chrome/JS/`, `chrome/CSS/`) but the matching install-root
bootstrap (`program/config.generated.js` + `program/defaults/pref/config-prefs.js`)
must be wired separately at the NixOS level — Home Manager can't write to
the Firefox install root.

The simplest path is to wrap Firefox with the bootstrap as `extraPrefsFiles`:

```nix
nixpkgs.overlays = [
  (final: prev: {
    firefox = prev.wrapFirefox prev.firefox-unwrapped {
      extraPrefsFiles = [
        "${inputs.palefox}/program/config.generated.js"
        "${inputs.palefox}/program/defaults/pref/config-prefs.js"
      ];
    };
  })
];
```

The bootstrap refuses to load any chrome JS/CSS whose SHA-256 doesn't
match the manifest baked into `config.generated.js` at palefox build time.
Local-mode malware can't inject privileged code without `sudo` (or write
access to the Nix store). See
[docs/dev/sandbox-research.md](dev/sandbox-research.md) for the full
threat model.

**Personal customization** is not supported on this branch — the bootstrap
rejects unknown `.uc.js`/`.uc.css` files in the watched directories. Add
your own scripts/styles by forking palefox and rebuilding with your files
in the source tree, or use the
[`css-legacy`](https://github.com/tompassarelli/palefox/tree/css-legacy)
branch (CSS-only, no loader, no hash gate, supports `extraConfig`).
