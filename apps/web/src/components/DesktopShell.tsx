"use client";
import { useEffect } from "react";

declare global {
  interface Window {
    __electrobunSendToHost?: (message: unknown) => void;
  }
}

const TITLE_BAR = ".pane-header, .sidebar-top";
const CONTROL = "button, a, input, select, textarea, [role='tab'], [role='button'], .rename-input";

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
    document.addEventListener("dblclick", onDouble);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("dblclick", onDouble);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return null;
}
