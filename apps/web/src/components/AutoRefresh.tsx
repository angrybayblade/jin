"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the server components every few seconds while the tab is visible. */
export function AutoRefresh({ every = 3000 }: { every?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) router.refresh();
    };
    const timer = setInterval(tick, every);
    return () => clearInterval(timer);
  }, [router, every]);
  return null;
}
