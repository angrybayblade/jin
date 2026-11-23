import type { Database } from "bun:sqlite";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as Headless } from "@xterm/headless";
import type { ServerWebSocket, Subprocess } from "bun";
import { randomUUID } from "node:crypto";
import type { AgentId, Agents } from "./agents";
import type { WorkspaceConfig } from "./config";
import { now } from "./db";
import { body, HttpError, json, type Router } from "./http";
import type { Tasks } from "./tasks";

/** A shell, or a coding agent (Claude Code, Codex: its `agent`). */
export type TerminalKind = "shell" | "agent";
/**
 * What a terminal is doing. The agent's hooks report starting/working/waiting/idle;
 * "exited" means its process ended; "interrupted" means it is not running (the daemon
 * restarted) but can be started again, resuming the agent's conversation.
 */
export type AgentStatus = "starting" | "working" | "waiting" | "idle" | "exited" | "interrupted";

export interface TerminalInfo {
  id: string;
  kind: TerminalKind;
  /** Which agent an agent tab runs; null for a shell. */
  agent: AgentId | null;
  taskId: string | null;
  cwd: string;
  title: string;
  status: AgentStatus;
  /** While waiting: what for, when known. */
  waitingFor?: string | null;
  exitCode: number | null;
  /** The agent's session id (from its hooks), used to resume after a restart. */
  agentSessionId: string | null;
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
  /** While waiting: what for (the agent's notice, or why jin asks). */
  waitingFor?: string | null;
  exitCode: number | null;
}

interface TerminalRow {
  id: string;
  task_id: string | null;
  kind: TerminalKind;
  agent: AgentId | null;
  title: string;
  cwd: string;
  agent_session_id: string | null;
  created_at: string;
  closed_at: string | null;
  archived_at: string | null;
}

const SCROLLBACK = 5000;

