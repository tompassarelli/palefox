// fzf-style picker overlay — used by :tabs / :history / :sessions / :restore
// and the action sub-menu (Tab on a highlighted row).
//
// Extracted from vim.ts during M7.1. The picker is a self-contained UI
// primitive: one chrome-window-singleton overlay element, one entry point
// (`show`), one isActive() probe used by other keymap handlers to bail.
//
// Tree-preserving filter (`preserveTree`): when set, items matching the
// query are joined by their `parentId`-walked ancestors so the tree
// context isn't lost. Ancestors that are NOT direct matches get the
// `[pfx-picker-context]` attribute for dim styling.
//
// Visual layout, top to bottom:
//   ┌──────────────────────────┐
//   │ ›  filter…               │  ← input row
//   ├──────────────────────────┤
//   │ • match (highlighted)    │
//   │   match                  │
//   │   ↳ context (dim)        │
//   │   match                  │
//   └──────────────────────────┘

// =============================================================================
// INTERFACE
// =============================================================================

export interface PickerItem {
  /** Primary text. Substring filter (case-insensitive) runs against this. */
  readonly display: string;
  /** Optional dim subtitle — URL/hostname/timestamp/etc. */
  readonly secondary?: string;
  /** Optional icon URL (favicon) or single emoji. */
  readonly icon?: string;
  /** Indent depth for tree-preserving rendering. 0 = root. */
  readonly depth?: number;
  /** Stable id linking children to their parent in tree-preserving mode. */
  readonly id?: string | number;
  /** Parent id (matches another item's `id`). */
  readonly parentId?: string | number | null;
  /** Pass-through for action callbacks. */
  readonly data: unknown;
}

/** Optional menu of secondary actions a picker can offer per row.
 *  Triggered via Tab on the selected row → opens a sub-picker. */
export interface PickerAction {
  readonly label: string;
  /** Single-letter shortcut shown next to the label. */
  readonly key?: string;
  /** Run against the originally-selected picker item's data. */
  readonly run: (item: PickerItem) => unknown;
}

export type PickerShowOpts = {
  readonly items: readonly PickerItem[];
  readonly onSelect: (item: PickerItem) => unknown;
  readonly prompt?: string;
  readonly actions?: readonly PickerAction[];
  readonly preserveTree?: boolean;
};

export type PickerDeps = {
  /** Called on dismiss to restore focus to the previously-active surface
   *  (typically the vim panel or document body). */
  readonly restoreFocus: () => void;
  /** Show a transient inline message — used for action.run failures. */
  readonly modelineMsg: (text: string, durationMs?: number) => void;
};

