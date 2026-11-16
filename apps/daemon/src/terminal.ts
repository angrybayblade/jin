import type { ServerWebSocket, Subprocess } from "bun";

export type TerminalSocket = ServerWebSocket<{ type: "terminal"; cwd: string; cols: number; rows: number; proc?: Subprocess }>;

/**
 * The user's own shell in a task's directory, over a websocket (xterm.js in the browser).
 * This is the user typing, not an agent, so jin's agent policy does not apply; access is
 * the daemon's loopback-only listener plus a one-time ticket. Bun provides the PTY.
 *
 * Client messages: {"t":"in","d":"..."} for keystrokes, {"t":"resize","cols":n,"rows":n}.
 * Server messages: raw terminal output.
 */
export const terminalHandlers = {
  open(ws: TerminalSocket) {
    const shell = process.env.SHELL || "/bin/bash";
    const proc = Bun.spawn([shell, "-l"], {
      cwd: ws.data.cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      terminal: {
        cols: ws.data.cols,
        rows: ws.data.rows,
        data: (_t, data) => ws.send(data),
      },
    });
    ws.data.proc = proc;
    void proc.exited.then(() => ws.close(1000, "shell exited"));
  },
  message(ws: TerminalSocket, raw: string | Buffer) {
    let msg: { t?: string; d?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const term = ws.data.proc?.terminal;
    if (!term) return;
    if (msg.t === "in" && typeof msg.d === "string") term.write(msg.d);
    else if (msg.t === "resize" && msg.cols && msg.rows) term.resize(Math.max(2, Math.min(500, msg.cols)), Math.max(2, Math.min(200, msg.rows)));
  },
  close(ws: TerminalSocket) {
    ws.data.proc?.kill();
  },
};
