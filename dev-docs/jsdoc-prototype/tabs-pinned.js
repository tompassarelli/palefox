// @ts-check
//
// JSDoc + interface/implementation prototype.
//
// Open this file in VSCode (or any editor with TS server) to see what
// the experience would feel like at the file level:
//   - hover any identifier for inline docs
//   - autocomplete on `td.<TAB>` shows TreeData fields
//   - type errors show inline (try setting `td.parentId = "oops"`)
//   - jump-to-definition on a typedef is one keystroke
//
// `// @ts-check` at the top opts this file into TypeScript's checker.
// Nothing about the runtime changes — the JSDoc comments are just comments.

// =============================================================================
// INTERFACE
// =============================================================================
//
// The "interface" section is what a caller of this module needs to know:
// the types it produces/consumes and the functions it exports. The bodies
// live below in IMPLEMENTATION; you can read this section in isolation to
// understand the module's contract without paging through ~3000 lines.

/**
 * Per-tab tree metadata. Lives in a WeakMap keyed by the native Firefox tab.
 * Every palefox tab row has exactly one TreeData attached to its tab.
 *
 * @typedef {Object} TreeData
 * @property {number}      id        Stable palefox tab ID, persisted across sessions.
 * @property {number|null} parentId  ID of the parent tab, or null if root/pinned.
 * @property {string|null} name      Custom rename label, or null to use the page title.
 * @property {string|null} state     Tag like "child" or "sibling"; informational.
 * @property {boolean}     collapsed Whether this row's subtree is collapsed in the UI.
 */

/**
 * A native Firefox `<tab>` element. Augmented at runtime with palefox state
 * via WeakMaps (treeOf, rowOf) — the actual DOM type doesn't change.
 *
 * @typedef {XULElement & { pinned: boolean, label: string, selected: boolean,
 *                          owner?: Tab, linkedBrowser?: any }} Tab
 */

/**
 * A palefox row element representing either a tab or a group header.
 * Discriminated by which of `_tab` / `_group` is set.
 *
 * @typedef {XULElement & { _tab?: Tab, _group?: Group }} Row
 */

/**
 * A user-defined group header sitting between rows in the tree.
 *
 * @typedef {Object} Group
 * @property {string}  id
 * @property {"group"} type
 * @property {string}  name
 * @property {number}  level
 * @property {string|null}  state
 * @property {boolean} collapsed
 */

/**
 * Public surface of this module. Returned by `init()`; nothing else escapes.
 *
 * @typedef {Object} PinnedTabsAPI
 * @property {(tab: Tab) => void} onTabPinned
 * @property {(tab: Tab) => void} onTabUnpinned
 * @property {(tab: Tab, row: Row) => boolean} placeRowInFirefoxOrder
 * @property {(tab: Tab) => boolean} isFxPinned
 */


// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Wire pinned-tab event handling and return the public API.
 *
 * @param {Object} deps
 * @param {HTMLElement} deps.pinnedContainer  Where pinned rows live.
 * @param {HTMLElement} deps.panel            Where unpinned rows live.
 * @param {WeakMap<Tab, Row>} deps.rowOf      Tab → row lookup.
 * @param {WeakMap<Tab, TreeData>} deps.treeOf  Tab → tree metadata.
 * @param {() => Iterable<Row>} deps.allRows
 * @param {(row: Row) => void} deps.syncAnyRow
 * @param {(tab: Tab) => void} deps.syncTabRow
 * @param {() => void} deps.scheduleSave
 * @param {() => void} deps.updateVisibility
 * @returns {PinnedTabsAPI}
 */
