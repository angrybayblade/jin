import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { exportHistory, importHistory } from "../src/history";

const db = () => openDb(mkdtempSync(join(tmpdir(), "jin-history-")));

test("chats, their events and approvals, and the feed move; task sessions stay", () => {
  const a = db();
  const t = "2026-11-16T00:00:00Z";
  a.query("insert into sessions (id, kind, title, harness, harness_session_id, cwd, state, created_at) values ('c1', 'jin', 'catch up', 'claude', 'h1', '/Users/me', 'running', ?)").run(t);
  a.query("insert into sessions (id, kind, task_id, harness, state, created_at) values ('t1', 'task', 'PLEN-1', 'claude', 'idle', ?)").run(t);
  a.query("insert into events (session_id, kind, payload, at) values ('c1', 'message', '{\"text\":\"hi\"}', ?)").run(t);
  a.query("insert into approvals (id, session_id, action, reason, state, created_at) values ('a1', 'c1', '{}', 'push', 'pending', ?)").run(t);
  a.query("insert into feed_items (id, workspace, source, kind, external_ref, title, received_at) values ('f1', 'composio', 'github', 'review', 'x#1', 'Review', ?)").run(t);
  const h = exportHistory(a);
  expect(h.sessions.map((s) => s.id)).toEqual(["c1"]);

  const b = db();
  expect(importHistory(b, h)).toEqual({ sessions: 1, events: 1, approvals: 1, feed: 1 });
  expect(b.query("select state, harness_session_id, cwd from sessions where id = 'c1'").get()).toEqual({ state: "idle", harness_session_id: null, cwd: null });
  expect(b.query("select state from approvals where id = 'a1'").get()).toEqual({ state: "expired" });
  // Moving again changes nothing.
  expect(importHistory(b, h)).toEqual({ sessions: 0, events: 0, approvals: 0, feed: 0 });
});