export type PickerAPI = {
  /** Open the picker. Idempotent — calling while already open replaces
   *  the contents and resets selection. */
  show(opts: PickerShowOpts): void;
  /** True while the picker is visible. Used by other keymap handlers
   *  to bail (so palefox keys don't compete with the picker's input). */
  isActive(): boolean;
  /** Force-close the picker without committing. */
  dismiss(): void;
  /** Tear down the picker DOM + listeners. Call from window.unload. */
  destroy(): void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makePicker(deps: PickerDeps): PickerAPI {
  let pickerEl: HTMLElement | null = null;
  let pickerInput: HTMLInputElement | null = null;
  let pickerList: HTMLElement | null = null;
  let active = false;
  let items: readonly PickerItem[] = [];
  let filtered: PickerItem[] = [];
  let selectedIdx = 0;
  let onSelect: ((item: PickerItem) => unknown) | null = null;
  let actions: readonly PickerAction[] = [];
  /** When true, filter walks parents of matched items so tree context is
   *  preserved (rendered as `[pfx-picker-context]` rows). */
  let preserveTree = false;

  // Esc anywhere dismisses an active picker. The input-level listener only
  // fires when the input has focus — clicking outside the input (or focus
  // shifting on a long task) leaves Esc orphaned. Capture-phase document
  // listener catches it regardless of where focus is.
  function onDocKeydown(e: KeyboardEvent): void {
    if (!active) return;
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    dismiss();
  }
  document.addEventListener("keydown", onDocKeydown, true);

  // Click-outside also dismisses — matches typical spotlight UX.
  function onDocMouseDown(e: MouseEvent): void {
    if (!active || !pickerEl) return;
    const t = e.target as Node | null;
    if (t && pickerEl.contains(t)) return;
    dismiss();
  }
  document.addEventListener("mousedown", onDocMouseDown, true);

  /** Build the picker DOM lazily. After build it lives in the chrome doc
   *  (display:none) and gets reused on each show. Use locals while building
   *  and assign to the closure vars at the end — TS doesn't narrow
   *  closure-scoped `let` across method calls, but narrows locals fine. */
  function ensureBuilt(): void {
    if (pickerEl) return;
    const xul = (tag: string): HTMLElement =>
      (document as Document & { createXULElement(t: string): HTMLElement }).createXULElement(tag);

    const root = xul("vbox");
    root.id = "pfx-picker";
    root.hidden = true;
    root.setAttribute("aria-modal", "true");

    // Input field at top.
    const inputBox = xul("hbox");
    inputBox.className = "pfx-picker-input-box";
    const prompt = xul("label");
    prompt.className = "pfx-picker-prompt";
    prompt.setAttribute("value", "›");
    const input = document.createElement("input");
    input.className = "pfx-picker-input";
    input.placeholder = "Filter…";
    inputBox.append(prompt, input);

    // Scrollable list below.
    const list = xul("vbox");
    list.className = "pfx-picker-list";

    root.append(inputBox, list);
    document.documentElement.appendChild(root);

    pickerEl = root;
    pickerInput = input;
    pickerList = list;

    // Filter on input. Two modes:
    //   - Flat: substring match on display + secondary.
    //   - Tree-preserving: matched items + all their ancestors stay
    //     visible, in original tree order. Ancestors that aren't direct
    //     matches get the `[pfx-picker-context]` flag for dim styling.
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      filtered = computeFiltered(items, q);
      selectedIdx = 0;
      renderList();
    });

    // Keys (capture phase so we win against vim handler).
    input.addEventListener("keydown", (e) => {
      if (!active) return;
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          e.stopImmediatePropagation();
          dismiss();
          return;
        case "Enter":
          e.preventDefault();
          e.stopImmediatePropagation();
          commit();
          return;
        case "Tab":
          if (actions.length > 0) {
            e.preventDefault();
            e.stopImmediatePropagation();
            openActionMenu();
            return;
          }
          break;
        case "ArrowDown":
          e.preventDefault();
          e.stopImmediatePropagation();
          moveSelection(1);
          return;
        case "ArrowUp":
          e.preventDefault();
          e.stopImmediatePropagation();
          moveSelection(-1);
          return;
        // Ctrl+J / Ctrl+K (and Ctrl+N / Ctrl+P) for vim-flavored navigation
        // without leaving the input field. Plain j/k would conflict with
        // typing the filter.
        case "j":
          if (e.ctrlKey) { e.preventDefault(); e.stopImmediatePropagation(); moveSelection(1); return; }
          break;
        case "k":
          if (e.ctrlKey) { e.preventDefault(); e.stopImmediatePropagation(); moveSelection(-1); return; }
          break;
        case "n":
          if (e.ctrlKey) { e.preventDefault(); e.stopImmediatePropagation(); moveSelection(1); return; }
          break;
        case "p":
          if (e.ctrlKey) { e.preventDefault(); e.stopImmediatePropagation(); moveSelection(-1); return; }
          break;
      }
    }, true);
  }

  /** Compute the filtered items list. Flat: substring match against display
   *  + secondary. Tree mode: matched items + all their ancestors stay
   *  visible in original tree order; ancestors that aren't direct matches
   *  get marked context (rendered dimmer). */
  function computeFiltered(allItems: readonly PickerItem[], q: string): PickerItem[] {
    if (!q) return [...allItems];
    const matchedSet = new Set<PickerItem>();
    for (const it of allItems) {
      const hay = ((it.display ?? "") + " " + (it.secondary ?? "")).toLowerCase();
      if (hay.includes(q)) matchedSet.add(it);
    }
    if (!preserveTree) {
      return allItems.filter((it) => matchedSet.has(it));
    }
    const byId = new Map<string | number, PickerItem>();
    for (const it of allItems) {
      if (it.id != null) byId.set(it.id, it);
    }
    const visible = new Set<PickerItem>(matchedSet);
    for (const m of matchedSet) {
      let cur: PickerItem | undefined = m;
      while (cur && cur.parentId != null) {
        const p = byId.get(cur.parentId);
        if (!p || visible.has(p)) break;
        visible.add(p);
        cur = p;
      }
    }
    return allItems.filter((it) => visible.has(it));
  }

  /** True if the item, given the current filter query, is a direct match
   *  (vs an ancestor included as tree context). */
  function isDirectMatch(item: PickerItem, q: string): boolean {
    if (!q) return true;
    const hay = ((item.display ?? "") + " " + (item.secondary ?? "")).toLowerCase();
    return hay.includes(q);
  }

  function renderList(): void {
    if (!pickerList) return;
    while (pickerList.firstChild) pickerList.firstChild.remove();
    if (!filtered.length) {
      const empty = (document as Document & { createXULElement(t: string): HTMLElement }).createXULElement("label");
      empty.className = "pfx-picker-empty";
      empty.setAttribute("value", "(no matches)");
      pickerList.appendChild(empty);
      return;
    }
    const q = pickerInput?.value?.trim().toLowerCase() ?? "";
    filtered.forEach((item, idx) => {
      const row = (document as Document & { createXULElement(t: string): HTMLElement }).createXULElement("hbox");
      row.className = "pfx-picker-row";
      if (idx === selectedIdx) row.setAttribute("pfx-picker-selected", "true");
      // In tree-preserving mode, items visible only because they're an ancestor
      // of a match get a context flag for dimmer styling.
      if (preserveTree && q && !isDirectMatch(item, q)) {
        row.setAttribute("pfx-picker-context", "true");
      }
      // Indent: each level adds 14px (matches palefox's INDENT constant).
      // setProperty(..., "important") wins against the row's CSS
      // `padding: 6px 14px !important` rule. Plain inline-style assignment
      // loses to a CSS !important.
      if (item.depth) {
        row.style.setProperty(
          "padding-left",
          `${14 + (item.depth * 14)}px`,
          "important",
        );
      }

      // Icon column.
      if (item.icon) {
        if (/^https?:|^data:|^chrome:|^moz-/.test(item.icon)) {
          const img = document.createElement("img");
          img.className = "pfx-picker-icon";
          img.src = item.icon;
          img.alt = "";
          row.appendChild(img);
        } else {
          const ic = (document as Document & { createXULElement(t: string): HTMLElement }).createXULElement("label");
          ic.className = "pfx-picker-icon-text";
          ic.setAttribute("value", item.icon);
          row.appendChild(ic);
        }
      }

      const text = (document as Document & { createXULElement(t: string): HTMLElement }).createXULElement("hbox");
      text.className = "pfx-picker-text";
      text.setAttribute("flex", "1");
      const primary = (document as Document & { createXULElement(t: string): HTMLElement }).createXULElement("label");
      primary.className = "pfx-picker-label";
      primary.setAttribute("value", item.display);
      primary.setAttribute("crop", "end");
      text.appendChild(primary);
      if (item.secondary) {
        const sec = (document as Document & { createXULElement(t: string): HTMLElement }).createXULElement("label");
        sec.className = "pfx-picker-secondary";
        sec.setAttribute("value", item.secondary);
        sec.setAttribute("crop", "end");
        text.appendChild(sec);
      }
      row.appendChild(text);

      row.addEventListener("click", () => {
        selectedIdx = idx;
        commit();
      });
      pickerList!.appendChild(row);
    });
    const selected = pickerList.querySelector("[pfx-picker-selected='true']");
    selected?.scrollIntoView({ block: "nearest" });
  }

  /** Open a sub-picker over the current actions, retaining the outer-picker's
   *  selected item as the action target. Stacks via dismiss-then-show. */
  function openActionMenu(): void {
    const target = filtered[selectedIdx];
    const localActions = actions;
    if (!target || !localActions.length) return;
    dismiss();
    show({
      prompt: `actions ›`,
      items: localActions.map((a) => ({
        display: a.label + (a.key ? `   (${a.key})` : ""),
        data: a,
      })),
      onSelect: (chosen) => {
        const action = chosen.data as PickerAction;
        try { action.run(target); } catch (e) {
          deps.modelineMsg(`action failed: ${(e as Error).message}`, 4000);
        }
      },
    });
  }

  function moveSelection(delta: number): void {
    if (!filtered.length) return;
    selectedIdx = (selectedIdx + delta + filtered.length) % filtered.length;
    renderList();
  }

  function commit(): void {
    // Capture before resetting state. We intentionally do NOT call
    // deps.restoreFocus() here: the onSelect callback may move focus
    // somewhere specific (e.g. another chrome window via window.focus(),
    // which needs the user-gesture token still live). Calling
    // state.panel.focus() first consumes that token and silently
    // breaks cross-window activation on Enter — observed when picking
    // a tab from a different window via `:tabs all` and pressing Enter:
    // restoreFocus stole the gesture, the source-window focus() no-oped.
    if (!active) return;
    const item = filtered[selectedIdx];
    const cb = onSelect;
    active = false;
    onSelect = null;
    actions = [];
    preserveTree = false;
    if (pickerEl) pickerEl.hidden = true;
    if (item && cb) cb(item);
  }

  function dismiss(): void {
    // Esc / click-outside path — user dismissed without committing.
    // Restore focus to the caller's surface so they aren't stranded
    // with focus on a now-hidden picker.
    if (!active) return;
    active = false;
    onSelect = null;
    actions = [];
    preserveTree = false;
    if (pickerEl) pickerEl.hidden = true;
    deps.restoreFocus();
  }

  function show(opts: PickerShowOpts): void {
    ensureBuilt();
    if (!pickerEl || !pickerInput || !pickerList) return;
    items = opts.items;
    selectedIdx = 0;
    onSelect = opts.onSelect;
    actions = opts.actions ?? [];
    preserveTree = !!opts.preserveTree;
    filtered = [...opts.items];
    active = true;

    const promptEl = pickerEl.querySelector(".pfx-picker-prompt");
    if (promptEl && opts.prompt) {
      promptEl.setAttribute("value", opts.prompt);
    } else if (promptEl) {
      promptEl.setAttribute("value", "›");
    }

    pickerInput.value = "";
    renderList();
    pickerEl.hidden = false;
    pickerInput.focus();
  }

  function destroy(): void {
    document.removeEventListener("keydown", onDocKeydown, true);
    document.removeEventListener("mousedown", onDocMouseDown, true);
    dismiss();
    pickerEl?.remove();
    pickerEl = null;
    pickerInput = null;
    pickerList = null;
  }

  return {
    show,
    isActive: () => active,
    dismiss,
    destroy,
  };
}
