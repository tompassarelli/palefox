flakeSelf:

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.fennec;

  chromeDir = ".mozilla/firefox/${cfg.profile}/chrome";

  userChromeContent = lib.concatStringsSep "\n" (
    [ ''/* fennec — entry point (managed by Home Manager)''
      '' *''
      '' * Toggle features in about:config (type "fennec." to see all options):''
      '' *   fennec.sidebar.autohide — auto-collapse sidebar when mouse leaves''
      '' *''
      '' * To customize: set programs.fennec.extraConfig in your nix config,''
      '' * or edit user/user.css directly.''
      '' */''
      ""
      ''@import url("fennec/fennec.css");''
    ]
    ++ map (imp: ''@import url("${imp}");'') cfg.userChromeImports
    ++ [ ''@import url("user/user.css");'' ]
  );

  userCssContent = ''
    /* user overrides — managed by Home Manager (programs.fennec.extraConfig) */
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
      description = "Auto-collapse sidebar when mouse leaves (sets fennec.sidebar.autohide in about:config).";
    };

    floatingUrlbar = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Float urlbar centered on viewport when focused (sets fennec.urlbar.float in about:config).";
    };

    sideberry = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Install the Sideberry extension via NUR. Requires NUR in your flake inputs.";
    };

    extraConfig = lib.mkOption {
      type = lib.types.lines;
      default = "";
      description = "Extra CSS appended to user/user.css.";
    };

    userChromeImports = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = "Additional @import URLs for userChrome.css.";
    };
  };

  config = lib.mkIf cfg.enable {
    programs.firefox = {
      enable = true;
      profiles.${cfg.profile} = {
        settings = {
          "toolkit.legacyUserProfileCustomizations.stylesheets" = true;
          "sidebar.verticalTabs" = false;
          "sidebar.revamp" = false;
          "sidebar.position_start" = true;
          "fennec.sidebar.autohide" = cfg.autohide;
          "fennec.urlbar.float" = cfg.floatingUrlbar;
        };
        extensions = lib.mkIf cfg.sideberry {
          packages = [
            pkgs.nur.repos.rycee.firefox-addons.sidebery
          ];
        };
      };
    };

    home.file."${chromeDir}/fennec/fennec.css" = {
      source = "${flakeSelf}/chrome/fennec/fennec.css";
    };

    home.file."${chromeDir}/userChrome.css" = {
      text = userChromeContent;
    };

    home.file."${chromeDir}/user/user.css" = {
      text = userCssContent;
    };
  };
}
