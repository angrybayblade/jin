import type { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import type { Titler } from "./titles";
import { type Mention, mentionContext, mentionLabels } from "./mentions";
import { EFFORTS, type Effort, MODELS, readChoice } from "./models";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { WorkspaceAdapter } from "./adapters";
import { type ChatSkills, skillContext, skillRefs } from "./chat-skills";
import { CHAT_KINDS, chatInstructions, isChatKind, type ChatKind, type SessionKind } from "./chats";
import type { Config, WorkspaceConfig } from "./config";
import { now } from "./db";
import type { Harness, JinTool, ToolGate } from "./harness";
import { body, HttpError, json, type Router } from "./http";
import { evaluate } from "./policy";
import type { Tasks } from "./tasks";

/** Sessions that work in a task's folder (not a chat reading the workspace). */
const inTask = (kind: SessionKind) => kind === "task" || kind === "room";

export type SessionState = "running" | "waiting_approval" | "idle" | "failed" | "interrupted";

/** A chat with an agent: a task agent, jin's own chat, or a knowledge chat. */
export interface Session {
  id: string;
  kind: SessionKind;
  taskId: string | null;
  workspace: string | null;
  title: string;
  cwd: string | null;
  harness: string;
  harnessSessionId: string | null;
  state: SessionState;
  /** Model and effort the chat runs with; null: jin's default model, the model's default effort. */
  model: string | null;
  effort: Effort | null;
  createdAt: string;
  lastEventAt: string | null;
}

/** A model and effort asked for with a message (kept for the chat's next messages). */
export interface RunChoice {
  model?: string;
  /** null: back to the model's default effort. */
  effort?: Effort | null;
}

export interface SessionEvent {
  seq: number;
  sessionId: string;
  kind: string;
  payload: Record<string, any>;
  at: string;
}

export interface Approval {
  id: string;
  sessionId: string;
  action: { tool: string; input: Record<string, unknown> };
  reason: string;
  state: "pending" | "approved" | "rejected" | "expired";
  createdAt: string;
  decidedAt: string | null;
}

export type StreamSocket = ServerWebSocket<{ type: "stream"; sessionId: string; after: number }>;

const SELECT = "select s.*, (select max(at) from events e where e.session_id = s.id) as last_event_at from sessions s";

const toSession = (r: any): Session => ({
  id: r.id,
  kind: r.kind,
  taskId: r.task_id,
  workspace: r.workspace,
  title: r.title,
  cwd: r.cwd,
  harness: r.harness,
  harnessSessionId: r.harness_session_id,
  state: r.state,
  model: r.model ?? null,
  effort: r.effort ?? null,
  createdAt: r.created_at,
  lastEventAt: r.last_event_at ?? null,
});
const toEvent = (r: any): SessionEvent => ({ seq: r.seq, sessionId: r.session_id, kind: r.kind, payload: JSON.parse(r.payload), at: r.at });
const toApproval = (r: any): Approval => ({
  id: r.id,
  sessionId: r.session_id,
  action: JSON.parse(r.action),
  reason: r.reason,
  state: r.state,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

export interface SessionDeps {
  db: Database;
  config: Config;
  tasks: Tasks;
  adapters: Map<string, WorkspaceAdapter>;
  workspaces: WorkspaceConfig[];
  harness: () => Harness;
  /** Jin's orchestration tools, for jin's own chat. Set after construction (they need this manager). */
  jinTools?: () => JinTool[];
  /** More tools for a chat (a doc chat's, a room agent's), beside jin's. */
  kindTools?: (session: Session) => JinTool[];
  /** Why this session may not use a tool (a read-only room agent editing files), else null. */
  toolBlock?: (session: Session, tool: string, input: Record<string, unknown>) => string | null;
  /** What else a chat is told (a doc chat: which doc). */
  chatNote?: (session: Session) => string | undefined;
  /** Names a new chat from its first message (Claude Haiku); without it a chat keeps its first words. */
  titler?: Titler;
  /** Resolves the @mentions in a message (PRs, Linear issues, jin tasks). */
  mentions?: (text: string) => Promise<Mention[]>;
  /** The skills Claude Code offers where a chat runs (the `/skills` a message names). */
  chatSkills?: ChatSkills;
}

export class Sessions {
  private subscribers = new Map<string, Set<StreamSocket>>();
  private listeners: ((e: SessionEvent) => void)[] = [];

  /** Every recorded event, as it happens (notifications listen here). */
  onEvent(fn: (e: SessionEvent) => void) {
    this.listeners.push(fn);
  }
  private liveListeners: ((sessionId: string, kind: string, payload: Record<string, unknown>) => void)[] = [];
  /** Live-only events too (text as it is written): a room shows an agent's reply while it forms. */
  onLive(fn: (sessionId: string, kind: string, payload: Record<string, unknown>) => void) {
    this.liveListeners.push(fn);
  }
  private waiters = new Map<string, (approved: boolean) => void>();
  private running = new Map<string, AbortController>();
  private db: Database;

  constructor(private deps: SessionDeps) {
    this.db = deps.db;
    // Agent processes do not survive a daemon restart: what was in flight is interrupted
    // (and can be resumed with a new message); its open approvals can no longer be acted on.
    this.db.query("update sessions set state = 'interrupted' where state in ('running', 'waiting_approval')").run();
    this.db.query("update approvals set state = 'expired', decided_at = ? where state = 'pending'").run(now());
  }

  /** Jin's orchestration tools need this manager, so they are provided after construction. */
  provideJinTools(tools: () => JinTool[]) {
    this.deps.jinTools = tools;
  }

  /** The model a chat runs with unless it picked one. */
  get defaultModel(): string {
    return this.deps.config.model;
  }

  get(id: string): Session {
    const row = this.db.query(`${SELECT} where s.id = ?`).get(id);
    if (!row) throw new HttpError(404, `unknown session ${id}`);
    return toSession(row);
  }

  /** Chats, newest first; archived ones only when asked for. */
  list(filter: { taskId?: string; kind?: string; archived?: boolean } = {}): Session[] {
    const live = filter.archived ? "s.archived_at is not null" : "s.archived_at is null";
    if (filter.taskId) return this.db.query(`${SELECT} where s.task_id = ? and ${live} order by s.created_at desc`).all(filter.taskId).map(toSession);
    if (filter.kind) return this.db.query(`${SELECT} where s.kind = ? and ${live} order by s.created_at desc`).all(filter.kind).map(toSession);
    return this.db.query(`${SELECT} where ${live} order by s.created_at desc`).all().map(toSession);
  }

  /** Rename a chat, or archive it (the desk then starts a new one; its history is kept). */
  update(id: string, patch: { title?: string; archived?: boolean }): Session {
    this.get(id);
    if (patch.title !== undefined && patch.title.trim()) this.db.query("update sessions set title = ? where id = ?").run(patch.title.trim().slice(0, 120), id);
    if (patch.archived !== undefined) {
      if (patch.archived) this.stop(id);
      this.db.query("update sessions set archived_at = ? where id = ?").run(patch.archived ? now() : null, id);
    }
    return this.get(id);
  }

  /** Delete a chat and its history (events and approvals). */
  remove(id: string) {
    this.get(id);
    this.stop(id);
    this.db.transaction(() => {
      this.db.query("delete from events where session_id = ?").run(id);
      this.db.query("delete from approvals where session_id = ?").run(id);
      this.db.query("delete from sessions where id = ?").run(id);
    })();
  }

  events(id: string, after = 0): SessionEvent[] {
    return this.db.query("select * from events where session_id = ? and seq > ? order by seq").all(id, after).map(toEvent);
  }

  approvals(state?: string): Approval[] {
    const rows = state
      ? this.db.query("select * from approvals where state = ? order by created_at").all(state)
      : this.db.query("select * from approvals order by created_at").all();
    return rows.map(toApproval);
  }

  private setState(id: string, state: SessionState) {
    this.db.query("update sessions set state = ? where id = ?").run(state, id);
  }

  /** Persist an event, then publish it: a reconnecting reader replays from the database. */
  emit(sessionId: string, kind: string, payload: Record<string, unknown>): SessionEvent {
    const at = now();
    const row = this.db
      .query("insert into events (session_id, kind, payload, at) values (?, ?, ?, ?) returning seq")
      .get(sessionId, kind, JSON.stringify(payload), at) as { seq: number };
    const event: SessionEvent = { seq: row.seq, sessionId, kind, payload, at };
    for (const ws of this.subscribers.get(sessionId) ?? []) ws.send(JSON.stringify(event));
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // a listener's failure never breaks the session
      }
    }
    return event;
  }

  /** Live-only event for open streams (no seq, not persisted): readers that reconnect get the completed message instead. */
  publish(sessionId: string, kind: string, payload: Record<string, unknown>) {
    for (const fn of this.liveListeners) {
      try {
        fn(sessionId, kind, payload);
      } catch {
        // a listener's failure never breaks the session
      }
    }
    const subs = this.subscribers.get(sessionId);
    if (!subs?.size) return;
    const msg = JSON.stringify({ ephemeral: true, sessionId, kind, payload });
    for (const ws of subs) ws.send(msg);
  }

  subscribe(ws: StreamSocket) {
    const { sessionId, after } = ws.data;
    // Replay and subscribe in the same tick: SQLite reads are synchronous, so no event
    // can be emitted in between and none is sent twice.
    for (const e of this.events(sessionId, after)) ws.send(JSON.stringify(e));
    let set = this.subscribers.get(sessionId);
    if (!set) this.subscribers.set(sessionId, (set = new Set()));
    set.add(ws);
  }

  unsubscribe(ws: StreamSocket) {
    this.subscribers.get(ws.data.sessionId)?.delete(ws);
  }

  private gate(sessionId: string, workspace: string | null): ToolGate {
    return async (tool, input, signal) => {
      this.emit(sessionId, "tool.requested", { tool, input });
      const rules = workspace ? this.deps.adapters.get(workspace)?.policy() : undefined;
      const blocked = this.deps.toolBlock?.(this.get(sessionId), tool, input) ?? this.chatEdit(sessionId, tool, input);
      const verdict = blocked ? { decision: "deny" as const, reason: blocked } : evaluate(tool, input, rules);
      if (verdict.decision === "deny") {
        this.emit(sessionId, "tool.denied", { tool, input, reason: verdict.reason, by: "policy" });
        return { allow: false, reason: verdict.reason };
      }
      if (verdict.decision === "ask") {
        const approval = this.requestApproval(sessionId, tool, input, verdict.reason);
        const approved = await new Promise<boolean>((resolve) => {
          this.waiters.set(approval.id, resolve);
          signal.addEventListener("abort", () => resolve(false), { once: true });
        });
        this.waiters.delete(approval.id);
        this.setState(sessionId, "running");
        if (!approved) {
          const reason = "the user declined this action";
          this.emit(sessionId, "tool.denied", { tool, input, reason, by: "user", approvalId: approval.id });
          return { allow: false, reason };
        }
      }
      this.emit(sessionId, "tool.allowed", { tool, input });
      return { allow: true };
    };
  }

  /** A chat changing a file in the workspace: why not (changes to its code happen in tasks), else null. */
  private chatEdit(sessionId: string, tool: string, input: Record<string, unknown>): string | null {
    if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return null;
    const session = this.get(sessionId);
    const root = inTask(session.kind) ? null : this.rootOf(session.workspace);
    const path = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
    if (!root || !path) return null;
    const full = resolve(session.cwd ?? root, path);
    if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
    return `chats read the workspace but do not change it: keep notes in ${this.scratch(session.kind)}, and start a task (jin_start_task) for changes to its code`;
  }

  private requestApproval(sessionId: string, tool: string, input: Record<string, unknown>, reason: string): Approval {
    const id = randomUUID();
    this.db
      .query("insert into approvals (id, session_id, action, reason, state, created_at) values (?, ?, ?, ?, 'pending', ?)")
      .run(id, sessionId, JSON.stringify({ tool, input }), reason, now());
    this.setState(sessionId, "waiting_approval");
    this.emit(sessionId, "approval.requested", { approvalId: id, tool, input, reason });
    return toApproval(this.db.query("select * from approvals where id = ?").get(id));
  }

  decide(approvalId: string, decision: "approve" | "reject"): Approval {
    const row = this.db.query("select * from approvals where id = ?").get(approvalId);
    if (!row) throw new HttpError(404, `unknown approval ${approvalId}`);
    const approval = toApproval(row);
    if (approval.state !== "pending") throw new HttpError(409, `approval is already ${approval.state}`);
    const waiter = this.waiters.get(approvalId);
    if (!waiter) throw new HttpError(409, "the session waiting for this approval is no longer running");
    const state = decision === "approve" ? "approved" : "rejected";
    this.db.query("update approvals set state = ?, decided_at = ? where id = ?").run(state, now(), approvalId);
    this.emit(approval.sessionId, "approval.decided", { approvalId, decision: state });
    waiter(decision === "approve");
    return toApproval(this.db.query("select * from approvals where id = ?").get(approvalId));
  }

  private create(s: { kind: SessionKind; taskId?: string; workspace?: string; title: string; cwd: string; id?: string }, prompt: string, choice: RunChoice = {}): Session {
    if (!prompt?.trim()) throw new HttpError(400, "prompt is required");
    const harness = this.deps.harness();
    const id = s.id ?? randomUUID();
    this.db
      .query("insert into sessions (id, kind, task_id, workspace, title, cwd, harness, state, model, effort, created_at) values (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)")
      .run(id, s.kind, s.taskId ?? null, s.workspace ?? null, s.title, s.cwd, harness.id, choice.model ?? null, choice.effort ?? null, now());
    this.emit(id, "session.started", { kind: s.kind, taskId: s.taskId ?? null, harness: harness.id });
    void this.run(id, prompt, harness);
    return this.get(id);
  }

  /** A coding agent in a task's worktree. */
  startTask(taskId: string, prompt: string, choice?: RunChoice): Session {
    const task = this.deps.tasks.get(taskId);
    if (task.state !== "ready") throw new HttpError(409, `task ${taskId} is ${task.state}`);
    return this.create({ kind: "task", taskId, workspace: task.workspace, title: task.slug, cwd: task.root }, prompt, choice);
  }

  /** An agent in a task's room: like a task's agent (its folder, the workspace's own instructions), with its role and the room's tools. */
  startRoom(taskId: string, prompt: string, title: string, choice?: RunChoice, id?: string): Session {
    const task = this.deps.tasks.get(taskId);
    if (task.state !== "ready") throw new HttpError(409, `task ${taskId} is ${task.state}`);
    return this.create({ kind: "room", taskId, workspace: task.workspace, title, cwd: task.root, id }, prompt, choice);
  }

  /** A chat's scratch folder: its notes and files (it does not change the workspace). */
  private scratch(kind: SessionKind): string {
    const dir = join(this.deps.config.home, "chats", kind);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The workspace's folder on this machine, when it is there. */
  private rootOf(workspace: string | null | undefined): string | null {
    const root = this.deps.workspaces.find((w) => w.id === workspace)?.root;
    return root && existsSync(root) ? root : null;
  }

  get chatSkills(): ChatSkills | undefined {
    return this.deps.chatSkills;
  }

  /** Where a new chat of this kind runs, and the environment it runs with (its skills depend on both). */
  chatPlace(kind: string, workspace?: string): { cwd: string; env: Record<string, string> } {
    if (!isChatKind(kind)) throw new HttpError(400, `unknown chat kind ${kind}`);
    const ws = this.deps.workspaces.find((w) => w.id === (workspace ?? this.deps.workspaces[0]?.id));
    return { cwd: this.rootOf(ws?.id) ?? this.scratch(kind), env: ws?.profile.claudeConfigDir ? { CLAUDE_CONFIG_DIR: ws.profile.claudeConfigDir } : {} };
  }

  /**
   * Jin's own chat or a knowledge chat. It starts in the workspace (its CLAUDE.md, skills and
   * docs load, as for Claude Code there), with a scratch folder of its own for notes; with no
   * workspace on this machine, in the scratch folder.
   */
  startChat(kind: ChatKind, prompt: string, workspace?: string, name?: string, choice?: RunChoice, id?: string): Session {
    const ws = workspace ?? this.deps.workspaces[0]?.id;
    if (ws && !this.deps.workspaces.some((w) => w.id === ws)) throw new HttpError(404, `unknown workspace ${ws}`);
    const scratch = this.scratch(kind);
    const cwd = this.rootOf(ws) ?? scratch;
    const title = (name?.trim() || prompt.trim()).replace(/\s+/g, " ").slice(0, 80);
    const session = this.create({ kind, workspace: ws, title, cwd, id }, prompt, choice);
    // A short title in the background: it replaces the first words unless the chat was renamed meanwhile.
    if (!name?.trim()) void this.nameFrom(session.id, prompt, title);
    return session;
  }

  private async nameFrom(id: string, prompt: string, unless?: string): Promise<string | null> {
    const workspace = this.deps.workspaces.find((w) => w.id === this.get(id).workspace);
    const t = await this.deps.titler?.(prompt, workspace?.profile.claudeConfigDir ? { CLAUDE_CONFIG_DIR: workspace.profile.claudeConfigDir } : {}).catch(() => null);
    if (!t) return null;
    try {
      const now = this.get(id);
      if (unless !== undefined && now.title !== unless) return null;
      return this.update(id, { title: t }).title;
    } catch {
      return null; // deleted meanwhile
    }
  }

  /** Name a chat again from its first message (for chats started before titles were generated). */
  async retitle(id: string): Promise<Session> {
    const first = this.events(id).find((e) => e.kind === "prompt");
    const text = (first?.payload as { text?: string } | undefined)?.text;
    if (!text) throw new HttpError(409, "this chat has no first message to name it from");
    if (!this.deps.titler) throw new HttpError(501, "no titler on this jin");
    if (!(await this.nameFrom(id, text))) throw new HttpError(502, "could not name the chat; try again");
    return this.get(id);
  }

  send(sessionId: string, prompt: string, choice: RunChoice = {}): Session {
    const session = this.get(sessionId);
    if (session.state === "running" || session.state === "waiting_approval") throw new HttpError(409, `session is ${session.state}`);
    if (!prompt?.trim()) throw new HttpError(400, "prompt is required");
    if (choice.model) this.db.query("update sessions set model = ? where id = ?").run(choice.model, sessionId);
    if (choice.effort !== undefined) this.db.query("update sessions set effort = ? where id = ?").run(choice.effort, sessionId);
    this.setState(sessionId, "running");
    void this.run(sessionId, prompt, this.deps.harness(), session.harnessSessionId ?? undefined);
    return this.get(sessionId);
  }

  private async run(sessionId: string, prompt: string, harness: Harness, resume?: string) {
    const session = this.get(sessionId);
    const workspace = this.deps.workspaces.find((w) => w.id === session.workspace);
    const cwd = session.cwd ?? (session.taskId ? this.deps.tasks.get(session.taskId).root : this.deps.config.home);
    // A chat reads the workspace and keeps notes in its scratch folder: whichever it did not start
    // in is added (a chat from before chats started in the workspace keeps its folder, so it resumes).
    const root = inTask(session.kind) ? null : this.rootOf(session.workspace);
    const scratch = inTask(session.kind) ? null : this.scratch(session.kind);
    const addDirs = [root, scratch].filter((d): d is string => Boolean(d) && d !== cwd);
    const env: Record<string, string> = workspace?.profile.claudeConfigDir ? { CLAUDE_CONFIG_DIR: workspace.profile.claudeConfigDir } : {};
    const controller = new AbortController();
    this.running.set(sessionId, controller);
    // Only the profile variable is recorded, never the rest of the environment.
    const model = session.model ?? this.deps.config.model;
    const effort = session.effort ?? undefined;
    this.emit(sessionId, "harness.started", { harness: harness.id, adapter: harness.adapter, cwd, env, resume: resume ?? null, model, effort: effort ?? null });
    this.emit(sessionId, "prompt", { text: prompt });
    // @mentions: resolved (a few seconds at most), shown as chips, and told to the agent with the message.
    const mentioned = mentionLabels(prompt).length && this.deps.mentions ? await Promise.race([this.deps.mentions(prompt).catch(() => [] as Mention[]), Bun.sleep(8000).then(() => [] as Mention[])]) : [];
    if (mentioned.length) this.emit(sessionId, "prompt.mentions", { mentions: mentioned });
    // /skills: shown as chips; the ones named after the first word are told to the agent.
    const skills = skillRefs(prompt).length && this.deps.chatSkills ? await Promise.race([this.deps.chatSkills.list(cwd, env).catch(() => []), Bun.sleep(5000).then(() => [])]) : [];
    const { used, context: skillsNote } = skillContext(prompt, skills);
    if (used.length) this.emit(sessionId, "prompt.skills", { skills: used });
    try {
      const { sessionId: harnessSessionId } = await harness.run({
        prompt: prompt + mentionContext(mentioned) + skillsNote,
        cwd,
        env,
        resume,
        model,
        effort,
        addDirs,
        instructions: [chatInstructions(session.kind, workspace, { root, scratch }), this.deps.chatNote?.(session)].filter(Boolean).join("\n\n") || undefined,
        // These desks work through the user's claude.ai connectors, which connect in the background.
        needsConnectors: ["desk", "gmail", "slack", "linear", "notion"].includes(session.kind),
        tools:
          session.kind === "room"
            ? this.deps.kindTools?.(session)
            : session.kind === "jin" || session.kind === "desk" || session.kind === "doc"
              ? [...(this.deps.jinTools?.() ?? []), ...(this.deps.kindTools?.(session) ?? [])]
              : undefined,
        gate: this.gate(sessionId, session.workspace),
        emit: (kind, payload) => this.emit(sessionId, kind, payload),
        stream: (kind, payload) => this.publish(sessionId, kind, payload),
        signal: controller.signal,
      });
      this.db.query("update sessions set harness_session_id = ? where id = ?").run(harnessSessionId, sessionId);
      this.setState(sessionId, "idle");
      this.emit(sessionId, "session.idle", {});
    } catch (err) {
      this.setState(sessionId, controller.signal.aborted ? "interrupted" : "failed");
      this.emit(sessionId, "session.failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running.delete(sessionId);
    }
  }

  stop(sessionId: string): Session {
    this.running.get(sessionId)?.abort();
    return this.get(sessionId);
  }
}

export function sessionRoutes(router: Router, sessions: Sessions, adapters: Map<string, WorkspaceAdapter>) {
  router
    .on("POST", "/api/tasks/:id/sessions", async (req, p) => {
      const b = await body<{ prompt: string; model?: string; effort?: string }>(req);
      return json(sessions.startTask(p.id!, b.prompt, readChoice(b)), 201);
    })
    .on("GET", "/api/tasks/:id/sessions", (_req, p) => json(sessions.list({ taskId: p.id! })))
    .on("GET", "/api/sessions", (_req, _p, url) => json(sessions.list({ kind: url.searchParams.get("kind") ?? undefined, archived: url.searchParams.get("archived") === "1" })))
    .on("PATCH", "/api/sessions/:id", async (req, p) => {
      const b = await body<{ title?: string; archived?: boolean }>(req);
      return json(sessions.update(p.id!, b));
    })
    .on("POST", "/api/sessions/:id/retitle", async (_req, p) => json(await sessions.retitle(p.id!)))
    .on("DELETE", "/api/sessions/:id", (_req, p) => {
      sessions.remove(p.id!);
      return json({ deleted: true });
    })
    .on("POST", "/api/chats", async (req) => {
      const b = await body<{ kind: string; prompt: string; workspace?: string; title?: string; model?: string; effort?: string }>(req);
      if (!isChatKind(b.kind)) throw new HttpError(400, `kind must be one of ${CHAT_KINDS.join(", ")}`);
      return json(sessions.startChat(b.kind, b.prompt, b.workspace, b.title, readChoice(b)), 201);
    })
    .on("GET", "/api/sessions/:id", (_req, p) => json(sessions.get(p.id!)))
    .on("GET", "/api/sessions/:id/events", (_req, p, url) => {
      sessions.get(p.id!);
      return json(sessions.events(p.id!, Number(url.searchParams.get("after") ?? 0)));
    })
    .on("POST", "/api/sessions/:id/messages", async (req, p) => {
      const b = await body<{ prompt: string; model?: string; effort?: string }>(req);
      return json(sessions.send(p.id!, b.prompt, readChoice(b)));
    })
    // What the composer offers: the models and effort levels, and what a new chat runs with.
    .on("GET", "/api/models", () => json({ models: MODELS, efforts: EFFORTS, default: { model: sessions.defaultModel } }))
    .on("POST", "/api/sessions/:id/stop", (_req, p) => json(sessions.stop(p.id!)))
    .on("GET", "/api/approvals", (_req, _p, url) => json(sessions.approvals(url.searchParams.get("state") ?? undefined)))
    .on("POST", "/api/approvals/:id", async (req, p) => {
      const { decision } = await body<{ decision: string }>(req);
      if (decision !== "approve" && decision !== "reject") throw new HttpError(400, "decision must be approve or reject");
      return json(sessions.decide(p.id!, decision));
    })
    .on("POST", "/api/policy/evaluate", async (req) => {
      const { workspace, tool, input } = await body<{ workspace?: string; tool: string; input?: Record<string, unknown> }>(req);
      if (!tool) throw new HttpError(400, "tool is required");
      return json(evaluate(tool, input ?? {}, workspace ? adapters.get(workspace)?.policy() : undefined));
    });
}
