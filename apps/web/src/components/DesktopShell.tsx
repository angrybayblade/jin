"use client";
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
    window.open = ((url?: string | URL) => {
      const href = url ? String(url) : "";
      if (href && isExternal(href)) openExternal(new URL(href, location.origin).href);
      return null;
    }) as typeof window.open;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement)) return;
      if (!isExternal(a.href)) return; // jin's own pages stay in the window
      e.preventDefault();
      e.stopPropagation();
      openExternal(a.href);
    };
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
    };
  }, []);
  return null;
}
