import type { Database } from "bun:sqlite";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { TITLE_MODEL } from "./titles";
import { now } from "./db";
import { body, HttpError, json, type Router } from "./http";
import type { Journal, JournalEntry } from "./journal";

/**
 * A task's pre-context: of the long-term memory of its workspace (what earlier tasks kept), what
 * bears on this task. jin picks it when the task's agents first need it (a small model reads the
 * task and the candidates); you add or remove picks. Picks are links to the rows (which live on
 * the home), never copies, so agents read each row as it is now.
 */

export interface Pick {
  memoryId: string;
  reason: string | null;
  by: "jin" | "you";
}

const STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "into", "under", "over", "when", "what", "task", "fix", "add", "use"]);

/** Candidates for a task: rows matching its words (best first), then the workspace's recent decisions; at most 50. */
export function candidatesFor(journal: Pick_<Journal, "search" | "recentGlobal">, workspace: string | null, text: string): JournalEntry[] {
  if (!workspace) return [];
  const words = [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => w.length > 2 && !STOP.has(w)))];
  const out = new Map<string, JournalEntry>();
  if (words.length) {
    // Rows that cover more of the task's words first (the index's own rank breaks ties).
    const covers = (e: JournalEntry) => {
      const hay = `${e.text} ${e.why ?? ""} ${e.concern ?? ""}`.toLowerCase();
      return words.filter((w) => hay.includes(w)).length;
    };
    const hits = journal.search(words.join(" "), { workspace, level: "global", any: true, limit: 40 });
    for (const e of hits.map((e, i) => ({ e, i, n: covers(e) })).sort((a, b) => b.n - a.n || a.i - b.i).map((x) => x.e)) out.set(e.id, e);
  }
  for (const e of journal.recentGlobal(workspace, 20)) if (!out.has(e.id)) out.set(e.id, e);
  return [...out.values()].slice(0, 50);
}
type Pick_<T, K extends keyof T> = { [P in K]: T[P] };

export interface PreContextDeps {
  /** The task's workspace, and what it is about (its title, issue, links), in a few lines. */
  task: (taskId: string) => { workspace: string | null; brief: string };
  /** Candidates from long-term memory (the home's when there is one). */
  candidates: (workspace: string | null, text: string) => Promise<JournalEntry[]>;
  /** Long-term rows by id, as they are now. */
  rows: (ids: string[]) => Promise<JournalEntry[]>;
  /** The small model's pick: candidates that bear on the task, each with why. */
  choose: (brief: string, candidates: JournalEntry[]) => Promise<{ id: string; reason: string }[]>;
}

export class PreContext {
  private picking = new Map<string, Promise<void>>();

  constructor(
    private db: Database,
    private deps: PreContextDeps,
  ) {}

  list(taskId: string): Pick[] {
    return (this.db.query("select memory_id, reason, by from task_context where task_id = ? order by at, rowid").all(taskId) as { memory_id: string; reason: string | null; by: "jin" | "you" }[]).map((r) => ({ memoryId: r.memory_id, reason: r.reason, by: r.by }));
  }

  private picked(taskId: string): boolean {
    return Boolean(this.db.query("select 1 from task_context where task_id = ? limit 1").get(taskId)) || Boolean(this.db.query("select 1 from settings where key = ?").get(`precontext:${taskId}`));
  }

  /** Pick (again): jin's earlier picks go, yours stay. */
  async select(taskId: string): Promise<Pick[]> {
    const t = this.deps.task(taskId);
    // The task's own kept rows are in its journal already.
    const candidates = (await this.deps.candidates(t.workspace, t.brief)).filter((c) => c.taskId !== taskId);
    const chosen = candidates.length ? await this.deps.choose(t.brief, candidates) : [];
    const known = new Set(candidates.map((c) => c.id));
    const at = now();
    this.db.transaction(() => {
      this.db.query("delete from task_context where task_id = ? and by = 'jin'").run(taskId);
      for (const c of chosen) if (known.has(c.id)) this.db.query("insert or ignore into task_context (task_id, memory_id, reason, by, at) values (?, ?, ?, 'jin', ?)").run(taskId, c.id, c.reason?.slice(0, 200) || null, at);
      // Picked once, even when nothing fit: the next agent does not ask again.
      this.db.query("insert or replace into settings (key, value) values (?, ?)").run(`precontext:${taskId}`, at);
    })();
    return this.list(taskId);
  }

  /** Pick once, when the task's agents first need it; never twice at the same time. */
  ensure(taskId: string): Promise<void> {
    if (this.picked(taskId)) return Promise.resolve();
    const running = this.picking.get(taskId);
    if (running) return running;
    const p = this.select(taskId)
      .then(() => {})
      .catch(() => {})
      .finally(() => this.picking.delete(taskId));
    this.picking.set(taskId, p);
    return p;
  }

