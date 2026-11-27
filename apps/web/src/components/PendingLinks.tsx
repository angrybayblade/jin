"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/** A page that comes within this long needs no mark (a delay under it reads as instant). */
const MARK_AFTER_MS = 50;
let marking: number | undefined;
let unmarking: number | undefined;

const clear = () => {
  window.clearTimeout(marking);
  window.clearTimeout(unmarking);
  document.querySelectorAll("[data-pending]").forEach((el) => el.removeAttribute("data-pending"));
};

/**
 * A clicked link looks chosen (`data-pending`) while its page is on the way: a page from the home
 * is a round trip away, and the old one stays until then. Plain DOM, no render, and only once the
 * wait is noticeable: in the desktop app's WebKit a render or a restyle on every click made the
 * quick pages (a task here, already prefetched) slower to show.
 */
export function PendingLinks() {
  const path = usePathname();
  const search = useSearchParams().toString();
  // The page changed: whatever was on its way is here.
  useEffect(clear, [path, search]);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname + url.search === location.pathname + location.search) return;
      clear();
      const from = location.href;
      // Still on the old page then (the address changes as the new one is shown).
      marking = window.setTimeout(() => location.href === from && a.setAttribute("data-pending", ""), MARK_AFTER_MS);
      // A navigation that never lands (it failed, or went elsewhere) does not leave it marked.
      unmarking = window.setTimeout(clear, 10_000);
    };
    // Capture: a <Link> stops the browser's own navigation in its click handler.
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      clear();
    };
  }, []);
  return null;
}
