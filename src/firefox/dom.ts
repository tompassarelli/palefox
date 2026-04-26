// Firefox DOM adapter — typed XUL element factories.
//
// Manifest entry: "createXULElement" (Tier 0, rock-stable).
// XUL tag set is finite and stable; this wraps document.createXULElement
// to give us proper return types (HTMLElement) and a tighter API.
//
// Centralizing here also gives the canary a single owner for any future
// XUL-tag rename or removal in the upstream codebase.

// =============================================================================
// INTERFACE
// =============================================================================

/** XUL tags palefox actually uses. Add new tags as needed; the runtime
 *  call accepts any string but the type ensures we don't typo. */
export type XULTag =
  | "label"
  | "hbox"
  | "vbox"
  | "box"
  | "image"
  | "menupopup"
  | "menuitem"
  | "menu"
  | "menuseparator"
  | "toolbar"
  | "toolbarbutton"
  | "stack";

/** Optional attribute map applied to the new element. Values that are
 *  `false`/`null`/`undefined` are skipped (so callers can do
 *  `{ disabled: someFlag && "true" }` without runtime guards). */
export type XULAttrs = Record<string, string | number | boolean | null | undefined>;

export function xul<T extends HTMLElement = HTMLElement>(tag: XULTag, attrs?: XULAttrs): T {
  const el = document.createXULElement(tag) as T;
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      el.setAttribute(name, String(value));
    }
  }
  return el;
}

// Convenience aliases for the highest-traffic tags. These keep call
// sites readable without importing the full xul() function everywhere.
export const xulLabel = (attrs?: XULAttrs): HTMLElement => xul("label", attrs);
export const xulHbox = (attrs?: XULAttrs): HTMLElement => xul("hbox", attrs);
export const xulVbox = (attrs?: XULAttrs): HTMLElement => xul("vbox", attrs);
export const xulBox = (attrs?: XULAttrs): HTMLElement => xul("box", attrs);
export const xulImage = (attrs?: XULAttrs): HTMLElement => xul("image", attrs);
export const xulMenuPopup = (attrs?: XULAttrs): HTMLElement => xul("menupopup", attrs);
export const xulMenuItem = (attrs?: XULAttrs): HTMLElement => xul("menuitem", attrs);
export const xulMenuSeparator = (attrs?: XULAttrs): HTMLElement => xul("menuseparator", attrs);
