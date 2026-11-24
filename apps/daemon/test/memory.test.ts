import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, openDb } from "../src/db";
import { Journal, keepMemory } from "../src/journal";

/**
 * Phase 1 of jin's memory: one table for every memory artifact (a task's journal is its rows;
 * promotion, later, raises a row's level), searchable, with superseding instead of overwriting.
 */

const terms: Record<string, { taskId: string | null; title: string }> = { t1: { taskId: "PLEN-1", title: "Claude 1" }, t2: { taskId: "PLEN-2", title: "Codex 1" } };
const workspaces: Record<string, string> = { "PLEN-1": "composio", "PLEN-2": "jin" };
const setup = () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "jin-memory-")));
  return { db, j: new Journal(db, (id) => terms[id] ?? null, { workspaceOf: (taskId) => workspaces[taskId] ?? null }) };
};

test("memory: the migration keeps every journal entry, as task-level active rows in the task's workspace", () => {
  const home = mkdtempSync(join(tmpdir(), "jin-memory-mig-"));
  // A database as it was before memory: every migration up to the one that makes it.
  const at = MIGRATIONS.findIndex((m) => /alter table journal rename to memory/i.test(m));
  expect(at).toBeGreaterThan(0);
  const old = new Database(join(home, "jin.db"), { create: true, strict: true });
  for (let i = 0; i < at; i++) old.exec(MIGRATIONS[i]!);
  old.exec(`pragma user_version = ${at}`);
  old.query("insert into tasks (id, workspace, type, slug, repos, dirs, state, created_at) values ('PLEN-1', 'composio', 'feature', 'x', '[]', '{}', 'ready', '2026-01-01')").run();
  const rows = [
    ["a", "PLEN-1", "t1", "Claude 1", "rate limiter", "decision", "Retry on 429", "Retry-After is unreliable", '[{"type":"file","text":"x.py"}]', "2026-01-01T00:00:01Z"],
    ["b", "PLEN-1", "t1", "Claude 1", null, "change", "Changes without a journal entry", null, "[]", "2026-01-01T00:00:02Z"],
    ["c", "GONE-9", null, "Claude 2", "tests", "done", "Added tests", null, "[]", "2026-01-01T00:00:03Z"],
  ];
  for (const r of rows) old.query("insert into journal (id, task_id, terminal_id, session, concern, kind, text, why, refs, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...r);
  old.close();

  const db = openDb(home);
  const after = db.query("select id, task_id, terminal_id, session, concern, kind, text, why, refs, at, level, workspace, status, supersedes from memory order by at").all() as Record<string, unknown>[];
  expect(after.map((r) => [r.id, r.task_id, r.terminal_id, r.session, r.concern, r.kind, r.text, r.why, r.refs, r.at])).toEqual(rows);
  expect(after.map((r) => [r.level, r.workspace, r.status, r.supersedes])).toEqual([
    ["task", "composio", "active", null],
    ["task", "composio", "active", null],
    // A task jin no longer knows: its workspace is unknown, the entry stays.
    ["task", null, "active", null],
  ]);
});

test("memory: the journal reads as before (concerns in order, unjournaled changes apart), with each row's level and status", () => {
  const { j } = setup();
  j.add("t1", { concern: "rate limiter", kind: "decision", text: "Retry on 429", why: "Retry-After is unreliable" });
  j.add("t1", { concern: "tests", kind: "done", text: "Added limiter tests" });
  j.evidence("t1", "Edit", { file_path: "/x/limiter.py" });
  j.turnStarted("t1");
  j.evidence("t1", "Bash", { command: "bun test" });
  const v = j.view("PLEN-1");
  expect(v.concerns.map((c) => [c.name, c.entries.map((e) => e.text)])).toEqual([
    ["rate limiter", ["Retry on 429"]],
    ["tests", ["Added limiter tests"]],
  ]);
  expect(v.concerns[1]!.entries[0]).toMatchObject({ refs: [{ type: "file", text: "/x/limiter.py" }], level: "task", status: "active", workspace: "composio", supersedes: null });
  expect(v.unjournaled.map((e) => e.refs)).toEqual([[{ type: "test", text: "bun test" }]]);
});

test("memory: search finds rows by their text, reason or concern, within a workspace, leaving out superseded ones", () => {
  const { j } = setup();
  j.add("t1", { concern: "rate limiter", kind: "decision", text: "Retry on 429 in the proxy", why: "per-call retries doubled Stripe errors" });
  const old = j.add("t1", { concern: "auth", kind: "found", text: "Tokens refresh every hour" }).entry;
  j.add("t1", { concern: "auth", kind: "found", text: "Tokens refresh every 15 minutes", supersedes: old.id });
  j.add("t2", { concern: "rate limiter", kind: "decision", text: "No retries in the desktop app" });

  expect(j.search("stripe", { workspace: "composio" }).map((e) => e.text)).toEqual(["Retry on 429 in the proxy"]);
  expect(j.search("rate limiter", { workspace: "composio" }).map((e) => e.text)).toEqual(["Retry on 429 in the proxy"]);
  expect(j.search("rate limiter").map((e) => e.text).sort()).toEqual(["No retries in the desktop app", "Retry on 429 in the proxy"]);
  expect(j.search("tokens refresh", { workspace: "composio" }).map((e) => e.text)).toEqual(["Tokens refresh every 15 minutes"]);
  expect(j.search("tokens refresh", { workspace: "composio", superseded: true }).map((e) => e.text).sort()).toEqual(["Tokens refresh every 15 minutes", "Tokens refresh every hour"]);
  // Odd input is words to find, not query syntax.
  expect(j.search('"auth" OR (', { workspace: "composio" })).toEqual([]);
});

test("memory: a row supersedes an earlier one in its task: the old one is kept, marked, and out of the task's live context", () => {
  const { j } = setup();
  const first = j.add("t1", { concern: "auth", kind: "decision", text: "Use API keys", why: "simplest" }).entry;
  const second = j.add("t1", { concern: "auth", kind: "decision", text: "Use OAuth", why: "keys leak", supersedes: first.id }).entry;
  expect(second.supersedes).toBe(first.id);
  const auth = j.view("PLEN-1").concerns.find((c) => c.name === "auth")!;
  expect(auth.entries.map((e) => [e.text, e.status])).toEqual([
    ["Use API keys", "superseded"],
    ["Use OAuth", "active"],
  ]);
  expect(j.forTask("PLEN-1").map((e) => e.text)).toEqual(["Use OAuth"]);
  // Only a row of the same task can be superseded.
  expect(() => j.add("t2", { concern: "auth", kind: "decision", text: "x", supersedes: second.id })).toThrow("not in this task");
});

test("memory: rows written before workspaces get their task's when jin knows it", () => {
  const { db, j } = setup();
  db.query("insert into memory (id, task_id, session, concern, kind, text, refs, at) values ('x', 'PLEN-2', 'Claude 1', 'c', 'done', 't', '[]', '2026-01-01'), ('y', 'GONE-1', 'Claude 1', 'c', 'done', 't', '[]', '2026-01-01')").run();
  expect(j.fillWorkspaces()).toBe(1);
  expect(db.query("select id, workspace from memory order by id").all()).toEqual([
    { id: "x", workspace: "jin" },
    { id: "y", workspace: null },
  ]);
});

// ---------------------------------------------------------------- phase 2: promotion and long-term search

test("memory p2: promoting raises the row itself to long-term; rewording keeps the task's wording; dropping takes a row out", () => {
  const { db, j } = setup();
  const decision = j.add("t1", { concern: "rate limiter", kind: "decision", text: "Retry in keyring/src/proxy.ts", why: "per-call retries doubled 429s" }).entry;
  const found = j.add("t1", { concern: "auth", kind: "found", text: "Tokens refresh every 15 minutes" }).entry;
  const done = j.add("t1", { concern: "tests", kind: "done", text: "Added limiter tests" }).entry;
  const kept = j.promote("PLEN-1", [{ id: decision.id, text: "Retries belong in the proxy layer, not per call" }, { id: found.id }], "jin");
  expect(kept.map((e) => [e.text, e.level, e.status])).toEqual([
    ["Retries belong in the proxy layer, not per call", "global", "active"],
    ["Tokens refresh every 15 minutes", "global", "active"],
  ]);
  expect(db.query("select task_text, promoted_by from memory where id = ?").get(decision.id)).toEqual({ task_text: "Retry in keyring/src/proxy.ts", promoted_by: "jin" });
  j.drop("PLEN-1", [done.id]);
  expect(j.forTask("PLEN-1").map((e) => e.text)).toEqual(["Retries belong in the proxy layer, not per call", "Tokens refresh every 15 minutes"]);
  expect(j.search("proxy layer", { workspace: "composio", level: "global" }).map((e) => e.id)).toEqual([decision.id]);
  expect(j.search("limiter tests", { level: "global" })).toEqual([]);
  // Only the task's own rows.
  expect(() => j.promote("PLEN-2", [{ id: found.id }], "jin")).toThrow("not in this task");
});

test("memory p2: a summary row records what the task did, long-term, in its workspace, with ids of what it touched", () => {
  const { j } = setup();
  const s = j.summarize("PLEN-1", { text: "Moved retries into the proxy; 429s halved.", refs: ["github:composiohq/platform#140", "linear:PLEN-1"], by: "jin" });
  expect(s).toMatchObject({ taskId: "PLEN-1", kind: "summary", concern: "summary", level: "global", workspace: "composio", status: "active" });
  expect(s.refs).toEqual([
    { type: "id", text: "github:composiohq/platform#140" },
    { type: "id", text: "linear:PLEN-1" },
  ]);
  expect(j.search("429s halved", { workspace: "composio", level: "global" }).map((e) => e.id)).toEqual([s.id]);
});

test("memory p2: the home takes promoted rows as the same artifacts: same id, their machine; taking one again updates it", () => {
  const { j } = setup();
  const home = setup().j;
  const e = j.add("t1", { concern: "auth", kind: "found", text: "Tokens refresh every 15 minutes" }).entry;
  const [kept] = j.promote("PLEN-1", [{ id: e.id }], "jin");
  home.importGlobal([kept!], "mac");
  expect(home.search("tokens refresh", { level: "global" }).map((x) => [x.id, x.machine, x.taskId])).toEqual([[e.id, "mac", "PLEN-1"]]);
  home.importGlobal([{ ...kept!, text: "Tokens refresh every 10 minutes" }], "mac");
  expect(home.search("tokens refresh", { level: "global" }).map((x) => x.text)).toEqual(["Tokens refresh every 10 minutes"]);
});

test("memory p2: keeping a task's memory promotes, drops and summarizes on its machine, and the home gets the results", async () => {
  const { j } = setup();
  const home = setup().j;
  const a = j.add("t1", { concern: "limiter", kind: "decision", text: "Retry in the proxy", why: "fewer 429s" }).entry;
  const b = j.add("t1", { concern: "limiter", kind: "found", text: "A dead end with jitter" }).entry;
  const out = await keepMemory(
    { task: { promote: async (items, by) => j.promote("PLEN-1", items, by), drop: async (ids) => j.drop("PLEN-1", ids), summarize: async (s) => j.summarize("PLEN-1", s) }, home, machine: "mac" },
    { promote: [{ id: a.id, text: "Retries belong in the proxy layer" }], drop: [b.id], summary: { text: "Retries moved to the proxy.", refs: ["linear:PLEN-1"] } },
  );
  expect(out).toEqual({ kept: 1, dropped: 1, summary: expect.any(String) });
  expect(home.search("proxy", { level: "global" }).map((e) => [e.kind, e.machine]).sort()).toEqual([
    ["decision", "mac"],
    ["summary", "mac"],
  ]);
  expect(j.forTask("PLEN-1").map((e) => e.text)).toEqual(["Retries belong in the proxy layer"]);
});

// ---------------------------------------------------------------- phase 4: the Memory page

test("memory p4: the Memory page lists kept rows newest first; you reword one (its first wording kept) or forget it", () => {
  const { db, j } = setup();
  const a = j.add("t1", { concern: "auth", kind: "found", text: "Tokens refresh every 15 minutes" }).entry;
  const b = j.add("t1", { concern: "limiter", kind: "decision", text: "Retries in the proxy" }).entry;
  j.add("t1", { concern: "tests", kind: "done", text: "Not kept" });
  j.promote("PLEN-1", [{ id: a.id }], "jin");
  j.promote("PLEN-1", [{ id: b.id }], "jin");
  db.query("update memory set at = '2026-01-01' where id = ?").run(a.id);
  expect(j.listGlobal("composio").map((e) => e.text)).toEqual(["Retries in the proxy", "Tokens refresh every 15 minutes"]);
  expect(j.listGlobal("jin")).toEqual([]);
  j.editGlobal(b.id, { text: "Retries belong in the proxy layer" });
  expect(db.query("select text, task_text from memory where id = ?").get(b.id)).toEqual({ text: "Retries belong in the proxy layer", task_text: "Retries in the proxy" });
  j.editGlobal(a.id, { forget: true });
  expect(j.listGlobal().map((e) => e.id)).toEqual([b.id]);
  expect(j.search("tokens", { level: "global" })).toEqual([]);
  expect(() => j.editGlobal("nope", { forget: true })).toThrow("no long-term memory");
});
