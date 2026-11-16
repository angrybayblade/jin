import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as Headless } from "@xterm/headless";
import type { ServerWebSocket, Subprocess } from "bun";
import { randomUUID } from "node:crypto";
import type { WorkspaceConfig } from "./config";
import { body, HttpError, json, type Router } from "./http";
import type { Tasks } from "./tasks";

export type TerminalKind = "shell" | "claude";
/** What a Claude Code terminal is doing, reported by its hooks. */
export type AgentStatus = "starting" | "working" | "waiting" | "idle" | "exited";

export interface TerminalInfo {
  id: string;
  kind: TerminalKind;
  taskId: string | null;
  cwd: string;
  title: string;
  status: AgentStatus;
  exitCode: number | null;
  createdAt: string;
  clients: number;
}

export type AttachSocket = ServerWebSocket<{ type: "attach"; terminalId: string }>;

interface Live {
  info: TerminalInfo;
  proc: Subprocess;
  screen: Headless;
  serializer: SerializeAddon;
  clients: Set<AttachSocket>;
}

const SCROLLBACK = 5000;

/**
 * Terminals owned by the daemon: a shell, or Claude Code's own TUI. They outlive the
 * browser: closing or reloading the page detaches, and re-attaching replays the current
 * screen (a headless xterm keeps it) before streaming live output again. They do not
 * survive a daemon restart.
 *
 * This is the user's own terminal, not an agent run by jin, so jin's agent policy is not
 * applied here; Claude Code started by jin gets jin's rules through its own hooks.
 *
 * Client messages: {"t":"in","d":"..."} keystrokes, {"t":"resize","cols":n,"rows":n}.
 * Server messages: terminal output (the first one is the serialized screen).
 */
export class Terminals {
  private live = new Map<string, Live>();

