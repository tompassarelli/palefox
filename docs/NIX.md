# Nix / Home Manager

Fennec can be installed declaratively via a Home Manager module — this handles CSS, prefs, and Sideberry in one step.

1. Add fennec to your flake inputs:
```nix
inputs.fennec.url = "github:tompassarelli/fennec";
```

2. Import the module in your Home Manager config:
```nix
imports = [ inputs.fennec.homeManagerModules.default ];
```

3. Enable it:
```nix
programs.fennec = {
  enable = true;
  profile = "your-profile-name";  # optional, defaults to "default-release"
  autohide = false;               # optional
  extraConfig = ''                # optional, appended to user/user.css
    :root { --fen-gap-x: 12px; }
  '';
};
```

4. Rebuild with `nixos-rebuild switch` or `home-manager switch`

> Note: Sideberry is installed automatically via [NUR](https://github.com/nix-community/NUR). Ensure NUR is in your flake inputs and overlays. Set `sideberry = false` if you manage extensions separately.
