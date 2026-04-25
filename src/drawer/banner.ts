// HTTP not-secure warning banner.
//
// Shows a banner above the browser content area after 2 seconds when the
// page is loaded over plain HTTP (and we're on a "real" web page, not
// about:/chrome:/customizing). Hides immediately on a state change to
// secure — covers redirect HTTPS upgrades cleanly.
//
// Source-of-truth signal: #identity-box has class "notSecure" when the
// site is HTTP. We MutationObserver that class attribute, plus listen to
// TabSelect for tab-switching cases.

import { createLogger } from "../tabs/log.ts";

declare const gBrowser: {
  selectedBrowser?: { currentURI?: { spec?: string } };
  tabContainer: { addEventListener(name: string, fn: EventListener): void; removeEventListener(name: string, fn: EventListener): void };
};

// =============================================================================
// INTERFACE
// =============================================================================

export type BannerAPI = {
  /** Tear down listeners + remove the banner element if present. */
  destroy(): void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

const SHOW_DELAY_MS = 2000;

export function makeBanner(): BannerAPI {
  const log = createLogger("drawer/banner");
  const identityBox = document.getElementById("identity-box");
  if (!identityBox) {
    log("init:no-identity-box");
    return { destroy: () => {} };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let banner: HTMLElement | null = null;

  function show(): void {
    if (banner) return;
    const el = (document as Document & { createXULElement(t: string): HTMLElement }).createXULElement("hbox");
    el.id = "pfx-insecure-banner";
    el.setAttribute("align", "center");
    el.setAttribute("pack", "center");
    el.textContent = "🦊 Palefox - HTTP Alert: Not Secure";
    const browserEl = document.getElementById("browser");
    if (!browserEl?.parentNode) {
      log("show:no-browser-parent");
      return;
    }
    browserEl.parentNode.insertBefore(el, browserEl);
    banner = el;
    log("show");
  }

  function hide(): void {
    if (timer) { clearTimeout(timer); timer = null; }
    if (banner) {
      banner.remove();
      banner = null;
      log("hide");
    }
  }

  function check(): void {
    const uri = gBrowser.selectedBrowser?.currentURI?.spec ?? "";
    const isInternal = uri.startsWith("about:") || uri.startsWith("chrome:");
    const isCustomizing = document.documentElement.hasAttribute("customizing");
    const isInsecure = identityBox!.classList.contains("notSecure")
      && !isInternal && !isCustomizing;
    if (isInsecure && !timer && !banner) {
      timer = setTimeout(show, SHOW_DELAY_MS);
    } else if (!isInsecure) {
      hide();
    }
  }

  const classObserver = new MutationObserver(check);
  classObserver.observe(identityBox, {
    attributes: true,
    attributeFilter: ["class"],
  });
  gBrowser.tabContainer.addEventListener("TabSelect", check as EventListener);

  function destroy(): void {
    classObserver.disconnect();
    gBrowser.tabContainer.removeEventListener("TabSelect", check as EventListener);
    hide();
  }

  return { destroy };
}
