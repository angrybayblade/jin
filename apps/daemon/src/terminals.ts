import type { Database } from "bun:sqlite";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as Headless } from "@xterm/headless";
import type { ServerWebSocket, Subprocess } from "bun";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReviewedPR, TaskKind } from "./adapters";
import type { WorkspaceConfig } from "./config";
import { now } from "./db";
import { body, HttpError, json, type Router } from "./http";
import type { Tasks } from "./tasks";

export type TerminalKind = "shell" | "claude";
/**
 * What a terminal is doing. Claude Code's hooks report starting/working/waiting/idle;
 * "exited" means its process ended; "interrupted" means it is not running (the daemon
 * restarted) but can be started again, resuming Claude Code's conversation.
 */
export type AgentStatus = "starting" | "working" | "waiting" | "idle" | "exited" | "interrupted";

export interface TerminalInfo {
  id: string;
  kind: TerminalKind;
  taskId: string | null;
  cwd: string;
  title: string;
  status: AgentStatus;
  exitCode: number | null;
  /** Claude Code's session id (from its hooks), used to resume after a restart. */
  claudeSessionId: string | null;
  createdAt: string;
  clients: number;
  archived: boolean;
}

export type AttachSocket = ServerWebSocket<{ type: "attach"; terminalId: string }>;

interface Live {
  proc: Subprocess;
  screen: Headless;
  serializer: SerializeAddon;
  clients: Set<AttachSocket>;
  status: AgentStatus;
  exitCode: number | null;
}

interface TerminalRow {
  id: string;
  task_id: string | null;
  kind: TerminalKind;
  title: string;
  cwd: string;
  claude_session_id: string | null;
  created_at: string;
  closed_at: string | null;
  archived_at: string | null;
}

const SCROLLBACK = 5000;

/**
 * Terminal tabs: a shell, or Claude Code's own TUI. Each has a record in SQLite and, while
 * running, a process the daemon owns. Closing or reloading the page only detaches; the
 * screen is kept in a headless xterm and replayed on re-attach. After a daemon restart the
 * tabs come back as "interrupted" and start again in place, Claude Code with --resume.
 *
 * This is the user's own terminal, not an agent run by jin, so jin's agent policy is not
 * applied here; Claude Code started by jin gets jin's rules through its own hooks.
 *
 * Client messages: {"t":"in","d":"..."} keystrokes, {"t":"resize","cols":n,"rows":n}.
 * Server messages: terminal output (the first one is the serialized screen).
 */
export class Terminals {
  private live = new Map<string, Live>();

  constructor(private db: Database) {}

  private row(id: string): TerminalRow {
    const r = this.db.query("select * from terminals where id = ? and closed_at is null").get(id) as TerminalRow | null;
    if (!r) throw new HttpError(404, `unknown terminal ${id}`);
    return r;
  }

  private info(r: TerminalRow): TerminalInfo {
    const l = this.live.get(r.id);
    const resumable = r.kind === "claude" ? Boolean(r.claude_session_id) : true;
    return {
      id: r.id,
      kind: r.kind,
      taskId: r.task_id,
      cwd: r.cwd,
      title: r.title,
      status: l ? l.status : resumable ? "interrupted" : "exited",
      exitCode: l?.exitCode ?? null,
      claudeSessionId: r.claude_session_id,
      createdAt: r.created_at,
      clients: l?.clients.size ?? 0,
      archived: Boolean(r.archived_at),
    };
  }

  /** Open tabs (or, with archived, the archived ones that can be restored). */
  list(filter: { taskId?: string; archived?: boolean } = {}): TerminalInfo[] {
    const which = filter.archived ? "archived_at is not null" : "archived_at is null";
    const rows = (
      filter.taskId
        ? this.db.query(`select * from terminals where task_id = ? and closed_at is null and ${which} order by created_at`).all(filter.taskId)
        : this.db.query(`select * from terminals where closed_at is null and ${which} order by created_at`).all()
    ) as TerminalRow[];
    return rows.map((r) => this.info(r));
  }

  /** Archive a tab: its process stops and it leaves the tab bar, but Claude Code's session can be restored. */
  archive(id: string, archived: boolean) {
    this.row(id);
    if (archived) this.stop(id);
    this.db.query("update terminals set archived_at = ? where id = ?").run(archived ? now() : null, id);
  }

  /** Stop the tab's process (it can be started again in place). */
  restartable(id: string) {
    this.row(id);
    this.stop(id);
  }

  get(id: string): TerminalInfo {
    return this.info(this.row(id));
  }

  isLive(id: string): boolean {
    const l = this.live.get(id);
    return Boolean(l && l.status !== "exited");
  }

