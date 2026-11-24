import { problems } from "./problems";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { UNTRUSTED } from "./chats";
import { now } from "./db";
import type { JinTool } from "./harness";
import { body, HttpError, json, type Router } from "./http";
import { type Effort, readChoice } from "./models";
import type { Approval, Session, SessionEvent, Sessions, SessionState } from "./sessions";
import type { Tasks } from "./tasks";
import { MENTION, type Mention } from "./mentions";

/**
 * A task's agent room: several agents, each with a role of its own (a profile: its brief, whether
 * it may change the code, its model), and you directing them.
 *
 * - Agents are reactive: one runs only when you @-mention it.
 * - An agent sees the room's messages since its last turn, and of the other agents only their
 *   final message: never their reasoning or tool calls. Older messages are read on request
 *   (room_history).
 * - Several mentions in one message run at the same time when they only read; in the order
 *   named once one of them writes code.
 * - Each agent is one Claude session in the task's folder, resumed turn after turn.
 */

export type RoomAccess = "writer" | "read-only";

export interface RoomAgent {
  id: string;
  taskId: string;
  /** What you type after @. */
  handle: string;
  name: string;
  /** The role's instructions. */
  brief: string;
  /** A writer changes the task's worktrees; a read-only agent reads, runs checks and writes docs. */
  access: RoomAccess;
  /** null: jin's default model, the model's default effort. */
  model: string | null;
  effort: Effort | null;
  color: string;
  sessionId: string | null;
  /** The room's last message it was given. */
  lastSeen: number;
  position: number;
  createdAt: string;
}

export type RoomAgentState = "new" | "queued" | SessionState;

/** An agent as the room shows it: with what its session is doing. */
export interface RoomAgentView extends RoomAgent {
  /** While it works: what it is writing now (for you; the other agents get its final message only). */
  draft: string | null;
  state: RoomAgentState;
  /** Turns waiting behind the one running. */
  queued: number;
  /** While it works: the last thing it did ("Read sessions.ts"). */
  activity: string | null;
}

export interface RoomMessage {
  seq: number;
  taskId: string;
  /** "you", or an agent's id. */
  author: string;
  authorName: string;
  authorHandle: string | null;
  /** A message is part of the conversation (agents are given it); a note is the room's own remark, for you. */
  kind: "message" | "note";
  text: string;
  /** The agents' handles it names. */
  mentions: string[];
  /** What the turn behind it made or changed: the docs it wrote, suggested edits to or commented on. */
  refs: RoomRef[];
  pinned: boolean;
  at: string;
}

export type RoomRef =
  | {
      kind: "doc";
      id: string;
      title: string;
      /** "created", "suggested an edit", "commented". */
      did: string[];
    }
  /** Files a writer's turn changed in one repo's worktree (the first few named). */
  | { kind: "files"; repo: string; count: number; files: string[] }
  /** A file the user tagged (@file:repo/path), as a task-relative path. */
  | { kind: "file"; path: string }
  /** A PR, issue or jin task the user tagged (@platform#133, @PLEN-1334), as jin resolved it. */
  | { kind: "mention"; what: Mention["kind"]; label: string; title: string | null; url: string | null; state: string | null };

/** What a message tags besides agents: `@doc:<id>`, `@file:<repo/path>`. */
const TAG = /(^|[\s(])@(doc|file):([^\s]+?)(?=[),.;:!?]*(?:\s|$))/g;
export function tagsIn(text: string): { docs: string[]; files: string[] } {
  const docs = new Set<string>();
  const files = new Set<string>();
  for (const m of text.matchAll(TAG)) (m[2] === "doc" ? docs : files).add(m[3]!);
  return { docs: [...docs], files: [...files] };
}
/** How much of a tagged doc an agent is handed with the message (its doc tools read the rest). */
const DOC_EXCERPT = 4000;

type DocRef = Extract<RoomRef, { kind: "doc" }>;

/** A worktree's state, to tell what a turn changed: its commit, and each changed file's status, size and time. */
type TreeState = { head: string; files: Map<string, string> };
function treeState(dir: string): TreeState | null {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString() : null;
  };
  const head = git("rev-parse", "HEAD")?.trim();
  const status = git("status", "--porcelain", "-uall", "-z");
  if (head === undefined || status === null) return null;
  const files = new Map<string, string>();
  for (const entry of status.split("\0")) {
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    let stamp = "gone";
    try {
      const st = statSync(join(dir, path));
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      // deleted
    }
    files.set(path, `${entry.slice(0, 2)}:${stamp}`);
  }
  return { head, files };
}
/** The files that differ between two states of a worktree. */
function changedBetween(dir: string, before: TreeState, after: TreeState): string[] {
  const out = new Set<string>();
  for (const [p, v] of after.files) if (before.files.get(p) !== v) out.add(p);
  for (const p of before.files.keys()) if (!after.files.has(p)) out.add(p);
  if (before.head !== after.head) {
    const r = Bun.spawnSync(["git", "-C", dir, "diff", "--name-only", before.head, after.head], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode === 0) for (const p of r.stdout.toString().split("\n").filter(Boolean)) out.add(p);
  }
  return [...out].sort();
}

export interface RoomState {
  taskId: string;
  agents: RoomAgentView[];
  /** Messages after the `after` asked for. */
  messages: RoomMessage[];
  pinned: RoomMessage[];
  lastSeq: number;
  /** Actions an agent waits on you for. */
  approvals: (Pick<Approval, "id" | "action" | "reason" | "createdAt"> & { agentId: string })[];
}

const COLORS = ["violet", "blue", "amber", "green", "rose", "teal"] as const;

