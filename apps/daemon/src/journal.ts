import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import { now } from "./db";
import { body, HttpError, json, type Router } from "./http";

/**
 * A task's work journal, kept as rows of jin's memory (one table for every memory artifact; a
 * task's journal is its task-level rows). Claude Code writes the decisions, the work done and what it found,
 * each under a concern (through jin's `journal` MCP tool); jin's hooks add the evidence: the
 * files it changed, its commits and test runs, attached to its latest entry in the same turn.
 * Changes with no entry in their turn are kept as "not journaled", so gaps show.
 */

export type JournalKind = "decision" | "done" | "found";
export const JOURNAL_KINDS: JournalKind[] = ["decision", "done", "found"];

export interface JournalRef {
  type: "file" | "commit" | "test";
  text: string;
}

export interface JournalEntry {
  id: string;
  taskId: string;
  terminalId: string | null;
  session: string | null;
  concern: string | null;
  kind: JournalKind | "change";
  text: string;
  why: string | null;
  refs: JournalRef[];
  at: string;
  /** Memory: "task" (the task's own) until promoted; the workspace it belongs to. */
  level: "task" | "global";
  workspace: string | null;
  /** A row a later one replaced is kept, "superseded". */
  status: "active" | "superseded" | "dropped";
  supersedes: string | null;
}

export interface JournalView {
  concerns: { name: string; startedAt: string; lastAt: string; entries: JournalEntry[] }[];
  /** Changes made in turns with no journal entry. */
  unjournaled: JournalEntry[];
}

/** Who a terminal is: its task, its tab title, and the task's folder (for short file paths). */
export type TerminalOf = (terminalId: string) => { taskId: string | null; title: string; root?: string; checks?: RegExp[] } | null;

const toEntry = (r: any): JournalEntry => ({
  id: r.id,
  taskId: r.task_id,
  terminalId: r.terminal_id,
  session: r.session,
  concern: r.concern,
  kind: r.kind,
  text: r.text,
  why: r.why,
  refs: JSON.parse(r.refs ?? "[]"),
  at: r.at,
  level: r.level ?? "task",
  workspace: r.workspace ?? null,
  status: r.status ?? "active",
  supersedes: r.supersedes ?? null,
});

const TEST_CMD = /\b(bun test|vitest|jest|pytest|go test|cargo test|(?:npm|pnpm|yarn)(?: run)? test|make test)\b/;
const COMMIT_CMD = /\bgit\s+commit\b/;

/** The evidence one tool call leaves: a changed file, a commit, a test run; null for the rest. */
/** `checks`: the workspace's own check commands (its provider's), which count as test runs. */
export function evidenceOf(tool: string, input: Record<string, unknown>, root?: string, checks: RegExp[] = []): JournalRef | null {
  const path = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
  if (path && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return { type: "file", text: root && path.startsWith(root) ? relative(root, path) : path };
  if (tool === "Bash" && typeof input.command === "string") {
    const cmd = input.command.trim();
    if (COMMIT_CMD.test(cmd)) {
      const m = /-m\s+(?:"([^"]+)"|'([^']+)')/.exec(cmd);
      return { type: "commit", text: (m?.[1] ?? m?.[2] ?? "commit").split("\n")[0]!.slice(0, 120) };
    }
    if (TEST_CMD.test(cmd) || checks.some((c) => c.test(cmd))) return { type: "test", text: cmd.length > 80 ? `${cmd.slice(0, 79)}…` : cmd };
  }
  return null;
}

export class Journal {
  /** Each terminal's latest entry in its current turn (evidence attaches there), and its "not journaled" row. */
  private current = new Map<string, { entry: string | null; change: string | null }>();

  constructor(
    private db: Database,
    private terminalOf: TerminalOf,
    private opts: { workspaceOf?: (taskId: string) => string | null } = {},
  ) {}

  private concerns(taskId: string): string[] {
    return (this.db.query("select concern from memory where task_id = ? and concern is not null group by concern order by min(at)").all(taskId) as { concern: string }[]).map((r) => r.concern);
  }

