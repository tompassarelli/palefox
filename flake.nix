{
  description = "Fennec — modular, sidebar-first Firefox userChrome.css setup";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils"; # Optional but recommended
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        homeManagerModules.default = import ./nix/module.nix { inherit pkgs self; };
        homeManagerModules.fennec = import ./nix/module.nix { inherit pkgs self; };

        # Optional: packages for direct installation
        packages.default = pkgs.callPackage ./nix/package.nix { src = self; };
      }
    );
}
