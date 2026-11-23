import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jinTools } from "../src/chats";
import { openDb } from "../src/db";
import { Journal } from "../src/journal";

// The desk agent's view across jin: inside a task, the user's other chats, and what moved.
const chat = { id: "c1", kind: "jin", title: "Limiter plan", taskId: null, state: "idle", createdAt: "2026-11-17T09:00:00Z", lastEventAt: "2026-11-17T10:00:00Z" };
const taskChat = { ...chat, id: "c2", kind: "task", title: "About PLEN-1", taskId: "PLEN-1", lastEventAt: "2026-11-18T08:00:00Z" };
const events = [
  { seq: 1, kind: "prompt", payload: { text: "plan the limiter" }, at: "2026-11-17T09:00:00Z" },
  { seq: 2, kind: "tool.started", payload: { tool: "jin_list_tasks" }, at: "2026-11-17T09:00:01Z" },
  { seq: 3, kind: "message", payload: { text: "Here is a plan." }, at: "2026-11-17T09:00:05Z" },
  { seq: 4, kind: "message", payload: { text: "Want me to start it?" }, at: "2026-11-17T09:00:06Z" },
  { seq: 5, kind: "prompt", payload: { text: "yes" }, at: "2026-11-17T09:01:00Z" },
];

const tools = () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "jin-desk-")));
  const journal = new Journal(db, (id) => (id === "t1" ? { taskId: "PLEN-1", title: "Claude 1" } : null));
  journal.add("t1", { concern: "rate limiter", kind: "decision", text: "Retry on 429", why: "Retry-After is unreliable" });
  const list = tools0({
    feed: { list: () => [] },
    tasks: { get: () => ({ id: "PLEN-1", title: null, slug: "limiter", repos: ["platform"], state: "ready" }), list: () => [] },
    sessions: { list: (f: { taskId?: string; kind?: string } = {}) => [chat, taskChat].filter((c) => (!f.taskId || c.taskId === f.taskId) && (!f.kind || c.kind === f.kind)), get: (id: string) => [chat, taskChat].find((c) => c.id === id), events: () => events, approvals: () => [] },
    terminals: { list: () => [{ id: "t1", kind: "agent", agent: "claude", taskId: "PLEN-1", title: "Claude 1", status: "waiting", waitingFor: "Claude needs your permission to use Bash" }] },
    prs: { list: () => [{ taskId: "PLEN-1", url: "https://github.com/acme/platform/pull/1", title: "limiter", state: "OPEN", draft: false, review: null, checks: "passing" }] },
    journal: () => journal,
    linksOf: () => [{ kind: "linear", label: "PLEN-1", url: "https://linear.app/acme/issue/PLEN-1", key: "linear:PLEN-1", since: null }],
  });
  return (name: string) => list.find((t) => t.name === name)!;
};
const tools0 = (deps: Record<string, unknown>) => jinTools({ adapters: new Map(), workspaces: [], claude: {}, jobs: {}, ...deps } as unknown as Parameters<typeof jinTools>[0]);

test("inside a task: its journal, what it follows, its PRs, a waiting agent and the chats about it", async () => {
  const r = (await tools()("jin_task_context").run({ taskId: "PLEN-1" })) as any;
  expect(r.task).toMatchObject({ id: "PLEN-1", title: "limiter", open: "/t/PLEN-1" });
  expect(r.journal.concerns[0]).toMatchObject({ concern: "rate limiter", entries: 1, latest: [{ kind: "decision", text: "Retry on 429", why: "Retry-After is unreliable" }] });
  expect(r.follows).toEqual([{ kind: "linear", label: "PLEN-1", url: "https://linear.app/acme/issue/PLEN-1" }]);
  expect(r.pullRequests[0]).toMatchObject({ state: "OPEN", checks: "passing" });
  expect(r.agents[0]).toMatchObject({ status: "waiting", waitingFor: "Claude needs your permission to use Bash" });
  expect(r.chats.map((c: any) => c.chatId)).toEqual(["c2"]);
});

test("other chats: listed by latest activity, read as asks and answers with tool calls counted", async () => {
  const get = tools();
  expect(((await get("jin_list_chats").run({})) as any[]).map((c) => [c.chatId, c.open])).toEqual([["c2", undefined], ["c1", "/?chat=c1"]]);
  const r = (await get("jin_read_chat").run({ chatId: "c1" })) as any;
  expect(r.turns.map((t: any) => [t.by, t.text, t.tools])).toEqual([
    ["user", "plan the limiter", undefined],
    ["agent", "Here is a plan.\n\nWant me to start it?", 1],
    ["user", "yes", undefined],
  ]);
});

test("catch-up: waiting agents say what for; task progress since the last catch-up; asOf for the next", async () => {
  const get = tools();
  const r = (await get("jin_catch_up").run({ since: "2000-01-01T00:00:00Z" })) as any;
  expect(r.agents[0]).toMatchObject({ taskId: "PLEN-1", waitingFor: "Claude needs your permission to use Bash", open: "/t/PLEN-1" });
  expect(r.taskProgress).toEqual([{ machine: "local", taskId: "PLEN-1", open: "/t/PLEN-1", entries: 1, latest: [expect.objectContaining({ concern: "rate limiter", text: "Retry on 429" })] }]);
  expect(typeof r.asOf).toBe("string");
  const later = (await get("jin_catch_up").run({ since: r.asOf })) as any;
  expect(later.taskProgress).toEqual([]);
});