function initPinnedTabs(deps) {
  const { pinnedContainer, panel, rowOf, treeOf,
          allRows, syncAnyRow, syncTabRow,
          scheduleSave, updateVisibility } = deps;

  /** @param {Tab} tab @returns {TreeData} */
  function treeData(tab) {
    const td = treeOf.get(tab);
    if (!td) throw new Error("treeData: no entry for tab — should be impossible");
    return td;
  }

  /**
   * True iff Firefox considers this tab pinned right now. During pinTab(),
   * the tab is moved into pinnedTabsContainer BEFORE the `pinned` attribute
   * is set (and TabMove fires inside that window) — so tab.pinned alone
   * isn't enough to classify it.
   *
   * @param {Tab} tab
   * @returns {boolean}
   */
  function isFxPinned(tab) {
    if (tab.pinned) return true;
    // @ts-ignore — gBrowser is a chrome global, no .d.ts here
    const ptc = gBrowser.tabContainer?.pinnedTabsContainer
              // @ts-ignore
              || gBrowser.pinnedTabsContainer;
    return !!ptc && tab.parentNode === ptc;
  }

  /**
   * Move a row to the DOM position matching the tab's index in gBrowser.tabs.
   * Pinned and unpinned tabs live in separate containers (pinnedContainer
   * vs panel), so we anchor only against same-pinned-state siblings.
   *
   * @param {Tab} tab
   * @param {Row} row
   * @returns {boolean}  true if the row was moved; false if already in place.
   */
  function placeRowInFirefoxOrder(tab, row) {
    if (!row || !panel) return false;
    // @ts-ignore
    const tabsArr = /** @type {Tab[]} */ ([...gBrowser.tabs]);
    const myIdx = tabsArr.indexOf(tab);
    if (myIdx < 0) return false;

    if (isFxPinned(tab)) {
      let prevTab = null;
      for (let i = myIdx - 1; i >= 0; i--) {
        if (isFxPinned(tabsArr[i])) { prevTab = tabsArr[i]; break; }
      }
      if (prevTab) {
        const prevRow = rowOf.get(prevTab);
        if (!prevRow || prevRow === row) return false;
        if (prevRow.nextElementSibling !== row) { prevRow.after(row); return true; }
      } else if (pinnedContainer.firstChild !== row) {
        pinnedContainer.insertBefore(row, pinnedContainer.firstChild);
        return true;
      }
      return false;
    }

    let prevTab = null;
    for (let i = myIdx - 1; i >= 0; i--) {
      if (!isFxPinned(tabsArr[i])) { prevTab = tabsArr[i]; break; }
    }
    if (prevTab) {
      const prevRow = rowOf.get(prevTab);
      if (!prevRow || prevRow === row) return false;
      if (prevRow.nextElementSibling !== row) { prevRow.after(row); return true; }
    } else if (panel.firstChild !== row) {
      panel.insertBefore(row, panel.firstChild);
      return true;
    }
    return false;
  }

  /** @param {Tab} tab */
  function onTabPinned(tab) {
    const row = rowOf.get(tab);
    if (!row || !pinnedContainer) return;

    const td = treeData(tab);
    const pinnedId = td.id;
    td.parentId = null;
    // Pinned tabs can't have children — promote any direct kids to root.
    // @ts-ignore
    for (const t of /** @type {Tab[]} */ ([...gBrowser.tabs])) {
      if (treeData(t).parentId === pinnedId) treeData(t).parentId = null;
    }

    row.removeAttribute("style");
    if (row.parentNode !== pinnedContainer) {
      pinnedContainer.appendChild(row);
      placeRowInFirefoxOrder(tab, row);
    }
    pinnedContainer.hidden = false;
    syncTabRow(tab);
    for (const r of allRows()) syncAnyRow(r);
    updateVisibility();
    scheduleSave();
  }

  /** @param {Tab} tab */
  function onTabUnpinned(tab) {
    const row = rowOf.get(tab);
    if (!row) return;
    if (row.parentNode !== panel) {
      // TabMove fires before TabUnpinned and (with the pinned-aware
      // placeRowInFirefoxOrder) already places the row in panel. This
      // path catches the case where it didn't.
      placeRowInFirefoxOrder(tab, row);
    }
    syncTabRow(tab);
    if (!pinnedContainer.querySelector(".pfx-tab-row")) {
      pinnedContainer.hidden = true;
    }
    updateVisibility();
    scheduleSave();
  }

  return { onTabPinned, onTabUnpinned, placeRowInFirefoxOrder, isFxPinned };
}

// `module.exports` keeps the file checkable as a module without affecting
// the .uc.js loader (this file is in dev-docs and never loaded at runtime).
// @ts-ignore
if (typeof module !== "undefined") module.exports = { initPinnedTabs };