/** The agents a new room starts with. */
export const ROOM_PRESETS: Pick<RoomAgent, "handle" | "name" | "access" | "color" | "brief">[] = [
  {
    handle: "designer",
    name: "Designer",
    access: "read-only",
    color: "violet",
    brief:
      "You own the design. Turn the user's goal into a concrete spec that can be checked: the problem, the approach and the alternatives you rejected (and why), interfaces and data shapes, edge cases, and what is out of scope. Ground it in the code that exists: read it and cite file:line. Write the spec as a jin doc (jin_create_doc) and revise it with suggestions and comments rather than in long room messages; your reply says what you wrote or changed and what needs the user's decision. You do not write code.",
  },
  {
    handle: "engineer",
    name: "Engineer",
    access: "writer",
    color: "blue",
    brief:
      "You implement. Work from the agreed design (the task's docs, the room) in the task's worktrees: the smallest change that does it, following the repo's own patterns, with tests next to the code. Run the repo's checks before you call it done, and report exactly what you ran and what it said. If the design is wrong or unclear, say so instead of improvising. Do not push or open pull requests unless the user asks.",
  },
  {
    handle: "reviewer",
    name: "Reviewer",
    access: "read-only",
    color: "amber",
    brief:
      "You review, and you are hard to please. Read the actual diff and the code around it (git diff, the files), and the design doc when there is one; run the checks and tests yourself instead of trusting a claim that they pass. Report findings most severe first, each with file:line, what breaks and how to see it; say plainly when something is fine. You do not fix code: describe the fix. On a design doc, comment (jin_comment_doc) or suggest edits.",
  },
];

