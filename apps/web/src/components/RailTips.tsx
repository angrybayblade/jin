"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type Tip = { text: string; x: number; y: number };

const ITEM = ".sidebar :is(.nav-item, .sidebar-bottom button, .sidebar-bottom a, .sidebar-top button)";

/** What a rail item is: its label (hidden in the rail), else its own title or aria-label. */
function textOf(el: Element): string {
  const label = el.querySelector(".nav-label")?.textContent?.replace(/\s+/g, " ").trim();
  return label || el.getAttribute("data-rail-title") || el.getAttribute("aria-label") || "";
}

/**
 * The collapsed sidebar shows only icons: hovering one shows its name to the right, at once,
 * in place of the system tooltips (which name the status mark, not the item).
 */
export function RailTips() {
  const [tip, setTip] = useState<Tip | null>(null);
  useEffect(() => {
    let current: Element | null = null;
    // The system tooltips inside the item would show too: their titles step aside while hovered.
    const stash = (el: Element) =>
      [el, ...el.querySelectorAll("[title]")].forEach((n) => {
        const t = n.getAttribute("title");
        if (t === null) return;
        n.setAttribute("data-rail-title", t);
        n.removeAttribute("title");
      });
    const restore = (el: Element) =>
      [el, ...el.querySelectorAll("[data-rail-title]")].forEach((n) => {
        const t = n.getAttribute("data-rail-title");
        if (t === null) return;
        n.setAttribute("title", t);
        n.removeAttribute("data-rail-title");
      });
    const leave = () => {
      if (current) restore(current);
      current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      const el = document.documentElement.dataset.sidebar === "collapsed" && e.target instanceof Element ? e.target.closest(ITEM) : null;
      if (el === current) return;
      leave();
      if (!el) return;
      stash(el);
      const text = textOf(el);
      if (!text) return restore(el);
      current = el;
      const r = el.getBoundingClientRect();
      const side = document.querySelector(".sidebar")?.getBoundingClientRect().right ?? r.right;
      setTip({ text, x: side + 6, y: r.top + r.height / 2 });
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerdown", leave);
    window.addEventListener("blur", leave);
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      leave();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerdown", leave);
      window.removeEventListener("blur", leave);
      document.documentElement.removeEventListener("pointerleave", leave);
    };
  }, []);
  if (!tip) return null;
  // On the body: the sidebar's own layer sits under the panes.
  return createPortal(
    <div className="rail-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.text}
    </div>,
    document.body,
  );
}
