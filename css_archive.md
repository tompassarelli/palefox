# 🗄️ CSS Archive

> ⚠️ **Inactive Code Repository**
> Snippets below are **not** part of the active Fennec build. They're preserved for reference, experimentation, or future re-enablement.

| Status          | Meaning                                           |
| --------------- | ------------------------------------------------- |
| 🧪 Experimental | Untested or proof-of-concept code                 |
| 🗑️ Deprecated   | Removed due to bugs, conflicts, or design changes |
| 💡 Optional     | Works, but not part of default UX philosophy      |
| 🔍 Debug        | Useful for troubleshooting, not for production    |

---

## 🔐 Hidden Security Lock Icon

**Status:** 🗑️ Deprecated
**Reason:** Hiding security indicators contradicts Fennec's "security-aware minimalism" principle. The custom HTTP alert is preferred.
**Last Tested:** Firefox 128

Hide the padlock icon when not hovered, but only for secure connections.

```css
/* Show lock by default */
#identity-box:not(.notSecure) {
  opacity: 1;
  transform: translateX(0);
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

/* Hide on urlbar blur + not hovered */
#urlbar:not(:hover) #identity-box:not(.notSecure) {
  opacity: 0;
  transform: translateX(-20px);
  pointer-events: none;
  width: 0;
}
```

> ⚠️ **Warning**: `.mixedContentBlocked` and `.notSecure` states should **never** be hidden — they're critical security signals.

---

## 🏷️ Identity Icon Label Styling

**Status:** 💡 Optional
**Reason:** Visual preference; default Firefox behavior is sufficient for most users.
**Last Tested:** Firefox 127

The `#identity-icon-label` element displays connection status text like "Not Secure".

```css
#identity-icon-label {
  /* Example: subtle styling for status text */
  font-size: 0.9em;
  color: var(--toolbar-color);
  margin-left: 4px;
}
```

**Use case**: Customize label appearance if you want finer control over security text presentation.

---

## 🧩 Extension Page Identity

**Status:** 🗑️ Deprecated
**Reason:** Redundant — Sideberry and other extensions already display their name in the UI.
**Last Tested:** Firefox 126

Hide the "Sideberry" label that appears in the identity box when on an extension page.

```css
#identity-box.extensionPage #identity-icon-label {
  display: none;
}
```

**Alternative**: Keep it visible for clarity when debugging extension contexts.

---

## 🔔 Dynamic Notification Space

**Status:** 🧪 Experimental
**Reason**: Conflicts with `::before` spacer logic; better handled via container queries in the future.
**Last Tested**: Firefox 125

Dynamically expand the sidebar's top spacer when notifications are active.

```css
body:has(#notifications-toolbar) {
  #sidebar-box::before {
    height: 300px; /* Adjust based on notification height */
  }
}
```

**Potential fix**: Use CSS container queries or JS to calculate exact notification height instead of hardcoded `300px`.

---

## ➖ Divider Below Header

**Status:** 💡 Optional
**Reason**: Aesthetic preference — Fennec defaults to a borderless header for a cleaner look.
**Last Tested**: Firefox 128

Add a subtle divider line below the header when no lightweight theme (`lwtheme`) is active.

```css
:root:not([lwtheme]) .sidebar-browser-stack::before {
  content: "";
  position: fixed;
  top: var(--fen-header-height);
  width: calc(100% - var(--fen-gap-x));
  height: 1px;
  background-color: var(--toolbarbutton-icon-fill);
  opacity: 0.3 !important;
  pointer-events: none;
  box-sizing: border-box;
}
```

**Tip**: Increase `opacity` or change `background-color` to match your theme's accent.

---

## 📋 How to Re-Enable Archived Code

1. Copy the desired snippet into `userOverrides.css`
2. Place it **after** the main Fennec rules (to override defaults)
3. Restart Firefox or reload styles via `Ctrl+Shift+R` (with `devtools.chrome.enabled = true`)
4. Test thoroughly — archived code may conflict with future updates

> 💡 **Pro Tip**: Use CSS comments to tag re-enabled snippets:
>
> ```css
> /* [ARCHIVE-REENABLED] Hidden lock icon — 2026-03 */
> ```

---

## 🔄 Archive Maintenance

- **Before archiving**: Add a comment explaining _why_ the code was removed
- **Include**: Firefox version tested, known conflicts, and potential use cases
- **Review quarterly**: Delete snippets that are broken beyond repair or no longer relevant
