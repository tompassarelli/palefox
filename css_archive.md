# Archive

Archive of CSS code that's not currently in use but might be useful later.

## Hidden Security Lock Icon

Hide the padlock if not hovered and only if site is secure. `.mixedContentBlocked` could be worth surfacing for warnings, but `.notSecure` is always concerning so we surface that.

```css
#identity-box:not(.notSecure) {
  opacity: 1;
  transform: translateX(0);
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

#urlbar:not(:hover) #identity-box:not(.notSecure) {
  opacity: 0;
  transform: translateX(-20px);
  pointer-events: none;
  width: 0px;
}
```

## Identity Icon Label

The DOM component this selector targets will show "Not Secure" if the connection is not secure.

```css
#identity-icon-label {
  /* Styling for identity icon label */
}
```

## Extension Page Identity

Shows "Sideberry" if on extension page, not strictly needed.

```css
#identity-box.extensionPage #identity-icon-label {
  display: none;
}
```

## Dynamic Notification Space

Dynamically create space for notifications - increase `::before` height if notifications are live.

```css
body:has(#notifications-toolbar) {
  #sidebar-box::before {
    height: 300px;
  }
}
```

## Divider Below Header

aesthetically, after testing, leaning towards no bar pref
fennec header divider when lwtheme is NOT present

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
