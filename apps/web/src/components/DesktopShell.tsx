"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

declare global {
  interface Window {
    __electrobunSendToHost?: (message: unknown) => void;
  }
}

const TITLE_BAR = ".pane-header, .sidebar-top";
const CONTROL = "button, a, input, select, textarea, [role='tab'], [role='button'], .rename-input";

/** A link to leave jin for: another site (http/https), not one of jin's own pages. */
export function isExternal(href: string, origin = location.origin): boolean {
  try {
    const u = new URL(href, origin);
    return (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") && u.origin !== origin;
  } catch {
    return false;
  }
}

/**
 * jin's desktop window draws its own title bar. Double-clicking an empty part of it zooms the
 * window, as in any Mac app (the window does it, following the system setting); in full screen
 * the room kept for the window buttons closes up.
 */
export function DesktopShell() {
  const router = useRouter();
  useEffect(() => {
    const root = document.documentElement;
    if (root.dataset.shell !== "desktop") return;
    const onDouble = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t?.closest(TITLE_BAR) || t.closest(CONTROL)) return;
      window.__electrobunSendToHost?.({ type: "jin:title-bar-double-click" });
    };
    // Full screen: the window has the whole screen (the shell also says so directly).
    const onResize = () => root.toggleAttribute("data-fullscreen", window.innerWidth >= screen.width && window.innerHeight >= screen.height);
    onResize();
    // The window is not a browser: links to other sites, and new windows, go to your default browser.
    const openExternal = (url: string) => window.__electrobunSendToHost?.({ type: "jin:open-external", url });
    const nativeOpen = window.open;
    // jin's own pages open here: the window has no tabs, and they are not for the browser.
    const here = (href: string) => {
      const u = new URL(href, location.origin);
      router.push(`${u.pathname}${u.search}${u.hash}`);
    };
    window.open = ((url?: string | URL) => {
      const href = url ? String(url) : "";
      if (href && isExternal(href)) openExternal(new URL(href, location.origin).href);
      else if (href) here(href);
      return null;
    }) as typeof window.open;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement)) return;
      if (!isExternal(a.href)) {
        // ⌘-, Ctrl-, Shift- or middle-click would ask for a new window, which the window hands to
        // the browser: jin's own pages open here instead (a plain click is the link's own).
        if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) || a.hasAttribute("download")) return;
        e.preventDefault();
        e.stopPropagation();
        here(a.href);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      openExternal(a.href);
    };
    // The collapsed sidebar asks the window to put its buttons away (the expand button takes their place).
    let shown: boolean | null = null;
    const syncButtons = () => {
      const visible = root.dataset.sidebar !== "collapsed";
      if (visible === shown) return;
      shown = visible;
      window.__electrobunSendToHost?.({ type: "jin:window-buttons", visible });
    };
    syncButtons();
    const watch = new MutationObserver(syncButtons);
    watch.observe(root, { attributes: true, attributeFilter: ["data-sidebar"] });
    document.addEventListener("dblclick", onDouble);
    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onClick, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("dblclick", onDouble);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("auxclick", onClick, true);
      window.removeEventListener("resize", onResize);
      window.open = nativeOpen;
      watch.disconnect();
    };
  }, [router]);
  return null;
}
