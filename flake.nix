{
  description = "Palefox — minimal Firefox userChrome setup";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs, ... }: {
    homeManagerModules.default = import ./nix/module.nix self;
    homeManagerModules.palefox = import ./nix/module.nix self;
  };
}
