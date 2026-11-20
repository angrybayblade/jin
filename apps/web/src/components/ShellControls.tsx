"use client";
import { ChevronLeft, ChevronRight, Menu, PanelLeftClose, PanelLeftOpen, Rows2, Rows3, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { applyLayout, PHONE_QUERY, readLayout, setDensity, updateLayout, type Density } from "@/lib/layout";
import { isPhone, setDrawer, useDrawer, usePhone } from "@/lib/phone";

const inEditorOrTerminal = (t: EventTarget | null) => t instanceof Element && Boolean(t.closest(".xterm, .monaco-editor, textarea, input"));

/**
 * Collapse the sidebar (also Cmd/Ctrl+B outside the terminal and editor). On a phone there is no
 * rail: the same button opens and closes the sidebar as a drawer over the page.
 */
export function SidebarToggle({ shortcut = true }: { shortcut?: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const phone = usePhone();
  const drawer = useDrawer();
  useEffect(() => {
    const sync = () => setCollapsed(Boolean(readLayout().sidebarCollapsed));
    sync();
    window.addEventListener("jin-layout", sync);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b" && !inEditorOrTerminal(e.target)) {
        e.preventDefault();
        if (isPhone()) setDrawer(!document.documentElement.dataset.drawer);
        else updateLayout((l) => ({ ...l, sidebarCollapsed: !l.sidebarCollapsed }));
      }
    };
    // Crossing the phone breakpoint: the rail applies again (or not), and the drawer closes.
    const mq = window.matchMedia(PHONE_QUERY);
    const crossed = () => {
      applyLayout(readLayout());
      setDrawer(false);
    };
    // One toggle owns ⌘B and the breakpoint (there is a second one while the sidebar is collapsed).
    if (shortcut) {
      window.addEventListener("keydown", key);
      mq.addEventListener("change", crossed);
    }
    return () => {
      window.removeEventListener("jin-layout", sync);
      window.removeEventListener("keydown", key);
      mq.removeEventListener("change", crossed);
    };
  }, [shortcut]);
  if (phone)
    return (
      <button type="button" className="button quiet icon-only drawer-toggle" onClick={() => setDrawer(!drawer)} title={drawer ? "Close the menu" : "Open the menu"} aria-label={drawer ? "Close the menu" : "Open the menu"} aria-expanded={drawer}>
        {drawer ? <X size={18} /> : <Menu size={18} />}
      </button>
    );
  return (
    <button
      type="button"
      className="button quiet icon-only"
      onClick={() => updateLayout((l) => ({ ...l, sidebarCollapsed: !l.sidebarCollapsed }))}
      title={collapsed ? "Expand the sidebar (⌘B)" : "Collapse the sidebar (⌘B)"}
      aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
    >
      {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
    </button>
  );
}

/** Compact (smaller text, tighter rows) or comfortable density. */
export function DensityToggle() {
  const [density, set] = useState<Density>("compact");
  useEffect(() => set(document.documentElement.dataset.density === "comfortable" ? "comfortable" : "compact"), []);
  const next: Density = density === "compact" ? "comfortable" : "compact";
  const Icon = density === "compact" ? Rows3 : Rows2;
  return (
    <button
      type="button"
      className="button quiet icon-only"
      onClick={() => {
        setDensity(next);
        set(next);
      }}
      title={`Density: ${density} (click for ${next})`}
      aria-label={`Density: ${density}`}
    >
      <Icon size={14} />
    </button>
  );
}

/** Drag the sidebar's edge to resize it (double-click resets). */
export function SidebarResizer() {
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const root = document.documentElement;
    const clamp = (x: number) => Math.round(Math.min(Math.max(x, 216), 380));
    const move = (ev: PointerEvent) => root.style.setProperty("--sidebar-w", `${clamp(ev.clientX)}px`);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      updateLayout((l) => ({ ...l, sidebarW: clamp(ev.clientX), sidebarCollapsed: false }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" onPointerDown={start} onDoubleClick={() => updateLayout((l) => ({ ...l, sidebarW: undefined }))} />;
}

/** Back and forward through jin's pages (the desktop window has no browser buttons). */
export function HistoryButtons() {
  const router = useRouter();
  return (
    <span className="history-buttons">
      <button type="button" className="button quiet icon-only" onClick={() => router.back()} title="Back (⌘[)" aria-label="Back">
        <ChevronLeft size={15} />
      </button>
      <button type="button" className="button quiet icon-only" onClick={() => router.forward()} title="Forward (⌘])" aria-label="Forward">
        <ChevronRight size={15} />
      </button>
    </span>
  );
}
