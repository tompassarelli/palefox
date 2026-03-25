# Features & Options

## Autohide (off by default)

Sidebar must be enabled (not toggled off). When enabled, the drawer auto-collapses when the mouse leaves and reappears when hovering the left edge of the window.

To enable:
1. Go to `about:config` in the address bar
2. Set `fennec.drawer.autohide` to `true`
3. Restart Firefox

## Floating Urlbar (off by default)

When enabled, the urlbar detaches from the sidebar and floats centered on the viewport when focused — like a spotlight/command palette. A "Searching..." placeholder stays in the sidebar.

To enable:
1. Go to `about:config` in the address bar
2. Set `fennec.urlbar.float` to `true`
3. Restart Firefox

## Accessibility

Fennec respects your OS "reduce motion" setting — all transitions become instant. On Linux you can also set `ui.prefersReducedMotion` to `1` in `about:config`.

## Recommended Extensions

- **[Vimium](https://addons.mozilla.org/en-US/firefox/addon/vimium-ff/)** - Keyboard-driven navigation that complements the minimal, distraction-free interface
- **[New Tab Override](https://addons.mozilla.org/en-US/firefox/addon/new-tab-override/)** - Replace the default new tab page with a custom URL. Point it at a localhost service serving a barebones HTML page (without autofocus on the URL bar) so Vimium keybindings work immediately on new tabs

To get notified about new Fennec releases, [watch the GitHub repository](https://github.com/tompassarelli/fennec) and select "Releases only" under custom notifications.
