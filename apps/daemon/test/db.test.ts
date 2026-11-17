import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";

test("migration 2 keeps existing task sessions and adds chat columns", () => {
  const home = mkdtempSync(join(tmpdir(), "jin-db-"));
  // A v1 database with one task and one session.
  const v1 = new Database(join(home, "jin.db"), { create: true });
  v1.exec(`create table tasks (id text primary key, workspace text not null, type text, slug text not null, repos text not null, dirs text not null, state text not null, source_item text, created_at text not null);
    create table sessions (id text primary key, task_id text not null, harness text not null, harness_session_id text, state text not null, created_at text not null);
    create table feed_items (id text primary key);
    insert into tasks values ('T-1', 'composio', null, 'fix it', '["platform"]', '{"root":"/ws/tasks/T-1","repos":{}}', 'ready', null, 'now');
    insert into sessions values ('s1', 'T-1', 'claude', 'h1', 'idle', 'now');
    pragma user_version = 1;`);
  v1.close();
  const db = openDb(home);
  expect(db.query("select id, kind, task_id, workspace, title, cwd, harness_session_id from sessions").get()).toEqual({
    id: "s1", kind: "task", task_id: "T-1", workspace: "composio", title: "fix it", cwd: "/ws/tasks/T-1", harness_session_id: "h1",
  });
  expect((db.query("pragma user_version").get() as any).user_version).toBeGreaterThanOrEqual(2);
  db.exec("insert into sessions (id, kind, harness, state, created_at) values ('c1', 'slack', 'claude', 'idle', 'now')");
});
