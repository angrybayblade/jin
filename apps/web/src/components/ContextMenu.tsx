"use client";
import { act } from "@/lib/notices";
import type { LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

export type MenuItem =
  | {
      label: string;
      icon?: LucideIcon;
      hint?: string;
      /** A failure (thrown, or a server action's `{ error }`) is shown as a notice, with a retry. */
      run: () => unknown;
      /** Destructive: shown in red, and asks in place ("Remove task?") before running. */
      danger?: boolean;
      confirm?: string;
      disabled?: boolean;
    }
  | { divider: true }
  | { header: string };

interface Open {
  x: number;
  y: number;
  items: MenuItem[];
  /** Open upwards: y is where the menu's bottom edge goes (for buttons at the bottom of the window). */
  above?: boolean;
}

let current: Open | null = null;
const listeners = new Set<() => void>();
const set = (v: Open | null) => {
  current = v;
  for (const l of listeners) l();
};

/** Open a context menu at the pointer (or under an element for keyboard use). */
export function openContextMenu(e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[], opts: { above?: boolean } = {}) {
  e.preventDefault?.();
  e.stopPropagation?.();
  set({ x: e.clientX, y: e.clientY, items, above: opts.above });
}

/** onContextMenu handler for an element: right-click (or Shift+F10 / the menu key) opens `items()`. */
export function contextMenu(items: () => MenuItem[]) {
  return {
    onContextMenu: (e: React.MouseEvent) => openContextMenu(e, items()),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openContextMenu({ clientX: r.left + 8, clientY: r.bottom, preventDefault: () => e.preventDefault() }, items());
      }
    },
  };
}

/**
 * The one context menu, mounted once in the shell (Zero's menu: white surface, thin
 * perimeter, compact rows). Escape, outside click, scroll or a window resize dismiss it.
 */
export function ContextMenuHost() {
  const open = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [active, setActive] = useState(-1);

  useLayoutEffect(() => {
    setArmed(null);
    setActive(-1);
    if (!open || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    const top = open.above ? Math.max(8, open.y - r.height) : Math.min(open.y, window.innerHeight - r.height - 8);
    setPos({ left: Math.min(open.x, window.innerWidth - r.width - 8), top });
  }, [open]);

  // Focus once it is placed and visible (a hidden element cannot take focus).
  useEffect(() => {
    if (open && pos) ref.current?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => set(null);
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) dismiss();
    };
    // Escape closes it wherever focus is.
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
      }
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);

  if (!open) return null;
  const actionable = open.items.map((it, i) => ("run" in it && !it.disabled ? i : -1)).filter((i) => i >= 0);

  const choose = (i: number) => {
    const it = open.items[i];
    if (!it || !("run" in it) || it.disabled) return;
    if (it.danger && armed !== i) {
      setArmed(i); // destructive: the second click runs it
      return;
    }
    set(null);
    void act(`Couldn't ${it.label.replace(/…$/, "").replace(/^\w/, (c) => c.toLowerCase())}`, async () => it.run());
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const at = actionable.indexOf(active);
      const next = e.key === "ArrowDown" ? actionable[(at + 1) % actionable.length] : actionable[(at - 1 + actionable.length) % actionable.length];
      setActive(next ?? -1);
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      choose(active);
    }
  };

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
      style={pos ? { left: pos.left, top: pos.top } : { left: open.x, top: open.y, visibility: "hidden" }}
    >
      {open.items.map((it, i) => {
        if ("divider" in it) return <div key={i} className="context-divider" role="separator" />;
        if ("header" in it) return <div key={i} className="context-header">{it.header}</div>;
        const Icon = it.icon;
        const isArmed = armed === i;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`context-item ${it.danger ? "is-danger" : ""} ${isArmed ? "is-armed" : ""} ${active === i ? "is-active" : ""}`}
            disabled={it.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(i)}
          >
            <span className="context-icon">{Icon ? <Icon size={14} /> : null}</span>
            <span className="context-label">{isArmed ? (it.confirm ?? `${it.label}?`) : it.label}</span>
            {it.hint && !isArmed && <span className="context-hint">{it.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
