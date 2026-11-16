"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { changeStamp } from "@/app/actions";

/**
 * Re-renders the server components when what they show changes: a cheap fingerprint from the
 * daemons every `every` ms, while the tab is visible; and in full every 30s regardless, for
 * anything the fingerprint does not cover.
 */
export function AutoRefresh({ every = 2000 }: { every?: number }) {
  const router = useRouter();
  useEffect(() => {
    let last: string | null = null;
    let lastFull = Date.now();
    let busy = false;
    const tick = async () => {
      if (document.hidden || busy) return;
      busy = true;
      try {
        const stamp = await changeStamp().catch(() => null);
        const due = Date.now() - lastFull > 30_000;
        if ((stamp && last !== null && stamp !== last) || due) {
          router.refresh();
          lastFull = Date.now();
        }
        if (stamp) last = stamp;
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), every);
    const onVisible = () => !document.hidden && router.refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, every]);
  return null;
}