  add(taskId: string, memoryId: string, reason?: string) {
    if (!memoryId) throw new HttpError(400, "a memory id is required");
    this.db.query("insert into task_context (task_id, memory_id, reason, by, at) values (?, ?, ?, 'you', ?) on conflict (task_id, memory_id) do update set by = 'you', reason = coalesce(excluded.reason, task_context.reason)").run(taskId, memoryId, reason ?? null, now());
  }

  remove(taskId: string, memoryId: string) {
    this.db.query("delete from task_context where task_id = ? and memory_id = ?").run(taskId, memoryId);
  }

  /** For the task's agents: each pick as its row reads now, with why it is there ("" when there are none). */
  async text(taskId: string): Promise<string> {
    const picks = this.list(taskId);
    if (!picks.length) return "";
    const rows = new Map((await this.deps.rows(picks.map((p) => p.memoryId))).map((r) => [r.id, r]));
    const lines = picks.flatMap((p) => {
      const r = rows.get(p.memoryId);
      return r ? [`- ${r.kind}: ${r.text}${p.reason ? ` (why it is here: ${p.reason})` : ""} [from ${r.taskId}, id ${r.id}]`] : [];
    });
    return lines.length ? ["What earlier tasks in this workspace kept that bears on this one (memory_search finds more):", ...lines].join("\n") : "";
  }
}

const CHOOSE =
  "You pick what an agent starting a task should know from long-term memory (what earlier tasks in the same workspace kept). Below are the task and the candidates. Pick only candidates that bear on this task's work: a decision it must respect, a fact about a system it touches, a summary of closely related work. Fewer is better; none is fine. Reply with JSON only: an array of {\"id\": ..., \"reason\": ...} (reason: a few words on why it bears on the task), at most 8.";

/** A small model picks (the same one that titles chats); on any failure, nothing is picked. */
export function haikuChooser(env: () => Record<string, string> = () => ({})): PreContextDeps["choose"] {
  return async (brief, candidates) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const list = candidates.map((c) => `${c.id}: ${c.kind}${c.concern ? ` (${c.concern})` : ""}: ${c.text}${c.why ? ` (why: ${c.why})` : ""}`).join("\n");
      let text = "";
      const q = query({
        prompt: `${CHOOSE}\n\n<task>\n${brief.slice(0, 3000)}\n</task>\n\n<candidates>\n${list.slice(0, 20000)}\n</candidates>`,
        options: { model: TITLE_MODEL, maxTurns: 1, settingSources: [], allowedTools: [], canUseTool: async () => ({ behavior: "deny", message: "no tools" }), env: { ...process.env, ...env() } as Record<string, string>, abortController: controller },
      });
      for await (const m of q) if (m.type === "result" && m.subtype === "success") text = m.result;
      const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
      const picked = JSON.parse(json || "[]") as { id?: unknown; reason?: unknown }[];
      return picked.filter((p) => typeof p.id === "string").slice(0, 8).map((p) => ({ id: p.id as string, reason: typeof p.reason === "string" ? p.reason : "" }));
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Tests: the first few candidates. */
export const scriptedChooser: PreContextDeps["choose"] = async (_brief, candidates) => candidates.slice(0, 3).map((c) => ({ id: c.id, reason: "matches the task" }));

/** A task's pre-context for the app: the picks with their rows as they are now; refresh, add, remove. */
export function preContextRoutes(router: Router, pre: PreContext, rows: (ids: string[]) => Promise<JournalEntry[]>) {
  const view = async (taskId: string) => {
    const picks = pre.list(taskId);
    const byId = new Map((picks.length ? await rows(picks.map((p) => p.memoryId)) : []).map((r) => [r.id, r]));
    return { picks: picks.map((p) => ({ ...p, row: byId.get(p.memoryId) ?? null })) };
  };
  router
    .on("GET", "/api/tasks/:id/pre-context", async (_req, p) => json(await view(p.id!)))
    .on("POST", "/api/tasks/:id/pre-context/refresh", async (_req, p) => {
      await pre.select(p.id!);
      return json(await view(p.id!));
    })
    .on("POST", "/api/tasks/:id/pre-context", async (req, p) => {
      const b = await body<{ memoryId?: string; reason?: string }>(req);
      pre.add(p.id!, String(b.memoryId ?? ""), b.reason);
      return json(await view(p.id!), 201);
    })
    .on("DELETE", "/api/tasks/:id/pre-context/:mid", async (_req, p) => {
      pre.remove(p.id!, p.mid!);
      return json(await view(p.id!));
    });
}