  /** A new tab, titled "Claude 2", "Terminal 3"... within its task. */
  create(opts: { kind: TerminalKind; taskId?: string; cwd: string }): TerminalInfo {
    const id = randomUUID();
    const label = opts.kind === "claude" ? "Claude" : "Terminal";
    const n = (this.db.query("select count(*) as n from terminals where kind = ? and task_id is ?").get(opts.kind, opts.taskId ?? null) as { n: number }).n + 1;
    this.db.query("insert into terminals (id, task_id, kind, title, cwd, created_at) values (?, ?, ?, ?, ?, ?)").run(id, opts.taskId ?? null, opts.kind, `${label} ${n}`, opts.cwd, now());
    return this.get(id);
  }

  /** Run a process in a tab's PTY. `argv` goes through the login shell so PATH matches the user's terminal. */
  spawn(id: string, opts: { argv?: string[]; env?: Record<string, string>; cols?: number; rows?: number }): TerminalInfo {
    const r = this.row(id);
    if (this.isLive(id)) return this.get(id);
    const previous = this.live.get(id);
    previous?.screen.dispose();
    const cols = clamp(opts.cols ?? 120, 20, 500);
    const rows = clamp(opts.rows ?? 32, 5, 200);
    const shell = process.env.SHELL || "/bin/bash";
    // `exec "$@"` hands the arguments over without a second round of shell parsing.
    const command = opts.argv?.length ? [shell, "-l", "-c", 'exec "$@"', "jin", ...opts.argv] : [shell, "-l"];
    const screen = new Headless({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer as never);
    const clients = previous?.clients ?? new Set<AttachSocket>();
    const proc = Bun.spawn(command, {
      cwd: r.cwd,
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
    const live: Live = { proc, screen, serializer, clients, status: r.kind === "claude" ? "starting" : "idle", exitCode: null };
    void proc.exited.then((code) => {
      if (this.live.get(id) !== live) return;
      live.status = "exited";
      live.exitCode = code;
      const note = `\r\n\x1b[2m[${r.kind === "claude" ? "Claude Code" : "shell"} exited${code ? ` with ${code}` : ""}]\x1b[0m\r\n`;
      screen.write(note);
      for (const ws of clients) ws.send(note);
    });
    this.live.set(id, live);
    // Viewers already attached (a restart in place) start from a clean screen.
    for (const ws of clients) ws.send("\x1bc");
    return this.get(id);
  }

  /** Hooks from Claude Code report what it is doing. */
  setStatus(id: string, status: AgentStatus) {
    const l = this.live.get(id);
    if (l && l.status !== "exited") l.status = status;
  }

  /** Claude Code's session id; it changes on /clear, so the latest one wins. */
  setClaudeSession(id: string, sessionId: string | null) {
    this.db.query("update terminals set claude_session_id = ? where id = ?").run(sessionId, id);
  }

  rename(id: string, title: string) {
    this.row(id);
    this.db.query("update terminals set title = ? where id = ?").run(title.slice(0, 60), id);
  }

  /** Close a tab: end its process and drop it from the list. */
  close(id: string) {
    this.row(id);
    this.stop(id);
    this.db.query("update terminals set closed_at = ? where id = ?").run(now(), id);
  }

  private stop(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    l.proc.kill();
    for (const ws of l.clients) ws.close(1000, "terminal closed");
    l.screen.dispose();
    this.live.delete(id);
  }

  /** On shutdown: end the processes but keep the tabs, so they resume after the restart. */
  stopAll() {
    for (const id of [...this.live.keys()]) this.stop(id);
  }

  // ---------------------------------------------------------------- websocket attach

  attach(ws: AttachSocket) {
    const l = this.live.get(ws.data.terminalId);
    if (!l) return ws.close(4404, "not running");
    // Replay the current screen, then stream. Serializing and subscribing in the same tick
    // means no output is lost or sent twice.
    const snapshot = l.serializer.serialize({ scrollback: SCROLLBACK });
    if (snapshot) ws.send(snapshot);
    l.clients.add(ws);
  }

  message(ws: AttachSocket, raw: string | Buffer) {
    const l = this.live.get(ws.data.terminalId);
    const term = l?.proc.terminal;
    if (!l || !term || l.status === "exited") return;
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

// ---------------------------------------------------------------- opening and routes

export interface ClaudeLaunch {
  /** Extra arguments for `claude`: jin's settings file with its hooks, the model, and in a task its rules. */
  args: (ctx?: { taskId?: string | null; taskRoot?: string; workspaceRoot?: string; parent?: string | null; terminalId?: string; kind?: TaskKind; prs?: ReviewedPR[] }) => string[];
  env: (workspace: WorkspaceConfig | undefined) => Record<string, string>;
}

export interface TerminalDeps {
  terminals: Terminals;
  tasks: Tasks;
  workspaces: WorkspaceConfig[];
  claude: ClaudeLaunch;
  /** Before Claude Code starts in a task: its skills (jin's, by the task's tags). */
  prepare?: (taskId: string) => Promise<void>;
}

function place(deps: TerminalDeps, taskId?: string | null) {
  const task = taskId ? deps.tasks.get(taskId) : undefined;
  if (task && task.state !== "ready") throw new HttpError(409, `task ${task.id} is ${task.state}`);
  const workspace = deps.workspaces.find((w) => w.id === task?.workspace) ?? deps.workspaces[0];
  const cwd = task?.root ?? workspace?.root;
  if (!cwd) throw new HttpError(400, "no task or workspace to open a terminal in");
  return { task, workspace, cwd };
}

/** Whether Claude Code has a saved conversation for `sessionId` (under any project directory). */
export function hasTranscript(sessionId: string, configDir?: string): boolean {
  if (!/^[\w-]+$/.test(sessionId)) return false;
  const projects = join(configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  try {
    return readdirSync(projects).some((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}

/** Start (or restart) a tab's process: Claude Code resumes its conversation when it has one. */
export function startTerminal(deps: TerminalDeps, id: string, opts: { prompt?: string; cols?: number; rows?: number } = {}): TerminalInfo {
  const t = deps.terminals.get(id);
  if (deps.terminals.isLive(id)) return t;
  const { workspace, task } = place(deps, t.taskId);
  if (t.kind === "shell") return deps.terminals.spawn(id, { cols: opts.cols, rows: opts.rows });
  // Claude Code saves a conversation only once something is sent, so a session that was
  // opened and left empty has nothing to resume: start a fresh one instead of failing.
  const session = t.claudeSessionId && hasTranscript(t.claudeSessionId, workspace?.profile.claudeConfigDir) ? t.claudeSessionId : null;
  if (t.claudeSessionId && !session) deps.terminals.setClaudeSession(id, null);
  const resume = session ? ["--resume", session] : [];
  const prompt = !session && opts.prompt?.trim() ? [opts.prompt.trim()] : [];
  return deps.terminals.spawn(id, { argv: ["claude", ...deps.claude.args({ taskId: t.taskId, taskRoot: task?.root, workspaceRoot: workspace?.root, parent: task?.parent, terminalId: id, kind: task?.kind, prs: task?.prs }), ...resume, ...prompt], env: deps.claude.env(workspace), cols: opts.cols, rows: opts.rows });
}

/** A new tab running a shell or Claude Code, in a task's directory (or the workspace root without a task). */
export function openTerminal(deps: TerminalDeps, b: { taskId?: string; kind?: TerminalKind; prompt?: string; cols?: number; rows?: number }): TerminalInfo {
  const kind: TerminalKind = b.kind === "claude" ? "claude" : "shell";
  const { task, cwd } = place(deps, b.taskId);
  const t = deps.terminals.create({ kind, taskId: task?.id, cwd });
  return startTerminal(deps, t.id, b);
}

export function terminalRoutes(router: Router, deps: TerminalDeps) {
  const { terminals } = deps;
  router
    .on("GET", "/api/terminals", (_req, _p, url) => json(terminals.list({ taskId: url.searchParams.get("task") ?? undefined, archived: url.searchParams.get("archived") === "1" })))
    .on("GET", "/api/terminals/:id", (_req, p) => json(terminals.get(p.id!)))
    .on("POST", "/api/terminals", async (req) => {
      const b = await body<{ taskId?: string; kind?: TerminalKind; prompt?: string; cols?: number; rows?: number }>(req);
      if (b.taskId && b.kind === "claude") await deps.prepare?.(b.taskId).catch(() => {});
      return json(openTerminal(deps, b), 201);
    })
    .on("POST", "/api/terminals/:id/start", async (req, p) => {
      const b = await body<{ cols?: number; rows?: number }>(req);
      const t = terminals.get(p.id!);
      if (t.taskId && t.kind === "claude" && !terminals.isLive(t.id)) await deps.prepare?.(t.taskId).catch(() => {});
      return json(startTerminal(deps, p.id!, b));
    })
    .on("PATCH", "/api/terminals/:id", async (req, p) => {
      const { title, archived } = await body<{ title?: string; archived?: boolean }>(req);
      if (title !== undefined) {
        if (!title.trim()) throw new HttpError(400, "title cannot be empty");
        terminals.rename(p.id!, title.trim());
      }
      if (archived !== undefined) terminals.archive(p.id!, archived);
      return json(terminals.get(p.id!));
    })
    .on("POST", "/api/terminals/:id/restart", async (req, p) => {
      // Stop and start again in place: Claude Code resumes its conversation.
      const b = await body<{ cols?: number; rows?: number }>(req);
      terminals.restartable(p.id!);
      return json(startTerminal(deps, p.id!, b));
    })
    .on("DELETE", "/api/terminals/:id", (_req, p) => {
      terminals.close(p.id!);
      return json({ closed: true });
    });
}
