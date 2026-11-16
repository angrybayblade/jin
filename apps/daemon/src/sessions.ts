import type { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import type { WorkspaceConfig } from "./config";
import { now } from "./db";
import type { Harness, ToolGate } from "./harness";
import { body, HttpError, json, type Router } from "./http";
import { evaluate } from "./policy";
import type { Tasks } from "./tasks";
import type { WorkspaceAdapter } from "./adapters";

export type SessionState = "running" | "waiting_approval" | "idle" | "failed" | "interrupted";

export interface Session {
  id: string;
  taskId: string;
  harness: string;
  harnessSessionId: string | null;
  state: SessionState;
  createdAt: string;
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

export type StreamSocket = ServerWebSocket<{ sessionId: string; after: number }>;

const toSession = (r: any): Session => ({
  id: r.id,
  taskId: r.task_id,
  harness: r.harness,
  harnessSessionId: r.harness_session_id,
  state: r.state,
  createdAt: r.created_at,
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

export class Sessions {
  private subscribers = new Map<string, Set<StreamSocket>>();
  private waiters = new Map<string, (approved: boolean) => void>();
  private running = new Map<string, AbortController>();

  constructor(
    private db: Database,
    private tasks: Tasks,
    private adapters: Map<string, WorkspaceAdapter>,
    private workspaces: WorkspaceConfig[],
    private harness: () => Harness,
  ) {
    // Agent processes do not survive a daemon restart: what was in flight is interrupted
    // (and can be resumed with a new message); its open approvals can no longer be acted on.
    db.query("update sessions set state = 'interrupted' where state in ('running', 'waiting_approval')").run();
    db.query("update approvals set state = 'expired', decided_at = ? where state = 'pending'").run(now());
  }

  get(id: string): Session {
    const row = this.db.query("select * from sessions where id = ?").get(id);
    if (!row) throw new HttpError(404, `unknown session ${id}`);
    return toSession(row);
  }

  list(taskId?: string): Session[] {
    const rows = taskId
      ? this.db.query("select * from sessions where task_id = ? order by created_at desc").all(taskId)
      : this.db.query("select * from sessions order by created_at desc").all();
    return rows.map(toSession);
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
    return event;
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

  private gate(sessionId: string, workspace: string): ToolGate {
    return async (tool, input, signal) => {
      this.emit(sessionId, "tool.requested", { tool, input });
      const rules = this.adapters.get(workspace)?.policy();
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

  start(taskId: string, prompt: string): Session {
    const task = this.tasks.get(taskId);
    if (task.state !== "ready") throw new HttpError(409, `task ${taskId} is ${task.state}`);
    if (!prompt?.trim()) throw new HttpError(400, "prompt is required");
    const harness = this.harness();
    const id = randomUUID();
    this.db.query("insert into sessions (id, task_id, harness, state, created_at) values (?, ?, ?, 'running', ?)").run(id, taskId, harness.id, now());
    this.emit(id, "session.started", { taskId, harness: harness.id });
    void this.run(id, prompt, harness);
    return this.get(id);
  }

  send(sessionId: string, prompt: string): Session {
    const session = this.get(sessionId);
    if (session.state === "running" || session.state === "waiting_approval") throw new HttpError(409, `session is ${session.state}`);
    if (!prompt?.trim()) throw new HttpError(400, "prompt is required");
    this.setState(sessionId, "running");
    void this.run(sessionId, prompt, this.harness(), session.harnessSessionId ?? undefined);
    return this.get(sessionId);
  }

  private async run(sessionId: string, prompt: string, harness: Harness, resume?: string) {
    const session = this.get(sessionId);
    const task = this.tasks.get(session.taskId);
    const workspace = this.workspaces.find((w) => w.id === task.workspace);
    if (!workspace) throw new Error(`workspace ${task.workspace} is not configured`);
    const env: Record<string, string> = workspace.profile.claudeConfigDir ? { CLAUDE_CONFIG_DIR: workspace.profile.claudeConfigDir } : {};
    const controller = new AbortController();
    this.running.set(sessionId, controller);
    // Only the profile variable is recorded, never the rest of the environment.
    this.emit(sessionId, "harness.started", { harness: harness.id, adapter: harness.adapter, cwd: task.root, env, resume: resume ?? null });
    this.emit(sessionId, "prompt", { text: prompt });
    try {
      const { sessionId: harnessSessionId } = await harness.run({
        prompt,
        cwd: task.root,
        env,
        resume,
        gate: this.gate(sessionId, task.workspace),
        emit: (kind, payload) => this.emit(sessionId, kind, payload),
        signal: controller.signal,
      });
      this.db.query("update sessions set harness_session_id = ? where id = ?").run(harnessSessionId, sessionId);
      this.setState(sessionId, "idle");
      this.emit(sessionId, "session.idle", {});
    } catch (err) {
      this.setState(sessionId, "failed");
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
    .on("POST", "/api/tasks/:id/sessions", async (req, p) => json(sessions.start(p.id!, (await body<{ prompt: string }>(req)).prompt), 201))
    .on("GET", "/api/tasks/:id/sessions", (_req, p) => json(sessions.list(p.id!)))
    .on("GET", "/api/sessions", () => json(sessions.list()))
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
