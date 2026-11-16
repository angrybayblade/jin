"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Two-step confirmation in place of window.confirm(), which the desktop shell's WebKit view
 * answers "cancel" without showing anything. The first ask() arms an id for a few seconds
 * (the caller shows "Close?"); asking again for the same id confirms.
 */
export function useArmedConfirm(ms = 4000): { armed: string | null; ask: (id: string) => boolean; disarm: () => void } {
  const [armed, setArmed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const disarm = useCallback(() => {
    clearTimeout(timer.current);
    setArmed(null);
  }, []);
  const ask = useCallback(
    (id: string) => {
      if (armed === id) {
        disarm();
        return true;
      }
      clearTimeout(timer.current);
      setArmed(id);
      timer.current = setTimeout(() => setArmed(null), ms);
      return false;
    },
    [armed, disarm, ms],
  );
  return { armed, ask, disarm };
}
