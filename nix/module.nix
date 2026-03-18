flakeSelf:

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.fennec;

  chromeDir = ".mozilla/firefox/${cfg.profile}/chrome";

  # Generate userChrome.css entry point with @import statements
  userChromeContent = ''
    /* ==========================================================================
       FENNEC — Entry Point (Managed by Home Manager)
       ==========================================================================

       ⚠️  This file is managed by Home Manager.
       To customize: set programs.fennec.extraConfig or edit userOverrides.css

       ========================================================================== */

    /* Core theme (always enabled) */
    @import url("fennec.css");

    /* Optional modules */
    ${lib.optionalString cfg.autohide ''@import url("autohide.css");''}

    /* User imports from config */
    ${lib.concatMapStrings (imp: "@import url(\"${imp}\");\n") cfg.userChromeImports}

    /* User customizations (persistent) */
    @import url("userOverrides.css");
  '';

  # Generate userOverrides.css with user's custom CSS
  userOverridesContent = ''
    /* ==========================================================================
       USER OVERRIDES — Managed by Home Manager
       ==========================================================================

       Your custom CSS below. This file persists across Fennec updates.

       ========================================================================== */

    ${cfg.extraConfig}
  '';
in
{
  options.programs.fennec = {
    enable = lib.mkEnableOption "Fennec Firefox theme";

    profile = lib.mkOption {
      type = lib.types.str;
      default = "default-release";
      description = "Firefox profile name to install Fennec into.";
    };

    autohide = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Enable the autohide module (sidebar collapses when mouse leaves).";
    };

    sideberry = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Install the Sideberry extension via NUR. Requires NUR in your flake inputs.";
    };

    extraConfig = lib.mkOption {
      type = lib.types.lines;
      default = "";
      description = "Extra CSS to append to userOverrides.css";
    };

    userChromeImports = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = "Additional @import statements for userChrome.css";
    };
  };

  config = lib.mkIf cfg.enable {
    # Configure Firefox preferences (but don't inject userChrome)
    programs.firefox = {
      enable = true;
      profiles.${cfg.profile} = {
        settings = {
          "toolkit.legacyUserProfileCustomizations.stylesheets" = true;
          "sidebar.verticalTabs" = false;
          "sidebar.revamp" = false;
        };
        # NOTE: Not setting .userChrome here — we manage chrome/ files directly
      };
    };

    # Copy core theme file (always)
    home.file."${chromeDir}/fennec.css" = {
      source = "${flakeSelf}/chrome/fennec.css";
    };

    # Copy optional autohide module (only if enabled)
    home.file."${chromeDir}/autohide.css" = lib.mkIf cfg.autohide {
      source = "${flakeSelf}/chrome/autohide.css";
    };

    # Generate userChrome.css entry point
    home.file."${chromeDir}/userChrome.css" = {
      text = userChromeContent;
    };

    # Generate userOverrides.css with user customizations
    home.file."${chromeDir}/userOverrides.css" = {
      text = userOverridesContent;
    };

    # Install Sideberry via NUR if enabled
    home.packages = lib.mkIf cfg.sideberry (
      lib.optional (pkgs ? nur) pkgs.nur.repos.rycee.firefox-addons.sideberry
    );
  };

  meta.maintainers = [ "tompassarelli" ];
}
