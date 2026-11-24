import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, openDb } from "../src/db";
import { Journal } from "../src/journal";

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
