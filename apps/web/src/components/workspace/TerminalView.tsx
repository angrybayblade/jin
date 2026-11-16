"use client";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { attachTicket } from "@/app/actions";
import { useResolvedTheme } from "@/lib/theme";

const THEMES = {
  dark: {
    background: "#1b1a1e",
    foreground: "#e6e4ea",
    cursor: "#e7a35a",
    cursorAccent: "#1b1a1e",
    selectionBackground: "#5a3d22",
    black: "#141316",
    red: "#e0715e",
    green: "#9fd3a8",
    yellow: "#f0c36d",
    blue: "#9fb3d6",
    magenta: "#d39bb4",
    cyan: "#8fcac4",
    white: "#ecebef",
    brightBlack: "#66656f",
    brightRed: "#f09a8a",
    brightGreen: "#b6e2bd",
    brightYellow: "#f5d48f",
    brightBlue: "#b9c2d6",
    brightMagenta: "#e2b4c8",
    brightCyan: "#a9dbd5",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#ffffff",
    foreground: "#29272b",
    cursor: "#9d5034",
    cursorAccent: "#ffffff",
    selectionBackground: "#f1d3ae",
    black: "#29272b",
    red: "#a13e28",
    green: "#2f6b3a",
    yellow: "#8a5a12",
    blue: "#3d5a80",
    magenta: "#8e3b6b",
    cyan: "#2c6e6a",
    white: "#b8b7bb",
    brightBlack: "#61626d",
    brightRed: "#c2533a",
    brightGreen: "#3f8a4d",
    brightYellow: "#a8721c",
    brightBlue: "#4f72a0",
    brightMagenta: "#a8507f",
    brightCyan: "#3a8a85",
    brightWhite: "#e5e5e5",
  },
};

export type TerminalState = "connecting" | "attached" | "detached" | "exited";

/**
 * A daemon-owned terminal in xterm.js. Detaching (reload, tab switch) leaves the process
 * running; re-attaching replays its screen. Tuned for full-screen TUIs like Claude Code:
 * WebGL rendering, Unicode 11 widths, OSC 52 clipboard, clickable links, Shift+Enter as a
 * newline, Cmd/Ctrl+C copies a selection.
 */
export function TerminalView({
  terminalId,
  wsBase,
  active,
  onState,
  autoFocus = false,
}: {
  terminalId: string;
  wsBase: string;
  active: boolean;
  onState?: (s: TerminalState) => void;
  autoFocus?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const focusRef = useRef<(() => void) | null>(null);
  const [state, setState] = useState<TerminalState>("connecting");
  const stateRef = useRef(onState);
  stateRef.current = onState;
  const theme = useResolvedTheme(host);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const termRef = useRef<{ options: { theme?: unknown } } | null>(null);

  useEffect(() => {
    const report = (s: TerminalState) => {
      setState(s);
      stateRef.current?.(s);
    };
    let disposed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let cleanup = () => {};

    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebglAddon }, { Unicode11Addon }, { WebLinksAddon }, { ClipboardAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-webgl"),
        import("@xterm/addon-unicode11"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-clipboard"),
      ]);
      if (disposed || !host.current) return;
      const term = new Terminal({
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.1,
        cursorBlink: true,
        theme: THEMES[themeRef.current],
        allowProposedApi: true,
        scrollback: 10000,
        // About what macOS terminals do per wheel notch; ⌥ for long Claude Code output.
        scrollSensitivity: 3,
        fastScrollSensitivity: 10,
        macOptionIsMeta: true,
        drawBoldTextInBrightColors: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener")));
      term.loadAddon(new ClipboardAddon());
      term.open(host.current);
      termRef.current = term;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // DOM renderer fallback
      }
      fit.fit();
      focusRef.current = () => term.focus();
      if (autoFocus) term.focus();

      const send = (d: string) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "in", d }));
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        // Shift+Enter: a newline in Claude Code's prompt (what /terminal-setup configures).
        if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey) {
          send("\x1b\r");
          return false;
        }
        // Copy a selection with Cmd/Ctrl+C; without a selection Ctrl+C still interrupts.
        if (e.key === "c" && (e.metaKey || (e.ctrlKey && e.shiftKey)) && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection());
          return false;
        }
        return true;
      });
      const input = term.onData(send);
      const binary = term.onBinary((d) => send(d));

      const connect = async () => {
        report("connecting");
        let ticket: string;
        try {
          ticket = await attachTicket(terminalId);
        } catch {
          report("exited");
          return;
        }
        if (disposed) return;
        ws = new WebSocket(`${wsBase}/api/terminals/${terminalId}/attach?ticket=${ticket}`);
        ws.binaryType = "arraybuffer";
        let first = true;
        ws.onopen = () => {
          report("attached");
          ws?.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
        };
        ws.onmessage = (m) => {
          // The first message is the whole screen; start clean so a reconnect does not duplicate it.
          if (first) {
            term.reset();
            first = false;
          }
          term.write(typeof m.data === "string" ? m.data : new Uint8Array(m.data as ArrayBuffer));
        };
        ws.onclose = (ev) => {
          if (disposed) return;
          if (ev.code === 1000 || ev.code === 1011 || ev.code === 4404) return report("exited");
          report("detached");
          retry = setTimeout(connect, 1500);
        };
      };
      void connect();

      const resize = () => {
        if (!host.current?.offsetParent) return; // hidden tab
        fit.fit();
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      };
      fitRef.current = resize;
      const observer = new ResizeObserver(resize);
      observer.observe(host.current);
      cleanup = () => {
        observer.disconnect();
        input.dispose();
        binary.dispose();
        term.dispose();
      };
    })();

    return () => {
      disposed = true;
      clearTimeout(retry);
      ws?.close();
      cleanup();
    };
  }, [terminalId, wsBase, autoFocus]);

  // Follow the theme where the terminal sits (the app's, or its pane's override).
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[theme];
  }, [theme]);

  // Fit and focus when the tab becomes visible (it was measured while hidden).
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      fitRef.current?.();
      focusRef.current?.();
    });
  }, [active]);

  return (
    <div className="terminal-view" onClick={() => focusRef.current?.()}>
      <div ref={host} className="terminal-host" />
      {state === "detached" && <div className="terminal-status">Reconnecting…</div>}
    </div>
  );
}
