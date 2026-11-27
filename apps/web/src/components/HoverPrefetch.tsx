"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import { useEffect } from "react";

/** A pointer resting this long on a link is about to click it (one passing over is not). */
const INTENT_MS = 60;
/** How long Next keeps a prefetched page (`staleTimes.static` in next.config.ts): asked again after. */
const KEPT_MS = 30_000;
/** A prefetched copy older than this, once open, is refreshed (the app notices changes every 2 s). */
const FRESH_MS = 2_000;
/** When each chat was fetched ahead. */
const asked = new Map<string, number>();

/**
 * A chat in the sidebar is fetched while the pointer rests on it, so the click finds it there.
 * Chat pages are dynamic: Next does not prefetch them on its own (and doing so for every chat on
 * screen would ask the home for all of them on each refresh). Only chats: Next keeps a prefetched
 * page for 30 s, and a chat that opens from an old copy catches up by itself (its stream starts
 * after the last event it has); a doc or the desk would show the old copy. A chat opened from a
 * copy more than a moment old is refreshed once open (its approvals may have been decided).
 */
export function HoverPrefetch() {
  const router = useRouter();
  const path = usePathname();
  const search = useSearchParams().toString();
  const here = search ? `${path}?${search}` : path;
  useEffect(() => {
    const at = asked.get(here);
    if (at === undefined) return;
    asked.delete(here);
    if (Date.now() - at > FRESH_MS) router.refresh();
  }, [here, router]);
  useEffect(() => {
    let timer: number | undefined;
    let over: HTMLAnchorElement | null = null;
    const onOver = (e: PointerEvent) => {
      const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>(".sidebar a.is-chat[href]") : null;
      if (a === over) return;
      over = a;
      window.clearTimeout(timer);
      if (!a || (a.target && a.target !== "_self")) return;
      const url = new URL(a.href, location.href);
      const href = url.pathname + url.search;
      if (url.origin !== location.origin || href === location.pathname + location.search) return;
      timer = window.setTimeout(() => {
        if ((asked.get(href) ?? 0) > Date.now() - KEPT_MS) return;
        asked.set(href, Date.now());
        router.prefetch(href, { kind: "full" as PrefetchKind });
      }, INTENT_MS);
    };
    document.addEventListener("pointerover", onOver);
    return () => {
      document.removeEventListener("pointerover", onOver);
      window.clearTimeout(timer);
    };
  }, [router]);
  return null;
}