/** Shell commands that plainly change a worktree (a read-only agent's are refused): git's writing commands, and edits in place. */
const SHELL_WRITE = /(^|[;&|(]\s*)git\s+(-C\s+\S+\s+)?(commit|push|add|rm|mv|checkout|switch|restore|reset|stash|merge|rebase|cherry-pick|revert|apply|am|clean|pull)\b|\b(sed|perl)\s+(-[a-zA-Z]*i|--in-place)\b/;
const HANDLE = /^[a-z][a-z0-9_-]{1,23}$/;
const RESERVED = new Set(["you", "user", "all", "everyone", "jin", "room"]);
/** How many messages an agent is handed at once; older ones are read with room_history. */
const MAX_DELTA = 40;

const toAgent = (r: any): RoomAgent => ({
  id: r.id,
  taskId: r.task_id,
  handle: r.handle,
  name: r.name,
  brief: r.brief,
  access: r.access === "writer" ? "writer" : "read-only",
  model: r.model ?? null,
  effort: r.effort ?? null,
  color: r.color,
  sessionId: r.session_id ?? null,
  lastSeen: r.last_seen,
  position: r.position,
  createdAt: r.created_at,
});
const toMessage = (r: any): RoomMessage => ({
  seq: r.seq,
  taskId: r.task_id,
  author: r.author,
  authorName: r.author_name,
  authorHandle: r.author_handle ?? null,
  kind: r.kind === "note" ? "note" : "message",
  text: r.text,
  mentions: JSON.parse(r.mentions),
  refs: JSON.parse(r.refs ?? "[]"),
  pinned: Boolean(r.pinned),
  at: r.at,
});

/** The agents a message names, in the order named (@all: every agent, in the roster's order). */
export function mentionsIn(text: string, agents: Pick<RoomAgent, "handle">[]): string[] {
  const known = new Map(agents.map((a) => [a.handle.toLowerCase(), a.handle]));
  const out: string[] = [];
  for (const m of text.matchAll(/(^|[^\w@/.])@([a-z][\w-]*)/gi)) {
    const h = m[2]!.toLowerCase();
    const named = h === "all" || h === "everyone" ? [...known.values()] : known.has(h) ? [known.get(h)!] : [];
    for (const n of named) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** One line for what a tool call does ("Read sessions.ts", "Bash bun test"). */
function activityOf(tool: string, input: Record<string, unknown>): string {
  const name = tool.replace(/^mcp__jin__/, "").replace(/^mcp__/, "");
  const arg = typeof input.file_path === "string" ? basename(input.file_path) : typeof input.command === "string" ? input.command : typeof input.pattern === "string" ? input.pattern : typeof input.docId === "string" ? input.docId : "";
  return `${name} ${String(arg).replace(/\s+/g, " ").slice(0, 70)}`.trim();
}

export interface RoomDeps {
  db: Database;
  sessions: Sessions;
  tasks: Tasks;
  /** jin's doc tools, for every agent (docs are open to all roles; the code has its writers), writing as that agent. */
  docTools: (by: `@${string}`) => JinTool[];
  /** Attach a doc an agent made to the task. */
  linkDoc?: (taskId: string, docId: string) => void;
  /** A doc the user tagged: its title and text (from the home, where docs live). */
  docInfo?: (id: string) => Promise<{ title: string; body: string } | null>;
  /** PRs, issues and tasks the user tagged, resolved for the message's chips. */
  mentions?: (text: string) => Promise<Mention[]>;
}

export class Rooms {
  private db: Database;
  /** Per agent: its turns, one after another. */
  private tails = new Map<string, Promise<boolean>>();
  private queued = new Map<string, number>();
  /** Per task: its writers, one at a time in the worktrees. */
  private writers = new Map<string, Promise<unknown>>();
  /** Per session: who waits for its run to end. */
  private waiting = new Map<string, () => void>();
  /** Per running session: the text it is writing now. */
  private live = new Map<string, { text: string; done: boolean }>();
  /** Per agent: what its running turn has made or changed so far. */
  private turnRefs = new Map<string, RoomRef[]>();

  constructor(private deps: RoomDeps) {
    this.db = deps.db;
    // jin restarted: a turn that was running was cut off (its session is interrupted), and turns
    // waiting behind it are gone. Each room says so once, where you look.
    for (const a of this.db.query("select * from room_agents where session_id is not null").all().map(toAgent)) {
      const s = this.session(a);
      if (s?.state !== "interrupted") continue;
      const said = this.db.query("select 1 from room_messages where task_id = ? and author = 'room' and text like ? and seq > coalesce((select max(seq) from room_messages where task_id = ? and author = ?), 0)").get(a.taskId, `@${a.handle} %`, a.taskId, a.id);
      if (!said) this.note(a.taskId, `@${a.handle} was cut off when jin restarted. Mention it again to carry on: it keeps its own history; anything you had queued for it did not run.`);
    }
    deps.sessions.onEvent((e) => {
      if (e.kind === "session.idle" || e.kind === "session.failed") {
        this.live.delete(e.sessionId);
        this.waiting.get(e.sessionId)?.();
      }
      // A finished piece of text replaces what was streamed of it; a tool call ends it.
      else if (this.live.has(e.sessionId) && e.kind === "message") this.live.set(e.sessionId, { text: String(e.payload.text ?? ""), done: true });
    });
    deps.sessions.onLive((sessionId, kind, payload) => {
      const l = this.live.get(sessionId);
      if (!l || kind !== "message.delta") return;
      // Text after a finished piece starts the next one.
      const text = (l.done ? "" : l.text) + String(payload.text ?? "");
      this.live.set(sessionId, { text: text.length > 6000 ? text.slice(-6000) : text, done: false });
    });
  }

  // ---------------------------------------------------------------- agents

  /** The room exists once looked at: with the usual three agents. */
  private ensure(taskId: string) {
    this.deps.tasks.get(taskId);
    if (this.db.query("select 1 from rooms where task_id = ?").get(taskId)) return;
    this.db.transaction(() => {
      this.db.query("insert into rooms (task_id, created_at) values (?, ?)").run(taskId, now());
      ROOM_PRESETS.forEach((p, i) => this.insertAgent(taskId, { ...p, model: null, effort: null }, i));
    })();
  }

  private insertAgent(taskId: string, a: Pick<RoomAgent, "handle" | "name" | "brief" | "access" | "color" | "model" | "effort">, position: number): string {
    const id = randomUUID();
    this.db
      .query("insert into room_agents (id, task_id, handle, name, brief, access, model, effort, color, position, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, taskId, a.handle, a.name, a.brief, a.access, a.model, a.effort, a.color, position, now());
    return id;
  }

  agents(taskId: string): RoomAgent[] {
    return this.db.query("select * from room_agents where task_id = ? order by position, created_at").all(taskId).map(toAgent);
  }

  private find(id: string): RoomAgent | null {
    const r = this.db.query("select * from room_agents where id = ?").get(id);
    return r ? toAgent(r) : null;
  }

  private agent(taskId: string, id: string): RoomAgent {
    const a = this.find(id);
    if (!a || a.taskId !== taskId) throw new HttpError(404, `no such agent in ${taskId}'s room`);
    return a;
  }

  /** The task's worktrees (one per repo), when they are there. */
  private dirsOf(taskId: string): Record<string, string> {
    try {
      return Object.fromEntries(Object.entries(this.deps.tasks.get(taskId).dirs ?? {}).filter(([, dir]) => existsSync(dir)));
    } catch {
      return {};
    }
  }

  private bySession(sessionId: string): RoomAgent | null {
    const r = this.db.query("select * from room_agents where session_id = ?").get(sessionId);
    return r ? toAgent(r) : null;
  }

  private session(a: RoomAgent): Session | null {
    if (!a.sessionId) return null;
    try {
      return this.deps.sessions.get(a.sessionId);
    } catch {
      return null;
    }
  }

  private view(a: RoomAgent): RoomAgentView {
    const s = this.session(a);
    const queued = this.queued.get(a.id) ?? 0;
    const busy = s?.state === "running" || s?.state === "waiting_approval";
    let activity: string | null = null;
    if (s && busy) {
      const last = this.db.query("select kind, payload from events where session_id = ? and kind in ('tool.started', 'message', 'prompt') order by seq desc limit 1").get(s.id) as { kind: string; payload: string } | null;
      const p = last ? (JSON.parse(last.payload) as { tool?: string; input?: Record<string, unknown> }) : null;
      activity = last?.kind === "tool.started" && p?.tool ? activityOf(p.tool, p.input ?? {}) : last?.kind === "message" ? "writing" : "thinking";
    }
    return { ...a, state: busy ? s!.state : queued > 0 ? "queued" : (s?.state ?? "new"), queued, activity, draft: (busy && s ? this.live.get(s.id)?.text : null) || null };
  }

  private checkProfile(taskId: string, p: Partial<RoomAgent>, self?: string) {
    if (p.handle !== undefined) {
      if (!HANDLE.test(p.handle) || RESERVED.has(p.handle)) throw new HttpError(400, "a handle is 2 to 24 lowercase letters, digits, - or _, starting with a letter (and not you, all or jin)");
      if (this.agents(taskId).some((a) => a.handle === p.handle && a.id !== self)) throw new HttpError(409, `@${p.handle} is already in this room`);
    }
    if (p.name !== undefined && !p.name.trim()) throw new HttpError(400, "a name is required");
    if (p.brief !== undefined && !p.brief.trim()) throw new HttpError(400, "say what this agent's role is");
    if (p.access !== undefined && p.access !== "writer" && p.access !== "read-only") throw new HttpError(400, "access is writer or read-only");
  }

  addAgent(taskId: string, p: { handle?: string; name?: string; brief?: string; access?: RoomAccess; model?: string; effort?: string; color?: string }): RoomAgentView {
    this.ensure(taskId);
    const handle = (p.handle ?? "").trim().toLowerCase().replace(/^@/, "");
    const profile = { handle, name: p.name?.trim() || handle, brief: p.brief ?? "", access: p.access ?? ("read-only" as RoomAccess) };
    this.checkProfile(taskId, profile);
    const choice = readChoice({ model: p.model, effort: p.effort });
    const all = this.agents(taskId);
    const color = (COLORS as readonly string[]).includes(p.color ?? "") ? p.color! : (COLORS.find((c) => !all.some((a) => a.color === c)) ?? COLORS[all.length % COLORS.length]!);
    const id = this.insertAgent(taskId, { ...profile, color, model: choice.model ?? null, effort: choice.effort ?? null }, (all.at(-1)?.position ?? -1) + 1);
    return this.view(this.find(id)!);
  }

  updateAgent(taskId: string, id: string, p: { handle?: string; name?: string; brief?: string; access?: RoomAccess; model?: string | null; effort?: string | null; color?: string }): RoomAgentView {
    const a = this.agent(taskId, id);
    const handle = p.handle === undefined ? undefined : p.handle.trim().toLowerCase().replace(/^@/, "");
    this.checkProfile(taskId, { ...p, handle } as Partial<RoomAgent>, id);
    // "" or null: back to jin's default model, the model's default effort.
    const choice = readChoice({ model: p.model ?? undefined, effort: p.effort ?? undefined });
    const next = {
      handle: handle ?? a.handle,
      name: p.name?.trim() ?? a.name,
      brief: p.brief ?? a.brief,
      access: p.access ?? a.access,
      model: p.model === undefined ? a.model : (choice.model ?? null),
      effort: p.effort === undefined ? a.effort : (choice.effort ?? null),
      color: p.color && (COLORS as readonly string[]).includes(p.color) ? p.color : a.color,
    };
    this.db.query("update room_agents set handle = ?, name = ?, brief = ?, access = ?, model = ?, effort = ?, color = ? where id = ?").run(next.handle, next.name, next.brief, next.access, next.model, next.effort, next.color, id);
    return this.view(this.find(id)!);
  }

  private busy(a: RoomAgent): boolean {
    const s = this.session(a)?.state;
    return s === "running" || s === "waiting_approval" || (this.queued.get(a.id) ?? 0) > 0;
  }

  private retire(a: RoomAgent) {
    if (!a.sessionId) return;
    try {
      this.deps.sessions.update(a.sessionId, { archived: true });
    } catch {
      // already gone
    }
  }

  removeAgent(taskId: string, id: string) {
    const a = this.agent(taskId, id);
    if (this.busy(a)) throw new HttpError(409, `@${a.handle} is working; stop it first`);
    this.retire(a);
    this.db.query("delete from room_agents where id = ?").run(id);
  }

  /** Start an agent over: a new session with none of its own history (it is handed the room's recent messages again). */
  fresh(taskId: string, id: string): RoomAgentView {
    const a = this.agent(taskId, id);
    if (this.busy(a)) throw new HttpError(409, `@${a.handle} is working; stop it first`);
    this.retire(a);
    this.db.query("update room_agents set session_id = null, last_seen = 0 where id = ?").run(id);
    this.note(taskId, `@${a.handle} starts fresh: its next turn begins a new session.`);
    return this.view(this.find(id)!);
  }

  stop(taskId: string, id: string): RoomAgentView {
    const a = this.agent(taskId, id);
    if (a.sessionId) this.deps.sessions.stop(a.sessionId);
    return this.view(this.find(id)!);
  }

  /** What an agent's session recorded (its own steps: for you, never for the other agents). */
  agentEvents(taskId: string, id: string, after = 0): SessionEvent[] {
    const a = this.agent(taskId, id);
    return a.sessionId && this.session(a) ? this.deps.sessions.events(a.sessionId, after) : [];
  }

  // ---------------------------------------------------------------- messages

  private add(taskId: string, author: { id: string; name: string; handle: string | null }, kind: "message" | "note", text: string, mentions: string[] = [], refs: RoomRef[] = []): RoomMessage {
    const r = this.db
      .query("insert into room_messages (task_id, author, author_name, author_handle, kind, text, mentions, refs, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning *")
      .get(taskId, author.id, author.name, author.handle, kind, text, JSON.stringify(mentions), JSON.stringify(refs), now());
    return toMessage(r);
  }

  private note(taskId: string, text: string): RoomMessage {
    return this.add(taskId, { id: "room", name: "room", handle: null }, "note", text);
  }

  private lastSeq(taskId: string): number {
    return (this.db.query("select coalesce(max(seq), 0) as n from room_messages where task_id = ?").get(taskId) as { n: number }).n;
  }

  state(taskId: string, after = 0): RoomState {
    this.ensure(taskId);
    const agents = this.agents(taskId);
    const bySession = new Map(agents.filter((a) => a.sessionId).map((a) => [a.sessionId!, a.id]));
    return {
      taskId,
      agents: agents.map((a) => this.view(a)),
      messages: this.db.query("select * from (select * from room_messages where task_id = ? and seq > ? order by seq desc limit 500) order by seq").all(taskId, after).map(toMessage),
      pinned: this.db.query("select * from room_messages where task_id = ? and pinned = 1 order by seq").all(taskId).map(toMessage),
      lastSeq: this.lastSeq(taskId),
      approvals: bySession.size
        ? this.deps.sessions
            .approvals("pending")
            .filter((p) => bySession.has(p.sessionId))
            .map((p) => ({ id: p.id, action: p.action, reason: p.reason, createdAt: p.createdAt, agentId: bySession.get(p.sessionId)! }))
        : [],
    };
  }

  /** For the task's Room tab: whether agents work or wait on you, and the last message (to mark it unread). */
  status(taskId: string): { working: number; waiting: number; lastSeq: number; name: string | null } {
    const row = this.db.query("select name from rooms where task_id = ?").get(taskId) as { name: string | null } | null;
    if (!row) return { working: 0, waiting: 0, lastSeq: 0, name: null };
    const views = this.agents(taskId).map((a) => this.view(a));
    const lastSeq = (this.db.query("select coalesce(max(seq), 0) as n from room_messages where task_id = ? and kind = 'message'").get(taskId) as { n: number }).n;
    return { working: views.filter((a) => a.state === "running" || a.state === "queued").length, waiting: views.filter((a) => a.state === "waiting_approval").length, lastSeq, name: row.name };
  }

  /** Name the room (its tab's title); an empty name goes back to "Room". */
  rename(taskId: string, name: string) {
    const n = name.trim().slice(0, 80);
    this.ensure(taskId);
    this.db.query("update rooms set name = ? where task_id = ?").run(n || null, taskId);
    return this.status(taskId);
  }

  /** Start the room over: its messages go, and every agent begins a new session. The agents (their profiles) stay. */
  clear(taskId: string) {
    this.ensure(taskId);
    const agents = this.agents(taskId);
    const working = agents.filter((a) => this.busy(a));
    if (working.length) throw new HttpError(409, `${working.map((a) => `@${a.handle}`).join(", ")} ${working.length === 1 ? "is" : "are"} working; stop ${working.length === 1 ? "it" : "them"} first`);
    for (const a of agents) this.retire(a);
    this.db.query("update room_agents set session_id = null, last_seen = 0 where task_id = ?").run(taskId);
    this.db.query("delete from room_messages where task_id = ?").run(taskId);
  }

  pin(taskId: string, seq: number, pinned: boolean): RoomMessage {
    const r = this.db.query("update room_messages set pinned = ? where task_id = ? and seq = ? returning *").get(pinned ? 1 : 0, taskId, seq);
    if (!r) throw new HttpError(404, "no such message");
    return toMessage(r);
  }

  /** An approval one of this room's agents waits on. */
  decide(taskId: string, approvalId: string, decision: "approve" | "reject") {
    const sessions = new Set(this.agents(taskId).map((a) => a.sessionId));
    const p = this.deps.sessions.approvals("pending").find((x) => x.id === approvalId);
    if (!p || !sessions.has(p.sessionId)) throw new HttpError(404, "no such approval waiting in this room");
    return this.deps.sessions.decide(approvalId, decision);
  }

  /** You, in the room: the agents you name take a turn; with none named it is said to the room, and nobody runs. */
  post(taskId: string, text: string): RoomMessage {
    this.ensure(taskId);
    if (!text?.trim()) throw new HttpError(400, "a message is required");
    const agents = this.agents(taskId);
    const named = mentionsIn(text, agents);
    const msg = this.add(taskId, { id: "you", name: "You", handle: null }, "message", text.trim(), named);
    const list = named.map((h) => agents.find((a) => a.handle === h)!);
    // Tagged docs and files first (the agents are handed them with the message), then its turns;
    // PRs, issues and tasks show as chips once resolved (the agent's own run resolves them too).
    void this.tag(taskId, msg)
      .catch(problems.catch("reading what a room message tags"))
      .finally(() => list.length && void this.dispatch(taskId, list, msg.seq));
    void this.tagMentions(msg).catch(problems.catch("resolving a room message's mentions"));
    return msg;
  }

  /** The docs and files a message tags, as its chips (a file must be in the task; a doc must exist). */
  private async tag(taskId: string, msg: RoomMessage) {
    const { docs, files } = tagsIn(msg.text);
    if (!docs.length && !files.length) return;
    const refs: RoomRef[] = [];
    for (const id of docs) {
      const d = await Promise.race([this.deps.docInfo?.(id).catch(() => null) ?? Promise.resolve(null), Bun.sleep(5000).then(() => null)]);
      if (d) refs.push({ kind: "doc", id, title: d.title, did: ["tagged"] });
    }
    const root = this.rootOf(taskId);
    for (const path of files) if (root && !path.split("/").includes("..") && existsSync(join(root, path)) && statSync(join(root, path)).isFile()) refs.push({ kind: "file", path });
    this.addRefs(msg.seq, refs);
  }

  private async tagMentions(msg: RoomMessage) {
    if (!this.deps.mentions || !new RegExp(MENTION.source).test(msg.text)) return;
    const found = await Promise.race([this.deps.mentions(msg.text), Bun.sleep(8000).then(() => [] as Mention[])]);
    this.addRefs(
      msg.seq,
      found.map((m) => ({ kind: "mention", what: m.kind, label: m.label, title: m.title, url: m.url, state: m.state })),
    );
  }

  private addRefs(seq: number, add: RoomRef[]) {
    if (!add.length) return;
    const r = this.db.query("select refs from room_messages where seq = ?").get(seq) as { refs: string } | null;
    if (!r) return;
    const refs = [...(JSON.parse(r.refs || "[]") as RoomRef[]), ...add];
    this.db.query("update room_messages set refs = ? where seq = ?").run(JSON.stringify(refs), seq);
  }

  private rootOf(taskId: string): string | null {
    try {
      const t = this.deps.tasks.get(taskId);
      return t.state === "ready" ? t.root : null;
    } catch {
      return null;
    }
  }

  /** For the agent: what each of the user's messages tagged, the docs' text included (up to a point). */
  private async tagged(delta: RoomMessage[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (const m of delta) {
      if (m.author !== "you") continue;
      const lines: string[] = [];
      for (const r of m.refs) {
        if (r.kind === "file") lines.push(`- file ${r.path} (in this task's folder; read it there)`);
        else if (r.kind === "doc" && r.did.includes("tagged")) {
          const d = await Promise.race([this.deps.docInfo?.(r.id).catch(() => null) ?? Promise.resolve(null), Bun.sleep(5000).then(() => null)]);
          const body = d?.body ?? "";
          lines.push(
            `- jin doc "${r.title}" (id ${r.id}${body.length > DOC_EXCERPT ? `; the first ${DOC_EXCERPT} characters below, your doc tools read the rest` : ""}):\n--- doc ${r.id} ---\n${body.slice(0, DOC_EXCERPT)}\n--- end of doc ${r.id} ---`,
          );
        }
      }
      if (lines.length) out.set(m.seq, `[The user tagged:]\n${lines.join("\n")}`);
    }
    return out;
  }

  // ---------------------------------------------------------------- turns

  /** Readers answer at the same time, each on its own; once a writer is named, in the order named, and a turn that fails holds the rest. */
  private async dispatch(taskId: string, list: RoomAgent[], trigger: number) {
    if (!list.some((a) => a.access === "writer")) {
      for (const a of list) void this.enqueue(a.id, trigger);
      return;
    }
    for (const [i, a] of list.entries()) {
      if (await this.enqueue(a.id, trigger)) continue;
      const rest = list.slice(i + 1);
      if (rest.length) this.note(taskId, `${rest.map((r) => `@${r.handle}`).join(", ")} did not run: @${a.handle}'s turn did not finish.`);
      return;
    }
  }

  private enqueue(agentId: string, trigger: number): Promise<boolean> {
    this.queued.set(agentId, (this.queued.get(agentId) ?? 0) + 1);
    const next = (this.tails.get(agentId) ?? Promise.resolve(true))
      .then(() => {
        this.queued.set(agentId, Math.max(0, (this.queued.get(agentId) ?? 1) - 1));
        return this.turn(agentId, trigger);
      })
      .catch((err) => {
        // A failure of jin's own (not the agent's): said in the room, and kept.
        const a = this.find(agentId);
        problems.add(`room ${a?.taskId ?? "?"}: @${a?.handle ?? agentId}'s turn`, err);
        if (a) this.note(a.taskId, `@${a.handle}'s turn hit a problem in jin: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      });
    this.tails.set(agentId, next);
    return next;
  }

  /** One writer at a time in a task's worktrees. */
  private exclusive<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.writers.get(taskId) ?? Promise.resolve()).then(fn, fn);
    this.writers.set(
      taskId,
      next.catch(() => {}),
    );
    return next;
  }

  private async turn(agentId: string, trigger: number): Promise<boolean> {
    const a = this.find(agentId);
    if (!a) return false;
    // A turn that started after this mention was posted has already answered it.
    if (trigger <= a.lastSeen) return true;
    return a.access === "writer" ? this.exclusive(a.taskId, () => this.run(agentId)) : this.run(agentId);
  }

  /** What an agent is handed: the room since its last turn, final messages only. */
  private prompt(a: RoomAgent, delta: RoomMessage[], omitted: number, first: boolean, tagged = new Map<number, string>()): string {
    const said = (m: RoomMessage) => `${m.author === "you" ? "user" : m.author === a.id ? "you (earlier)" : `@${m.authorHandle}`}: ${m.text}${tagged.has(m.seq) ? `\n${tagged.get(m.seq)}` : ""}`;
    return [
      first ? "[Agent room: the conversation so far. Of the other agents you see final messages only.]" : "[Agent room: new since your last turn. Of the other agents you see final messages only.]",
      omitted ? `(${omitted} older message${omitted === 1 ? "" : "s"} not shown; room_history reads them.)` : "",
      ...delta.map(said),
      `[The user mentioned you (@${a.handle}). Do what was asked of you; your final message is your reply to the room.]`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private async run(agentId: string): Promise<boolean> {
    const a = this.find(agentId);
    if (!a) return false;
    const { sessions } = this.deps;
    let session = this.session(a);
    const first = !session;
    const upto = this.lastSeq(a.taskId);
    // A new session (the first turn, or after a fresh start) is also handed what it said itself.
    const rows = this.db
      .query(`select * from room_messages where task_id = ? and kind = 'message' and seq > ? and seq <= ? ${first ? "" : "and author != ?"} order by seq`)
      .all(...(first ? [a.taskId, a.lastSeen, upto] : [a.taskId, a.lastSeen, upto, a.id]))
      .map(toMessage);
    const delta = rows.slice(-MAX_DELTA);
    const prompt = this.prompt(a, delta, rows.length - delta.length, first, await this.tagged(delta));
    this.db.query("update room_agents set last_seen = ? where id = ?").run(upto, a.id);

    this.turnRefs.set(a.id, []);
    // A writer's turn: the worktrees before it, to say what it changed.
    const dirs = a.access === "writer" ? this.dirsOf(a.taskId) : {};
    const before = Object.fromEntries(Object.entries(dirs).map(([repo, dir]) => [repo, treeState(dir)]));
    let sid = session?.id ?? randomUUID();
    this.live.set(sid, { text: "", done: true });
    const done = new Promise<void>((resolve) => this.waiting.set(sid, resolve));
    try {
      if (!session) {
        // The agent names its session before it starts, so the session's first run finds its role.
        this.db.query("update room_agents set session_id = ? where id = ?").run(sid, a.id);
        session = sessions.startRoom(a.taskId, prompt, `@${a.handle}`, { model: a.model ?? undefined, effort: a.effort ?? undefined }, sid);
      } else {
        // The profile's model and effort apply to every turn (null: the defaults).
        this.db.query("update sessions set model = ?, effort = ? where id = ?").run(a.model, a.effort, sid);
        sessions.send(sid, prompt);
      }
      await done;
    } catch (err) {
      this.note(a.taskId, `@${a.handle} could not start: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.waiting.delete(sid);
    }

    const state = sessions.get(sid).state;
    const author = { id: a.id, name: a.name, handle: a.handle };
    const refs = this.turnRefs.get(a.id) ?? [];
    this.turnRefs.delete(a.id);
    for (const [repo, dir] of Object.entries(dirs)) {
      const was = before[repo];
      const is = was ? treeState(dir) : null;
      const files = was && is ? changedBetween(dir, was, is) : [];
      if (files.length) refs.push({ kind: "files", repo, count: files.length, files: files.slice(0, 30) });
    }
    if (state !== "idle") {
      const failed = this.db.query("select payload from events where session_id = ? and kind = 'session.failed' order by seq desc limit 1").get(sid) as { payload: string } | null;
      const why = failed ? String((JSON.parse(failed.payload) as { error?: string }).error ?? "") : "";
      this.note(a.taskId, state === "interrupted" ? `@${a.handle} was stopped.` : `@${a.handle} failed${why ? `: ${why}` : "."}`);
      return false;
    }
    // Its final message: the last text of this run. Its steps and reasoning stay in its own session.
    const last = this.db
      .query("select payload from events where session_id = ? and kind = 'message' and seq > (select coalesce(max(seq), 0) from events where session_id = ? and kind = 'prompt') order by seq desc limit 1")
      .get(sid, sid) as { payload: string } | null;
    const text = last ? String((JSON.parse(last.payload) as { text?: string }).text ?? "").trim() : "";
    if (!text) {
      this.add(a.taskId, { id: "room", name: "room", handle: null }, "note", `@${a.handle} finished without a reply.`, [], refs);
      return true;
    }
    // Agents it names are recorded, and run nobody: only you hand a turn to an agent.
    this.add(a.taskId, author, "message", text, mentionsIn(text, this.agents(a.taskId)).filter((h) => h !== a.handle), refs);
    return true;
  }

  // ---------------------------------------------------------------- what an agent's session is given

  /** The role and the room's rules, for the agent's system prompt. */
  noteFor(session: Session): string | undefined {
    const a = this.bySession(session.id);
    if (!a) return undefined;
    const others = this.agents(a.taskId).filter((x) => x.id !== a.id);
    return [
      `You are @${a.handle} (${a.name}), one of the agents in the room of task ${a.taskId}. The user directs the room; each agent has a role of its own.`,
      others.length ? `The others: ${others.map((x) => `@${x.handle} (${x.name}, ${x.access === "writer" ? "changes the code" : "read-only"})`).join(", ")}.` : "",
      `Your role: ${a.brief}`,
      "How the room works:",
      "- You take a turn only when the user @-mentions you. With it you are given the room's messages since your last turn: the user's, and the other agents' final replies (never their reasoning or tool calls).",
      "- Only your final message is posted to the room, and it is all the others see of your turn. Make it stand on its own: what you did or concluded, where (file paths, doc ids, commands and their results), and what is still open. Be brief; no preamble.",
      "- Do not take another agent's word for a fact you can check: read the files, the diff or the doc yourself.",
      `- ${UNTRUSTED}`,
      "- Naming another agent (@handle) in your reply does not run them: the user decides who goes next. You may say who should pick something up.",
      "- room_history reads earlier messages when you need more than you were given.",
      a.access === "writer"
        ? "- You may change the code in this task's worktrees."
        : "- You are read-only here: read the code and run checks and tests, but never change, create or delete files in the worktrees, by any means (your file edits are refused; do not work around that with the shell). Changes to the code are the writer's job: describe them.",
      "- jin docs are open to every agent: jin_list_docs and jin_read_doc to read the task's specs, jin_create_doc for a new one (it is attached to this task), jin_suggest_doc_edit and jin_comment_doc to change or discuss one (the user accepts suggestions).",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** A read-only agent changing the code: refused. Its file edits always; in the shell, what plainly changes the worktree. */
  blocked(session: Session, tool: string, input: Record<string, unknown> = {}): string | null {
    if (session.kind !== "room") return null;
    const edit = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool);
    const shell = tool === "Bash" && typeof input.command === "string" && SHELL_WRITE.test(input.command);
    if (!edit && !shell) return null;
    const a = this.bySession(session.id);
    return a && a.access !== "writer" ? `@${a.handle} is read-only in this room: describe the change in your reply (the writer makes it), or put a design in a jin doc` : null;
  }

  toolsFor(session: Session): JinTool[] {
    const a = this.bySession(session.id);
    if (!a) return [];
    const taskId = a.taskId;
    // What the turn does to docs is kept, and shown with its reply.
    const docRef = (id: string) => this.turnRefs.get(a.id)?.find((r): r is DocRef => r.kind === "doc" && r.id === id);
    const did = (id: string, what: string, title?: string) => {
      const list = this.turnRefs.get(a.id);
      if (!list) return;
      const ref = docRef(id) ?? (list.push({ kind: "doc", id, title: title ?? "", did: [] }), list.at(-1) as DocRef);
      if (title) ref.title = title;
      if (!ref.did.includes(what)) ref.did.push(what);
    };
    const WHAT: Record<string, string> = { jin_suggest_doc_edit: "suggested an edit", jin_comment_doc: "commented" };
    const tools = this.deps.docTools(`@${a.handle}`);
    const titleOf = async (id: string) => {
      try {
        return String(((await tools.find((t) => t.name === "jin_read_doc")?.run({ docId: id })) as { title?: string } | undefined)?.title ?? "");
      } catch {
        return "";
      }
    };
    const docs = tools.map((t): JinTool => {
      if (WHAT[t.name])
        return {
          ...t,
          run: async (args) => {
            const out = await t.run(args);
            const id = String(args.docId ?? "");
            if (id) did(id, WHAT[t.name]!, docRef(id)?.title || (await titleOf(id)) || undefined);
            return out;
          },
        };
      if (t.name !== "jin_create_doc") return t;
      return {
        ...t,
        description: "Create a jin doc (a spec, RFC, design or notes) in markdown; it is attached to this task. Returns its id; it opens at /docs/<id>.",
        run: async (args) => {
          const tags = [...new Set([...((args.tags as string[] | undefined) ?? []), taskId.toLowerCase()])];
          const made = (await t.run({ ...args, tags })) as { id: string };
          did(made.id, "created", String(args.title ?? ""));
          try {
            this.deps.linkDoc?.(taskId, made.id);
          } catch {
            // the doc exists; only its link to the task is missing
          }
          return made;
        },
      };
    });
    const history: JinTool = {
      name: "room_history",
      description:
        "Read this room's earlier messages, oldest first: the user's, and each agent's final replies (never reasoning or tool calls). Narrow it with from (an agent's handle, or \"user\") and query (text to find); before (a seq) pages further back. Returns up to `last` messages (30 unless given, 50 at most).",
      input: { from: z.string().optional(), query: z.string().optional(), last: z.number().int().min(1).max(50).optional(), before: z.number().int().optional() },
      run: async (args) => {
        const from = (args.from as string | undefined)?.trim().toLowerCase().replace(/^@/, "");
        const q = (args.query as string | undefined)?.trim().toLowerCase();
        const n = (args.last as number | undefined) ?? 30;
        const all = this.db
          .query("select * from room_messages where task_id = ? and kind = 'message' and seq < ? order by seq")
          .all(taskId, (args.before as number | undefined) ?? Number.MAX_SAFE_INTEGER)
          .map(toMessage)
          .filter((m) => (!from || (from === "user" || from === "you" ? m.author === "you" : m.authorHandle === from)) && (!q || m.text.toLowerCase().includes(q)));
        const page = all.slice(-n);
        // You see that it looked back (once per turn is enough).
        const said = `@${a.handle} read the room's history.`;
        const lastNote = this.db.query("select text from room_messages where task_id = ? order by seq desc limit 1").get(taskId) as { text: string } | null;
        if (lastNote?.text !== said) this.note(taskId, said);
        return { messages: page.map((m) => ({ seq: m.seq, from: m.author === "you" ? "user" : `@${m.authorHandle}`, at: m.at, text: m.text })), earlier: all.length - page.length };
      },
    };
    return [...docs, history];
  }

  /** A removed task's room goes with it. */
  removeTask(taskId: string) {
    for (const a of this.agents(taskId)) {
      if (!a.sessionId) continue;
      try {
        this.deps.sessions.remove(a.sessionId);
      } catch {
        // already gone
      }
    }
    this.db.query("delete from room_agents where task_id = ?").run(taskId);
    this.db.query("delete from room_messages where task_id = ?").run(taskId);
    this.db.query("delete from rooms where task_id = ?").run(taskId);
  }
}

export function roomRoutes(router: Router, rooms: Rooms) {
  type Profile = { handle?: string; name?: string; brief?: string; access?: RoomAccess; model?: string; effort?: string; color?: string };
  router
    .on("GET", "/api/tasks/:id/room", (_req, p, url) => json(rooms.state(p.id!, Number(url.searchParams.get("after") ?? 0))))
    .on("GET", "/api/tasks/:id/room/status", (_req, p) => json(rooms.status(p.id!)))
    .on("PATCH", "/api/tasks/:id/room", async (req, p) => json(rooms.rename(p.id!, String((await body<{ name?: unknown }>(req)).name ?? ""))))
    .on("DELETE", "/api/tasks/:id/room/messages", (_req, p) => {
      rooms.clear(p.id!);
      return json({ cleared: true });
    })
    .on("POST", "/api/tasks/:id/room/messages", async (req, p) => json(rooms.post(p.id!, (await body<{ text: string }>(req)).text), 201))
    .on("PATCH", "/api/tasks/:id/room/messages/:seq", async (req, p) => json(rooms.pin(p.id!, Number(p.seq), Boolean((await body<{ pinned?: boolean }>(req)).pinned))))
    .on("POST", "/api/tasks/:id/room/agents", async (req, p) => json(rooms.addAgent(p.id!, await body<Profile>(req)), 201))
    .on("PATCH", "/api/tasks/:id/room/agents/:aid", async (req, p) => json(rooms.updateAgent(p.id!, p.aid!, await body<Profile>(req))))
    .on("DELETE", "/api/tasks/:id/room/agents/:aid", (_req, p) => {
      rooms.removeAgent(p.id!, p.aid!);
      return json({ removed: true });
    })
    .on("POST", "/api/tasks/:id/room/agents/:aid/fresh", (_req, p) => json(rooms.fresh(p.id!, p.aid!)))
    .on("POST", "/api/tasks/:id/room/agents/:aid/stop", (_req, p) => json(rooms.stop(p.id!, p.aid!)))
    .on("GET", "/api/tasks/:id/room/agents/:aid/events", (_req, p, url) => json(rooms.agentEvents(p.id!, p.aid!, Number(url.searchParams.get("after") ?? 0))))
    .on("POST", "/api/tasks/:id/room/approvals/:apid", async (req, p) => {
      const { decision } = await body<{ decision: string }>(req);
      if (decision !== "approve" && decision !== "reject") throw new HttpError(400, "decision must be approve or reject");
      return json(rooms.decide(p.id!, p.apid!, decision));
    });
}
