import type { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceAdapter } from "./adapters";
import { chatInstructions, isChatKind, type ChatKind, type SessionKind } from "./chats";
import type { Config, WorkspaceConfig } from "./config";
import { now } from "./db";
import type { Harness, JinTool, ToolGate } from "./harness";
import { body, HttpError, json, type Router } from "./http";
import { evaluate } from "./policy";
import type { Tasks } from "./tasks";

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
  createdAt: string;
  lastEventAt: string | null;
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
}

export class Sessions {
  private subscribers = new Map<string, Set<StreamSocket>>();
  private listeners: ((e: SessionEvent) => void)[] = [];

  /** Every recorded event, as it happens (notifications listen here). */
  onEvent(fn: (e: SessionEvent) => void) {
    this.listeners.push(fn);
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
      const verdict = evaluate(tool, input, rules);
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

  private create(s: { kind: SessionKind; taskId?: string; workspace?: string; title: string; cwd: string }, prompt: string): Session {
    if (!prompt?.trim()) throw new HttpError(400, "prompt is required");
    const harness = this.deps.harness();
    const id = randomUUID();
    this.db
      .query("insert into sessions (id, kind, task_id, workspace, title, cwd, harness, state, created_at) values (?, ?, ?, ?, ?, ?, ?, 'running', ?)")
      .run(id, s.kind, s.taskId ?? null, s.workspace ?? null, s.title, s.cwd, harness.id, now());
    this.emit(id, "session.started", { kind: s.kind, taskId: s.taskId ?? null, harness: harness.id });
    void this.run(id, prompt, harness);
    return this.get(id);
  }

  /** A coding agent in a task's worktree. */
  startTask(taskId: string, prompt: string): Session {
    const task = this.deps.tasks.get(taskId);
    if (task.state !== "ready") throw new HttpError(409, `task ${taskId} is ${task.state}`);
    return this.create({ kind: "task", taskId, workspace: task.workspace, title: task.slug, cwd: task.root }, prompt);
  }

  /** Jin's own chat or a knowledge chat, in a scratch directory of its own. */
  startChat(kind: ChatKind, prompt: string, workspace?: string): Session {
    const ws = workspace ?? this.deps.workspaces[0]?.id;
    if (ws && !this.deps.workspaces.some((w) => w.id === ws)) throw new HttpError(404, `unknown workspace ${ws}`);
    const cwd = join(this.deps.config.home, "chats", kind);
    mkdirSync(cwd, { recursive: true });
    const title = prompt.trim().replace(/\s+/g, " ").slice(0, 80);
    return this.create({ kind, workspace: ws, title, cwd }, prompt);
  }

  send(sessionId: string, prompt: string): Session {
    const session = this.get(sessionId);
    if (session.state === "running" || session.state === "waiting_approval") throw new HttpError(409, `session is ${session.state}`);
    if (!prompt?.trim()) throw new HttpError(400, "prompt is required");
    this.setState(sessionId, "running");
    void this.run(sessionId, prompt, this.deps.harness(), session.harnessSessionId ?? undefined);
    return this.get(sessionId);
  }

  private async run(sessionId: string, prompt: string, harness: Harness, resume?: string) {
    const session = this.get(sessionId);
    const workspace = this.deps.workspaces.find((w) => w.id === session.workspace);
    const cwd = session.cwd ?? (session.taskId ? this.deps.tasks.get(session.taskId).root : this.deps.config.home);
    const env: Record<string, string> = workspace?.profile.claudeConfigDir ? { CLAUDE_CONFIG_DIR: workspace.profile.claudeConfigDir } : {};
    const controller = new AbortController();
    this.running.set(sessionId, controller);
    // Only the profile variable is recorded, never the rest of the environment.
    this.emit(sessionId, "harness.started", { harness: harness.id, adapter: harness.adapter, cwd, env, resume: resume ?? null, model: this.deps.config.model });
    this.emit(sessionId, "prompt", { text: prompt });
    try {
      const { sessionId: harnessSessionId } = await harness.run({
        prompt,
        cwd,
        env,
        resume,
        model: this.deps.config.model,
        instructions: chatInstructions(session.kind, workspace),
        tools: session.kind === "jin" ? this.deps.jinTools?.() : undefined,
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
    .on("POST", "/api/tasks/:id/sessions", async (req, p) => json(sessions.startTask(p.id!, (await body<{ prompt: string }>(req)).prompt), 201))
    .on("GET", "/api/tasks/:id/sessions", (_req, p) => json(sessions.list({ taskId: p.id! })))
    .on("GET", "/api/sessions", (_req, _p, url) => json(sessions.list({ kind: url.searchParams.get("kind") ?? undefined, archived: url.searchParams.get("archived") === "1" })))
    .on("PATCH", "/api/sessions/:id", async (req, p) => {
      const b = await body<{ title?: string; archived?: boolean }>(req);
      return json(sessions.update(p.id!, b));
    })
    .on("DELETE", "/api/sessions/:id", (_req, p) => {
      sessions.remove(p.id!);
      return json({ deleted: true });
    })
    .on("POST", "/api/chats", async (req) => {
      const { kind, prompt, workspace } = await body<{ kind: string; prompt: string; workspace?: string }>(req);
      if (!isChatKind(kind)) throw new HttpError(400, `kind must be one of jin, slack, linear, notion, gmail, github`);
      return json(sessions.startChat(kind, prompt, workspace), 201);
    })
    .on("GET", "/api/sessions/:id", (_req, p) => json(sessions.get(p.id!)))
    .on("GET", "/api/sessions/:id/events", (_req, p, url) => {
      sessions.get(p.id!);
      return json(sessions.events(p.id!, Number(url.searchParams.get("after") ?? 0)));
    })
    .on("POST", "/api/sessions/:id/messages", async (req, p) => json(sessions.send(p.id!, (await body<{ prompt: string }>(req)).prompt)))
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
