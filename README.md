# Fennec
A customized Mozilla Firefox experience designed around minimalism and optimized vertical tab support. Achieved through userChrome.css modifications and cohesive extension integrations.

| Sidebar Open | Zen Mode |
|:---:|:---:|
| ![Fennec with sidebar](fennec.webp) | ![Fennec without sidebar](fennec-no-sidebar.webp) |

## Features

🔗 **Enhanced Sideberry Integration** - Urlbar inside the sidebar-box, tracks sidebar width, and expands when focused

🧘 **Zen Mode** - Toggling the sidebar hides the UI, maximizing screen space and aiding focus when tiled or maximized

✨ **Minimal Chrome** - Only essential objects exposed, coherent with a keyboard driven UX

🛠️ **Community Minded** - Clean code and detailed docs to support customization and contribution

🎨 **Theme Support** - System themes (light-dark) supported. User created Firefox themes are also supported.

## Installation

Note: Please see [security considerations](#security-considerations) before installing

1. Install [Sideberry extension](https://addons.mozilla.org/en-US/firefox/addon/sidebery/)
2. Set Firefox's Browser Layout to Fennec's supported configuration
   - Goto settings in firefox
   - In search bar, type "hori" (searching for horizontal tabs)
     - You should now see "Browser Layout" in the search results
   - Enable "Horizontal Tabs" if it is not enabled
   - "Show Sidebar" is off 
     - not supported (just use hotkeys to switch to history/bookmarks/gpt as desired)
   - Sidebar is configured to appear on left side (browser default)
3. Add CSS
   - Enable firefox to be able to use userChrome.css
     - `toolkit.legacyUserProfileCustomizations.stylesheets` in `about:config`
   - Navigate to your profile directory
      - Note: on the Flatpak version of Firefox the profile directory is `~/.var/app/org.mozilla.firefox/.mozilla/firefox/<profile>`
      - Open Firefox
      - Type `about:support` in the address bar and press enter
      - Look for the Application Basics section.
      - Click on Open Profile Folder. This will open the folder which contains your user data.
   - Add a chrome folder and userChrome.css
      - Now create a `chrome` folder in your profile folder if it doesn't exist
      - Copy `userChrome.css` to the `chrome` folder, from this repo's chrome folder
   - (Optional but suggested) Insert sideberry.css from this repo in the sideberry custom css settings
      - Right click on sideberry extension and open settings, or in the extension menu select the gear icon
      - Scroll down the settings section until the end, you should see "Styles Editor" tab on the left hand side, second to last option
      - There is a code area on the right hand of the screen, paste css code in there
4. Restart Firefox

### Optional Recommended Extensions
- **[Vimium](https://addons.mozilla.org/en-US/firefox/addon/vimium-ff/)** - Keyboard-driven navigation that complements the minimal, distraction-free interface

## Optional Features

### Hover Reveal (off by default)
When the sidebar is hidden (zen mode), hovering the left edge of the screen reveals the drawer temporarily. Moving the mouse away hides it again.

To enable: uncomment the `hover-reveal` region in `userChrome.css` (remove the `/*` and `*/` comment markers around the block). Restart Firefox.

> **Note:** The close is instant rather than animated due to a Firefox limitation where CSS transitions are not triggered by `:has()` selector changes.

## Usage Guide

Sideberry is used for tabs, toggling the extension shortcut set to sideberry toggles the whole UI.
This also applies to: history, bookmarks, etc. shortcuts

💬 **[Discussions](https://github.com/tompassarelli/fennec-ui/discussions)** - ask questions, share setups, and connect with other users

📝 **[Release Notes](https://github.com/tompassarelli/fennec-ui/wiki/Release-Notes)** - version history and changelog

🛤️ **[Roadmap](https://github.com/tompassarelli/fennec-ui/wiki/Roadmap)** - planned features and development timeline

👾 **[Known Issues & Troubleshooting](https://github.com/tompassarelli/fennec-ui/wiki/Troubleshooting)** - noted some common issues and workarounds 

## Security Considerations

- The install guide directs users to download Firefox extensions. Firefox extensions can introduce security vulnerabilities and/or take direct hostile actions against users. 
- Zen Mode hides the UI which obviously suppresses security signals like padlock warnings. In appreciation of this concern, Fennec will still attempt to surface a custom HTTP Not Secure security warning prepended to page content as a header alert. Not a solution against phishing and other attacks/vulnerabilities, only toggle the UI after the page has been verified as secure and trustworthy.
- **Use at your own risk** - The author is not liable for any security issues, data breaches, or other damages of usage of this repository or mentioned extensions.
- **You are responsible** for verifying the security of websites, code, and extensions used
- Always keep Firefox updated

**By using this theme and mentioned Firefox extensions, you acknowledge these risks and agree that the author bears no responsibility for any consequences.**
