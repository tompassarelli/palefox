// Tunables shared across tabs/* modules. Pure values, no behavior — keep this
// file free of imports beyond literals so any module can pull from it.

/** Pixels per nesting level used for tab-row inline padding. */
export const INDENT = 14;

/** Filename (under the profile directory) for the persisted tab tree. */
export const SAVE_FILE = "palefox-tab-tree.json";

/** Window in ms to complete a chord like `dd` or `gg`. */
export const CHORD_TIMEOUT = 500;

/** How many recently-closed tabs we remember for hierarchy restore on Ctrl+Shift+T. */
export const CLOSED_MEMORY = 32;

/** SessionStore-persisted XUL attribute holding each tab's stable palefox ID. */
export const PIN_ATTR = "pfx-id";
