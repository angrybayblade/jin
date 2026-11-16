"use client";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { terminalTicket } from "@/app/actions";

const THEME = {
  background: "#1b1a1e",
  foreground: "#e6e4ea",
  cursor: "#e7a35a",
  selectionBackground: "#3a2a1a",
  black: "#141316",
  red: "#e0715e",
  green: "#9fd3a8",
  yellow: "#f0c36d",
  blue: "#9fb3d6",
  magenta: "#d39bb4",
  cyan: "#8fcac4",
  white: "#ecebef",
};

/** The user's shell in the task directory: xterm.js here, a PTY in the daemon. */
export function TerminalView({ taskId, wsBase, active }: { taskId: string; wsBase: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let cleanup = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !host.current) return;
      const term = new Terminal({ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13, cursorBlink: true, theme: THEME, allowProposedApi: false, scrollback: 5000 });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host.current);
      fit.fit();
      const ticket = await terminalTicket();
      if (disposed) return term.dispose();
      ws = new WebSocket(`${wsBase}/api/terminal?task=${encodeURIComponent(taskId)}&ticket=${ticket}&cols=${term.cols}&rows=${term.rows}`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => setStatus("open");
      ws.onclose = () => setStatus("closed");
      ws.onmessage = (m) => term.write(typeof m.data === "string" ? m.data : new Uint8Array(m.data as ArrayBuffer));
      const input = term.onData((d) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "in", d })));
      const resize = () => {
        fit.fit();
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      };
      fitRef.current = resize;
      const observer = new ResizeObserver(resize);
      observer.observe(host.current);
      cleanup = () => {
        observer.disconnect();
        input.dispose();
        term.dispose();
      };
    })();
    return () => {
      disposed = true;
      ws?.close();
      cleanup();
    };
  }, [taskId, wsBase]);

  // Fit again when the tab becomes visible (it was measured while hidden).
  useEffect(() => {
    if (active) requestAnimationFrame(() => fitRef.current?.());
  }, [active]);

  return (
    <div className="terminal-view">
      <div ref={host} className="terminal-host" />
      {status === "closed" && <div className="terminal-status">Shell exited. Switch tabs to start a new one.</div>}
    </div>
  );
}