/**
 * Terminal tabs: a shell, or a coding agent's own TUI (Claude Code, Codex). Each has a record in SQLite and, while
 * running, a process the daemon owns. Closing or reloading the page only detaches; the
 * screen is kept in a headless xterm and replayed on re-attach. After a daemon restart the
 * tabs come back as "interrupted" and start again in place, an agent resuming its conversation.
 *
 * This is the user's own terminal, not an agent run by jin, so jin's agent policy is not
 * applied here; an agent started by jin gets jin's rules through its own hooks.
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
    const resumable = r.kind === "agent" ? Boolean(r.agent_session_id) : true;
    return {
      id: r.id,
      kind: r.kind,
      agent: r.agent,
      taskId: r.task_id,
      cwd: r.cwd,
      title: r.title,
      status: l ? l.status : resumable ? "interrupted" : "exited",
      waitingFor: l?.status === "waiting" ? (l.waitingFor ?? null) : null,
      exitCode: l?.exitCode ?? null,
      agentSessionId: r.agent_session_id,
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

  /** Archive a tab: its process stops and it leaves the tab bar, but the agent's session can be restored. */
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

  /** A new tab, titled "Claude 2", "Codex 1", "Terminal 3"... within its task. */
  create(opts: { kind: TerminalKind; agent?: AgentId; label?: string; taskId?: string; cwd: string }): TerminalInfo {
    const id = randomUUID();
    const agent = opts.kind === "agent" ? (opts.agent ?? "claude") : null;
    const label = opts.label ?? (agent ? "Claude" : "Terminal");
    const n = (this.db.query("select count(*) as n from terminals where kind = ? and agent is ? and task_id is ?").get(opts.kind, agent, opts.taskId ?? null) as { n: number }).n + 1;
    this.db.query("insert into terminals (id, task_id, kind, agent, title, cwd, created_at) values (?, ?, ?, ?, ?, ?, ?)").run(id, opts.taskId ?? null, opts.kind, agent, `${label} ${n}`, opts.cwd, now());
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
    const live: Live = { proc, screen, serializer, clients, status: r.kind === "agent" ? "starting" : "idle", exitCode: null };
    void proc.exited.then((code) => {
      if (this.live.get(id) !== live) return;
      live.status = "exited";
      live.exitCode = code;
      const note = `\r\n\x1b[2m[${r.kind === "agent" ? "the agent" : "shell"} exited${code ? ` with ${code}` : ""}]\x1b[0m\r\n`;
      screen.write(note);
      for (const ws of clients) ws.send(note);
    });
    this.live.set(id, live);
    // Viewers already attached (a restart in place) start from a clean screen.
    for (const ws of clients) ws.send("\x1bc");
    return this.get(id);
  }

  /** The agent's hooks report what it is doing. */
  setStatus(id: string, status: AgentStatus, waitingFor?: string | null) {
    const l = this.live.get(id);
    if (!l || l.status === "exited") return;
    l.status = status;
    l.waitingFor = status === "waiting" ? (waitingFor?.slice(0, 200) ?? null) : null;
  }

  /** The agent's session id (Claude Code's changes on /clear), so the latest one wins. */
  setAgentSession(id: string, sessionId: string | null) {
    this.db.query("update terminals set agent_session_id = ? where id = ?").run(sessionId, id);
  }

  rename(id: string, title: string) {
    this.row(id);
    this.db.query("update terminals set title = ? where id = ?").run(title.slice(0, 60), id);
  }

  /** Forget a tab that never ran (its agent refused to start): no record, and its number is free again. */
  discard(id: string) {
    this.stop(id);
    this.db.query("delete from terminals where id = ?").run(id);
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


export interface TerminalDeps {
  terminals: Terminals;
  tasks: Tasks;
  workspaces: WorkspaceConfig[];
  /** The coding agents tabs can run, and this machine's default. */
  agents: Agents;
  /** Before an agent starts in a task: its skills (jin's, by the task's tags). */
  prepare?: (taskId: string) => Promise<void>;
}

/** What callers may ask for: a shell, or an agent tab ("claude" is the older name for one). */
export type OpenKind = TerminalKind | "claude";

function place(deps: TerminalDeps, taskId?: string | null) {
  const task = taskId ? deps.tasks.get(taskId) : undefined;
  if (task && task.state !== "ready") throw new HttpError(409, `task ${task.id} is ${task.state}`);
  const workspace = deps.workspaces.find((w) => w.id === task?.workspace) ?? deps.workspaces[0];
  const cwd = task?.root ?? workspace?.root;
  if (!cwd) throw new HttpError(400, "no task or workspace to open a terminal in");
  return { task, workspace, cwd };
}

/** Start (or restart) a tab's process: an agent resumes its conversation when it has one. */
export async function startTerminal(deps: TerminalDeps, id: string, opts: { prompt?: string; cols?: number; rows?: number; fork?: string } = {}): Promise<TerminalInfo> {
  const t = deps.terminals.get(id);
  if (deps.terminals.isLive(id)) return t;
  const { workspace, task } = place(deps, t.taskId);
  if (t.kind === "shell") return deps.terminals.spawn(id, { cols: opts.cols, rows: opts.rows });
  const agent = deps.agents.launch(t.agent ?? "claude");
  // An agent saves a conversation only once something is sent, so a session that was opened
  // and left empty has nothing to resume: start a fresh one instead of failing.
  const resume = t.agentSessionId && agent.hasSession(t.agentSessionId, workspace) ? t.agentSessionId : undefined;
  if (t.agentSessionId && !resume) deps.terminals.setAgentSession(id, null);
  // A fork: a new tab that starts from another tab's conversation, under a new session id.
  const fork = !resume && agent.canFork && opts.fork && agent.hasSession(opts.fork, workspace) ? opts.fork : undefined;
  const ctx = { taskId: t.taskId, taskRoot: task?.root, workspaceRoot: workspace?.root, parent: task?.parent, terminalId: id, kind: task?.kind, prs: task?.prs, workspace };
  if (task && deps.prepare) await deps.prepare(task.id).catch(() => {});
  await agent.prepare?.(ctx);
  if (deps.terminals.isLive(id)) return deps.terminals.get(id);
  const prompt = !resume && !fork ? opts.prompt : undefined;
  return deps.terminals.spawn(id, { argv: agent.argv({ ...ctx, resume, fork, prompt }), env: agent.env(workspace, ctx), cols: opts.cols, rows: opts.rows });
}

/** A new tab running a shell or an agent (this machine's default unless `agent` names one), in a task's directory (or the workspace root without a task). */
export async function openTerminal(deps: TerminalDeps, b: { taskId?: string; kind?: OpenKind; agent?: string; prompt?: string; cols?: number; rows?: number; forkFrom?: string }): Promise<TerminalInfo> {
  // Forking an agent tab: same task and agent, its conversation copied into a new session.
  const from = b.forkFrom ? deps.terminals.get(b.forkFrom) : null;
  if (from && (from.kind !== "agent" || !from.agentSessionId || !deps.agents.launch(from.agent ?? "claude").canFork)) throw new HttpError(400, "only a Claude Code tab with a conversation can be forked");
  const kind: TerminalKind = from || b.kind === "agent" || b.kind === "claude" ? "agent" : "shell";
  const agent = kind === "agent" ? await deps.agents.pick(from?.agent ?? b.agent) : null;
  const { task, cwd } = place(deps, from ? (from.taskId ?? undefined) : b.taskId);
  const t = deps.terminals.create({ kind, agent: agent?.id, label: agent ? agent.label.split(" ")[0] : undefined, taskId: task?.id, cwd });
  if (from) deps.terminals.rename(t.id, `${from.title} fork`);
  try {
    return await startTerminal(deps, t.id, { ...b, fork: from?.agentSessionId ?? undefined });
  } catch (err) {
    // It never ran: leave no empty tab behind.
    deps.terminals.discard(t.id);
    throw err;
  }
}

export function terminalRoutes(router: Router, deps: TerminalDeps) {
  const { terminals } = deps;
  router
    .on("GET", "/api/terminals", (_req, _p, url) => json(terminals.list({ taskId: url.searchParams.get("task") ?? undefined, archived: url.searchParams.get("archived") === "1" })))
    .on("GET", "/api/terminals/:id", (_req, p) => json(terminals.get(p.id!)))
    .on("POST", "/api/terminals", async (req) => {
      const b = await body<{ taskId?: string; kind?: OpenKind; agent?: string; prompt?: string; cols?: number; rows?: number; forkFrom?: string }>(req);
      return json(await openTerminal(deps, b), 201);
    })
    .on("POST", "/api/terminals/:id/start", async (req, p) => {
      const b = await body<{ cols?: number; rows?: number }>(req);
      return json(await startTerminal(deps, p.id!, b));
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
      // Stop and start again in place: the agent resumes its conversation.
      const b = await body<{ cols?: number; rows?: number }>(req);
      terminals.restartable(p.id!);
      return json(await startTerminal(deps, p.id!, b));
    })
    .on("DELETE", "/api/terminals/:id", (_req, p) => {
      terminals.close(p.id!);
      return json({ closed: true });
    });
}
