flakeSelf:

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.palefox;

  chromeDir = ".mozilla/firefox/${cfg.profile}/chrome";
in
{
  options.programs.palefox = {
    enable = lib.mkEnableOption "Palefox Firefox theme";

    profile = lib.mkOption {
      type = lib.types.str;
      default = "default-release";
      description = "Firefox profile name to install Palefox into.";
    };

    jsLoader = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Enable the palefox hash-pinned JavaScript + CSS loader. Deploys
        profile-side files (chrome/utils/, chrome/JS/, chrome/CSS/) automatically.
        The install-dir bootstrap (program/config.generated.js + config-prefs.js)
        must be set up separately at the NixOS level — see docs/install.md for
        the system-config snippet. The bootstrap refuses to load any chrome
        JS/CSS whose SHA-256 doesn't match the manifest baked in at palefox
        build time, closing the local-write attack vector that vanilla
        fx-autoconfig leaves open.
      '';
    };

    autohide = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Auto-collapse sidebar when mouse leaves (sets pfx.drawer.autohide in about:config).";
    };

    floatingUrlbar = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Float urlbar centered on viewport when focused (sets pfx.urlbar.float in about:config).";
    };

    sideberry = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Install the Sideberry extension via NUR. Requires NUR in your flake inputs.";
    };
  };

  config = lib.mkIf cfg.enable {
    programs.firefox = {
      enable = true;
      profiles.${cfg.profile} = {
        settings = {
          # Legacy stylesheets pref OFF — palefox CSS loads via the
          # hash-pinned loader's chrome:// CSS registration, NOT through
          # Firefox's direct userChrome.css load. Keeping it true would
          # leave the (unhashed) userChrome.css path open as an attack
          # surface for local-mode malware.
          "toolkit.legacyUserProfileCustomizations.stylesheets" = false;
          # fx-autoconfig loader gate — required for the autoconfig
          # bootstrap chain to actually load palefox JS and CSS.
          "userChromeJS.enabled" = true;
          "sidebar.verticalTabs" = false;
          "sidebar.revamp" = false;
          "sidebar.position_start" = true;
          "pfx.drawer.autohide" = cfg.autohide;
          "pfx.urlbar.float" = cfg.floatingUrlbar;
        };
        extensions = lib.mkIf cfg.sideberry {
          packages = [
            pkgs.nur.repos.rycee.firefox-addons.sidebery
          ];
        };
      };
    };

    # CSS — every file under chrome/CSS/ is hashed by the bootstrap, so
    # the deployed files must match the source tree exactly. Use `recursive`
    # so future palefox-*.uc.css additions land here without module edits.
    home.file."${chromeDir}/CSS" = {
      source = "${flakeSelf}/chrome/CSS";
      recursive = true;
    };

    # fx-autoconfig loader (profile side) — only deployed when jsLoader is
    # set, since the matching install-root bootstrap also has to be set up.
    home.file."${chromeDir}/utils" = lib.mkIf cfg.jsLoader {
      source = "${flakeSelf}/chrome/utils";
      recursive = true;
    };

    # Built JS scripts — depend on `bun run build` having been run inside
    # the flake source tree. Same hash-matching constraint as CSS.
    home.file."${chromeDir}/JS" = lib.mkIf cfg.jsLoader {
      source = "${flakeSelf}/chrome/JS";
      recursive = true;
    };
  };
}
