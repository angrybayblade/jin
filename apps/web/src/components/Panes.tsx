"use client";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { readLayout, updateLayout } from "@/lib/layout";

export type PhonePane = "left" | "right";

/**
 * A page's two panes with a draggable divider (double-click resets it) and a button to hide
 * or show the right pane. The split and visibility are remembered per page (`id`).
 *
 * On a phone (globals.css, max-width 760px) only one pane shows, at full height, with a
 * switcher between the two (`labels`). A page with its own switcher passes `phone` and
 * `onPhone` and `phoneSwitch={false}`.
 */
export function Panes({
  id,
  defaultSplit,
  minLeft = 320,
  minRight = 280,
  left,
  right,
  toggle: showToggle = true,
  labels = ["Main", "Side"],
  phone: phoneControlled,
  onPhone,
  phoneSwitch = true,
}: {
  id: string;
  defaultSplit: number;
  minLeft?: number;
  minRight?: number;
  left: ReactNode;
  right: ReactNode;
  /** false when the page has its own show/hide control */
  toggle?: boolean;
  /** The phone switcher's names for the left and right panes. */
  labels?: [string, string];
  /** The pane shown on a phone, when the page decides it. */
  phone?: PhonePane;
  onPhone?: (p: PhonePane) => void;
  /** false when the page draws its own phone switcher */
  phoneSwitch?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);
  const [phoneOwn, setPhoneOwn] = useState<PhonePane>("left");
  const phone = phoneControlled ?? phoneOwn;
  const showPhone = (p: PhonePane) => (onPhone ? onPhone(p) : setPhoneOwn(p));
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
      {phoneSwitch && (
        <div className="phone-switch" role="tablist" aria-label="Panes">
          {(["left", "right"] as const).map((p, i) => (
            <button key={p} type="button" role="tab" aria-selected={phone === p} className={phone === p ? "is-active" : ""} onClick={() => showPhone(p)}>
              {labels[i]}
            </button>
          ))}
        </div>
      )}
      <div className="pane-slot" data-phone={phone === "left" ? "shown" : undefined}>
        {left}
      </div>
      <div className="splitter" role="separator" aria-orientation="vertical" aria-label="Resize panes" onPointerDown={startDrag} onDoubleClick={reset} hidden={hidden}>
        <span className="splitter-line" />
      </div>
      {showToggle && <button type="button" className="aside-toggle" onClick={toggle} title={hidden ? "Show the side pane" : "Hide the side pane"} aria-label={hidden ? "Show the side pane" : "Hide the side pane"}>
        {hidden ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
      </button>}
      <div className="pane-slot" hidden={hidden} data-phone={phone === "right" ? "shown" : undefined}>
        {right}
      </div>
    </div>
  );
}
