"use client";
import { useEffect, useRef } from "react";

export interface TabShortcuts {
  /** ⌘T: a new tab (a Claude Code session in a task, a chat elsewhere). */
  create: () => void;
  /** ⌘W: close the open tab, as its × does (asking first where × asks). */
  close: () => void;
  /** ⌘1–⌘8: that tab; ⌘9: the last one, as in a browser. */
  select: (index: number) => void;
  count: number;
}

/**
 * A tab bar's keyboard shortcuts. They work in the desktop window, where ⌘T and ⌘W reach the
 * page; a browser keeps those two for its own tabs. Listened for before the terminal and the
 * editor see the keys, so they work with either focused.
 */
export function useTabShortcuts(s: TabShortcuts) {
  const ref = useRef(s);
  ref.current = s;
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      // A dialog or the palette owns the keyboard while it is open.
      if (document.querySelector(".palette, dialog[open]")) return;
      const k = e.key.toLowerCase();
      const cur = ref.current;
      if (k === "t") cur.create();
      else if (k === "w") cur.close();
      else if (/^[1-9]$/.test(k) && cur.count > 0) cur.select(k === "9" ? cur.count - 1 : Math.min(Number(k) - 1, cur.count - 1));
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", down, true);
    return () => window.removeEventListener("keydown", down, true);
  }, []);
}
