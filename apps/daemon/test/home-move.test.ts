import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { Docs } from "../src/docs";
import { exportHome, gaveUpHome, importHome, setNotHome } from "../src/home-move";

const t = "2026-11-25T00:00:00Z";
const machine = () => {
  const home = mkdtempSync(join(tmpdir(), "jin-home-"));
  return { home, db: openDb(home), claude: mkdtempSync(join(tmpdir(), "jin-claude-")) };
};

test("the home moves whole: chats, the desk, docs, memory and the files behind them; task sessions stay", () => {
  const a = machine();
  for (const [id, title] of [["c1", "catch up"], ["c2", "plan"], ["c3", "triage"], ["c4", "rfc"], ["c5", "notes"]] as const)
    a.db.query("insert into sessions (id, kind, title, harness, cwd, state, created_at) values (?, 'jin', ?, 'claude', '/x', 'idle', ?)").run(id, title, t);
  a.db.query("insert into sessions (id, kind, task_id, harness, state, created_at) values ('t1', 'task', 'PLEN-1', 'claude', 'idle', ?)").run(t);
  a.db.query("insert into events (session_id, kind, payload, at) values ('c1', 'message', '{}', ?)").run(t);
  a.db.query("insert into feed_items (id, workspace, source, kind, external_ref, title, received_at) values ('f1', 'composio', 'slack', 'mention', 'x', 'Ask', ?)").run(t);
  const docs = new Docs(a.db);
  const d = docs.create({ title: "Rate limits", body: "Draft." }, "you");
  docs.comment(d.id, { text: "why?" }, "you");
  a.db.query("insert into memory (id, task_id, concern, kind, text, at, level, workspace) values ('m1', 'PLEN-1', 'limits', 'decision', 'keep 429s rare', ?, 'workspace', 'composio')").run(t);
  writeFileSync(join(a.home, "composio.json"), JSON.stringify({ userId: "u1", events: { slack_dms: true } }));
  mkdirSync(join(a.home, "composio", ".composio"), { recursive: true });
  writeFileSync(join(a.home, "composio", ".composio", "project.json"), '{"project_id":"p1"}');
  writeFileSync(join(a.home, "composio-cursor.json"), '{"from":5,"ids":[]}');
  mkdirSync(join(a.home, "chats", "jin"), { recursive: true });
  writeFileSync(join(a.home, "chats", "jin", "plan.md"), "# plan");
  writeFileSync(join(a.home, "token"), "secret"); // not the home's: never moves

  const bundle = exportHome(a.db, a.home, { claudeDir: a.claude });
  expect(Object.keys(bundle.files).sort()).toEqual(["chats/jin/plan.md", "composio-cursor.json", "composio.json", "composio/.composio/project.json"]);

  const b = machine();
  setNotHome(b.home, true); // it gave the home up once before: taking it back clears that
  // It read the same item itself, under another id: the moved one wins.
  b.db.query("insert into feed_items (id, workspace, source, kind, external_ref, title, received_at) values ('mine', 'composio', 'slack', 'mention', 'x', 'Ask (mine)', ?)").run(t);
  const moved = importHome(b.db, b.home, JSON.parse(JSON.stringify(bundle)), { claudeDir: b.claude });
  expect(moved).toMatchObject({ sessions: 5, feed: 1, docs: 1, memory: 1, files: 4 });
  expect(b.db.query("select count(*) n from sessions where kind = 'task'").get()).toEqual({ n: 0 });
  expect(b.db.query("select id, title from feed_items").all()).toEqual([{ id: "f1", title: "Ask" }]);
  expect(new Docs(b.db).full(d.id).threads.length).toBe(1);
  expect(readFileSync(join(b.home, "composio.json"), "utf8")).toContain("slack_dms");
  expect(readFileSync(join(b.home, "chats", "jin", "plan.md"), "utf8")).toBe("# plan");
  expect(existsSync(join(b.home, "token"))).toBe(false);
  expect(gaveUpHome(b.home)).toBe(false);
});

test("moving back: the moved copy wins, so nothing comes back stale", () => {
  const a = machine();
  const docs = new Docs(a.db);
  const d = docs.create({ title: "Plan", body: "v1" }, "you");
  a.db.query("insert into sessions (id, kind, title, harness, cwd, state, created_at) values ('c1', 'jin', 'chat', 'claude', '/x', 'idle', ?)").run(t);
  a.db.query("insert into events (session_id, kind, payload, at) values ('c1', 'message', '{\"n\":1}', ?)").run(t);
  const b = machine();
  importHome(b.db, b.home, exportHome(a.db, a.home), { claudeDir: b.claude });
  // On the new home the doc and the chat go on.
  new Docs(b.db).save(d.id, { body: "v2" }, 1, "you");
  b.db.query("insert into events (session_id, kind, payload, at) values ('c1', 'message', '{\"n\":2}', ?)").run(t);
  b.db.query("update sessions set title = 'chat, renamed' where id = 'c1'").run();
  // Back to the first machine, which still has the old copies.
  importHome(a.db, a.home, exportHome(b.db, b.home), { claudeDir: a.claude });
  expect(new Docs(a.db).get(d.id)).toMatchObject({ body: "v2", version: 2 });
  expect(new Docs(a.db).versions(d.id).length).toBe(2); // the doc was updated, not replaced: its versions stay
  expect(a.db.query("select title from sessions where id = 'c1'").get()).toEqual({ title: "chat, renamed" });
  expect((a.db.query("select payload from events where session_id = 'c1' order by seq").all() as { payload: string }[]).map((e) => e.payload)).toEqual(['{"n":1}', '{"n":2}']);
});

test("a machine that gave the home up remembers it", () => {
  const a = machine();
  expect(gaveUpHome(a.home)).toBe(false);
  setNotHome(a.home, true);
  expect(gaveUpHome(a.home)).toBe(true);
  setNotHome(a.home, false);
  expect(gaveUpHome(a.home)).toBe(false);
  expect(() => importHome(a.db, a.home, {} as never)).toThrow("not a jin home bundle");
});