  /** Claude Code writes an entry. Returns the reply it sees: short, with the existing concerns when it names a new one. */
  add(terminalId: string, e: { concern?: string; kind?: string; text?: string; why?: string; supersedes?: string }): { entry: JournalEntry; reply: string } {
    const t = this.terminalOf(terminalId);
    if (!t?.taskId) throw new HttpError(400, "the journal is for Claude Code in a task");
    return this.write(t.taskId, { terminalId, session: t.title }, e);
  }

  /** Write a row of a task's journal, for an agent named `session` (a tab's title, a room agent's @handle). */
  write(taskId: string, by: { terminalId: string | null; session: string }, e: { concern?: string; kind?: string; text?: string; why?: string; supersedes?: string }): { entry: JournalEntry; reply: string } {
    const terminalId = by.terminalId;
    const t = { taskId, title: by.session };
    const name = (e.concern ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    const text = (e.text ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
    if (!name || !text) throw new HttpError(400, "concern and text are required");
    if (!JOURNAL_KINDS.includes(e.kind as JournalKind)) throw new HttpError(400, `kind must be one of ${JOURNAL_KINDS.join(", ")}`);
    const existing = this.concerns(t.taskId);
    // The same concern in another case or spacing is that concern.
    const same = existing.find((c) => c.toLowerCase() === name.toLowerCase());
    const concern = same ?? name;
    // A row replaces another of the same task; the old one stays, marked.
    const supersedes = e.supersedes?.trim() || null;
    if (supersedes) {
      const old = this.db.query("select task_id from memory where id = ?").get(supersedes) as { task_id: string } | null;
      if (!old || old.task_id !== t.taskId) throw new HttpError(400, `${supersedes} is not in this task's memory`);
    }
    const workspace = this.opts.workspaceOf?.(t.taskId) ?? null;
    const entry: JournalEntry = { id: randomUUID(), taskId: t.taskId, terminalId, session: t.title, concern, kind: e.kind as JournalKind, text, why: e.why?.trim().slice(0, 300) || null, refs: [], at: now(), level: "task", workspace, status: "active", supersedes };
    this.db.transaction(() => {
      this.db
        .query("insert into memory (id, task_id, terminal_id, session, concern, kind, text, why, refs, at, level, workspace, status, supersedes) values (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'task', ?, 'active', ?)")
        .run(entry.id, entry.taskId, terminalId, entry.session, concern, entry.kind, text, entry.why, entry.at, workspace, supersedes);
      if (supersedes) this.db.query("update memory set status = 'superseded' where id = ?").run(supersedes);
    })();
    if (terminalId) this.current.set(terminalId, { entry: entry.id, change: null });
    const reply = same || !existing.length ? "ok" : `ok; new concern "${concern}" (existing: ${existing.slice(0, 12).join(", ")})`;
    return { entry, reply };
  }

  /** A new turn began in a terminal (the user sent a prompt). */
  turnStarted(terminalId: string) {
    this.current.set(terminalId, { entry: null, change: null });
  }

  /** A tool call finished: its evidence goes on the terminal's latest entry of this turn, else into "not journaled". */
  evidence(terminalId: string, tool: string, input: Record<string, unknown>) {
    const t = this.terminalOf(terminalId);
    if (!t?.taskId) return;
    const ref = evidenceOf(tool, input, t.root, t.checks);
    if (!ref) return;
    const cur = this.current.get(terminalId) ?? { entry: null, change: null };
    const target = cur.entry ?? cur.change;
    const row = target ? (this.db.query("select refs from memory where id = ?").get(target) as { refs: string } | null) : null;
    if (target && row) {
      const refs = JSON.parse(row.refs) as JournalRef[];
      if (!refs.some((r) => r.type === ref.type && r.text === ref.text)) {
        refs.push(ref);
        this.db.query("update memory set refs = ? where id = ?").run(JSON.stringify(refs.slice(-50)), target);
      }
      return;
    }
    // Nothing journaled yet this turn: one "change" row per turn collects the evidence.
    const id = randomUUID();
    this.db
      .query("insert into memory (id, task_id, terminal_id, session, concern, kind, text, why, refs, at, workspace) values (?, ?, ?, ?, null, 'change', 'Changes without a journal entry', null, ?, ?, ?)")
      .run(id, t.taskId, terminalId, t.title, JSON.stringify([ref]), now(), this.opts.workspaceOf?.(t.taskId) ?? null);
    this.current.set(terminalId, { entry: null, change: id });
  }

  /** Journal entries (not the unjournaled changes) since a time, across tasks, newest first. */
  recent(since: string, limit = 200): JournalEntry[] {
    return (this.db.query("select * from memory where at > ? and concern is not null order by at desc, rowid desc limit ?").all(since, limit) as any[]).map(toEntry);
  }

  /**
   * Rows whose text, reason or concern has every word of `query` (best matches first), within a
   * workspace when given; superseded and dropped rows only when asked. What is typed is words to
   * find, never query syntax.
   */
  search(query: string, opts: { workspace?: string; superseded?: boolean; limit?: number } = {}): JournalEntry[] {
    const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!words.length) return [];
    const match = words.map((w) => `"${w}"`).join(" ");
    const where = ["memory_fts match ?", "m.concern is not null"];
    const args: (string | number)[] = [match];
    if (opts.workspace) (where.push("m.workspace = ?"), args.push(opts.workspace));
    if (!opts.superseded) where.push("m.status = 'active'");
    args.push(Math.min(opts.limit ?? 20, 100));
    return (this.db.query(`select m.* from memory_fts join memory m on m.rowid = memory_fts.rowid where ${where.join(" and ")} order by bm25(memory_fts) limit ?`).all(...args) as any[]).map(toEntry);
  }

  /** The task's live rows (its journal entries, superseded and dropped ones left out), oldest first. */
  forTask(taskId: string): JournalEntry[] {
    return (this.db.query("select * from memory where task_id = ? and concern is not null and status = 'active' order by at, rowid").all(taskId) as any[]).map(toEntry);
  }

  /** The task's live rows as text, for any agent in the task (tabs, room, subtasks): by concern, each with who wrote it. */
  contextText(taskId: string): string {
    const rows = this.forTask(taskId);
    if (!rows.length) return "Nothing in this task's journal yet.";
    const byConcern = new Map<string, JournalEntry[]>();
    for (const e of rows) byConcern.set(e.concern!, [...(byConcern.get(e.concern!) ?? []), e]);
    const lines = ["This task's journal so far, from every agent in it (decisions, work done, findings; replaced entries left out):"];
    for (const [concern, list] of byConcern) {
      lines.push(`\n${concern}`);
      for (const e of list) lines.push(`- ${e.kind}: ${e.text}${e.why ? ` (why: ${e.why})` : ""} [${e.session ?? "?"}, id ${e.id}]`);
    }
    return lines.join("\n");
  }

  /** The task's journal: concerns in the order they started, entries in order within each. */
  view(taskId: string): JournalView {
    const rows = (this.db.query("select * from memory where task_id = ? order by at, rowid").all(taskId) as any[]).map(toEntry);
    const byConcern = new Map<string, JournalView["concerns"][number]>();
    const unjournaled: JournalEntry[] = [];
    for (const e of rows) {
      if (!e.concern) {
        unjournaled.push(e);
        continue;
      }
      const c = byConcern.get(e.concern) ?? { name: e.concern, startedAt: e.at, lastAt: e.at, entries: [] };
      c.entries.push(e);
      c.lastAt = e.at;
      byConcern.set(e.concern, c);
    }
    return { concerns: [...byConcern.values()], unjournaled };
  }
}

export function journalRoutes(router: Router, journal: Journal) {
  router
    .on("POST", "/api/terminals/:id/journal", async (req, p) => {
      const r = journal.add(p.id!, await body<{ concern?: string; kind?: string; text?: string; why?: string }>(req));
      return json(r, 201);
    })
    .on("GET", "/api/tasks/:id/journal", (_req, p) => json(journal.view(p.id!)))
    .on("GET", "/api/journal/recent", (_req, _p, url) => json(journal.recent(url.searchParams.get("since") ?? new Date(Date.now() - 86_400_000).toISOString())));
}