  list(filter: { taskId?: string } = {}): TerminalInfo[] {
    return [...this.live.values()]
      .map((l) => ({ ...l.info, clients: l.clients.size }))
      .filter((t) => (filter.taskId ? t.taskId === filter.taskId : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): TerminalInfo {
    const l = this.live.get(id);
    if (!l) throw new HttpError(404, `unknown terminal ${id}`);
    return { ...l.info, clients: l.clients.size };
  }

  /** Start a process in a new PTY. `argv` runs through the login shell so PATH matches the user's terminal. */
  start(opts: { kind: TerminalKind; taskId?: string; cwd: string; title: string; argv?: string[]; env?: Record<string, string>; cols?: number; rows?: number }): TerminalInfo {
    const id = randomUUID();
    const cols = clamp(opts.cols ?? 120, 20, 500);
    const rows = clamp(opts.rows ?? 32, 5, 200);
    const shell = process.env.SHELL || "/bin/bash";
    // `exec "$@"` hands the arguments over without a second round of shell parsing.
    const command = opts.argv?.length ? [shell, "-l", "-c", 'exec "$@"', "jin", ...opts.argv] : [shell, "-l"];
    const screen = new Headless({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer as never);

    const info: TerminalInfo = {
      id,
      kind: opts.kind,
      taskId: opts.taskId ?? null,
      cwd: opts.cwd,
      title: opts.title,
      status: opts.kind === "claude" ? "starting" : "idle",
      exitCode: null,
      createdAt: new Date().toISOString(),
      clients: 0,
    };
    const clients = new Set<AttachSocket>();
    const proc = Bun.spawn(command, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, TERM: "xterm-256color", COLORTERM: "truecolor", JIN_TERMINAL_ID: id },
      terminal: {
        cols,
        rows,
        data: (_t, data) => {
          screen.write(data);
          for (const ws of clients) ws.send(data);
        },
      },
    });
    void proc.exited.then((code) => {
      info.status = "exited";
      info.exitCode = code;
      const note = `\r\n\x1b[2m[${opts.kind === "claude" ? "Claude Code" : "shell"} exited${code ? ` with ${code}` : ""}]\x1b[0m\r\n`;
      screen.write(note);
      for (const ws of clients) ws.send(note);
    });
    this.live.set(id, { info, proc, screen, serializer, clients });
    return this.get(id);
  }

  /** Hooks from Claude Code report what it is doing. */
  setStatus(id: string, status: AgentStatus) {
    const l = this.live.get(id);
    if (l && l.info.status !== "exited") l.info.status = status;
  }

  kill(id: string) {
    const l = this.live.get(id);
    if (!l) throw new HttpError(404, `unknown terminal ${id}`);
    l.proc.kill();
    for (const ws of l.clients) ws.close(1000, "terminal closed");
    l.screen.dispose();
    this.live.delete(id);
  }

  killAll() {
    for (const id of [...this.live.keys()]) this.kill(id);
  }

  // ---------------------------------------------------------------- websocket attach

  attach(ws: AttachSocket) {
    const l = this.live.get(ws.data.terminalId);
    if (!l) return ws.close(1011, "unknown terminal");
    // Replay the current screen, then stream. Serializing and subscribing in the same tick
    // means no output is lost or sent twice.
    const snapshot = l.serializer.serialize({ scrollback: SCROLLBACK });
    if (snapshot) ws.send(snapshot);
    l.clients.add(ws);
  }

  message(ws: AttachSocket, raw: string | Buffer) {
    const l = this.live.get(ws.data.terminalId);
    const term = l?.proc.terminal;
    if (!l || !term || l.info.status === "exited") return;
    let msg: { t?: string; d?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.t === "in" && typeof msg.d === "string") term.write(msg.d);
    else if (msg.t === "resize" && msg.cols && msg.rows) {
      // The most recent viewer sets the size, as with a shared tmux window.
      const cols = clamp(msg.cols, 20, 500);
      const rows = clamp(msg.rows, 5, 200);
      term.resize(cols, rows);
      l.screen.resize(cols, rows);
    }
  }

  detach(ws: AttachSocket) {
    this.live.get(ws.data.terminalId)?.clients.delete(ws);
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

// ---------------------------------------------------------------- routes


export interface ClaudeLaunch {
  /** Extra arguments for `claude` (jin's settings file with its hooks). */
  args: () => string[];
  env: (workspace: WorkspaceConfig | undefined) => Record<string, string>;
}

/** Open a shell or Claude Code in a task's directory (or the workspace root without a task). */
export function openTerminal(
  deps: { terminals: Terminals; tasks: Tasks; workspaces: WorkspaceConfig[]; claude: ClaudeLaunch },
  b: { taskId?: string; kind?: TerminalKind; prompt?: string; cols?: number; rows?: number },
): TerminalInfo {
  const kind: TerminalKind = b.kind === "claude" ? "claude" : "shell";
  const task = b.taskId ? deps.tasks.get(b.taskId) : undefined;
  if (task && task.state !== "ready") throw new HttpError(409, `task ${task.id} is ${task.state}`);
  const workspace = deps.workspaces.find((w) => w.id === task?.workspace) ?? deps.workspaces[0];
  const cwd = task?.root ?? workspace?.root;
  if (!cwd) throw new HttpError(400, "no task or workspace to open a terminal in");
  const argv = kind === "claude" ? ["claude", ...deps.claude.args(), ...(b.prompt?.trim() ? [b.prompt.trim()] : [])] : undefined;
  return deps.terminals.start({
    kind,
    taskId: task?.id,
    cwd,
    title: kind === "claude" ? "Claude Code" : "Terminal",
    argv,
    env: kind === "claude" ? deps.claude.env(workspace) : {},
    cols: b.cols,
    rows: b.rows,
  });
}

export function terminalRoutes(router: Router, terminals: Terminals, tasks: Tasks, workspaces: WorkspaceConfig[], claude: ClaudeLaunch) {
  router
    .on("GET", "/api/terminals", (_req, _p, url) => json(terminals.list({ taskId: url.searchParams.get("task") ?? undefined })))
    .on("GET", "/api/terminals/:id", (_req, p) => json(terminals.get(p.id!)))
    .on("POST", "/api/terminals", async (req) => {
      const b = await body<{ taskId?: string; kind?: TerminalKind; prompt?: string; cols?: number; rows?: number }>(req);
      return json(openTerminal({ terminals, tasks, workspaces, claude }, b), 201);
    })
    .on("DELETE", "/api/terminals/:id", (_req, p) => {
      terminals.kill(p.id!);
      return json({ closed: true });
    });
}
