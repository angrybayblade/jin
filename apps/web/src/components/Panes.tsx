"use client";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { readLayout, updateLayout } from "@/lib/layout";

/**
 * A page's two panes with a draggable divider (double-click resets it) and a button to hide
 * or show the right pane. The split and visibility are remembered per page (`id`).
 */
export function Panes({ id, defaultSplit, minLeft = 320, minRight = 280, left, right }: { id: string; defaultSplit: number; minLeft?: number; minRight?: number; left: ReactNode; right: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const sync = () => setHidden(Boolean(readLayout().asideHidden?.[id]));
    sync();
    window.addEventListener("jin-layout", sync);
    return () => window.removeEventListener("jin-layout", sync);
  }, [id]);

  const toggle = () => updateLayout((l) => ({ ...l, asideHidden: { ...l.asideHidden, [id]: !l.asideHidden?.[id] } }));

  const startDrag = (e: React.PointerEvent) => {
    const el = box.current;
    if (!el) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const x = Math.min(Math.max(ev.clientX - rect.left, minLeft), rect.width - minRight);
      el.style.setProperty(`--split-${id}`, `${((x / rect.width) * 100).toFixed(2)}%`);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(false);
      const x = Math.min(Math.max(ev.clientX - rect.left, minLeft), rect.width - minRight);
      const pct = Number(((x / rect.width) * 100).toFixed(2));
      el.style.removeProperty(`--split-${id}`);
      updateLayout((l) => ({ ...l, split: { ...l.split, [id]: pct } }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const reset = () =>
    updateLayout((l) => {
      const { [id]: _, ...rest } = l.split ?? {};
      document.documentElement.style.removeProperty(`--split-${id}`);
      return { ...l, split: rest };
    });

  return (
    <div ref={box} className={`panes ${dragging ? "is-dragging" : ""}`} data-panes={id} style={{ ["--split-default" as string]: `${defaultSplit}%` }}>
      <div className="pane-slot">{left}</div>
      <div className="splitter" role="separator" aria-orientation="vertical" aria-label="Resize panes" onPointerDown={startDrag} onDoubleClick={reset} hidden={hidden}>
        <span className="splitter-line" />
      </div>
      <button type="button" className="aside-toggle" onClick={toggle} title={hidden ? "Show the side pane" : "Hide the side pane"} aria-label={hidden ? "Show the side pane" : "Hide the side pane"}>
        {hidden ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
      </button>
      <div className="pane-slot" hidden={hidden}>
        {right}
      </div>
    </div>
  );
}
