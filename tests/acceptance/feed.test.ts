import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { EXPECTED_FEED, readLog, setupEnv, startDaemon, until, type Daemon, type Env } from "./helpers";

let env: Env;
let d: Daemon;
beforeAll(async () => {
  env = setupEnv();
  d = await startDaemon(env);
});
afterAll(async () => {
  await d?.stop();
  env?.cleanup();
});

const byTitle = (items: any[], title: string) => items.find((i) => i.title === title);

test("A09 GitHub collector turns review requests, red CI and mentions into feed items", async () => {
  const res = await d.json("/api/collect/github", { method: "POST" });
  expect(res.added).toBe(3);
  expect(readLog(join(env.workspace, "..", "gh.log")).some((l) => l.startsWith("api graphql"))).toBe(true);
  const items = await d.json("/api/feed");
  for (const t of EXPECTED_FEED.present) expect(byTitle(items, t)).toBeDefined();
  for (const t of EXPECTED_FEED.absent) expect(byTitle(items, t)).toBeUndefined();
  expect(byTitle(items, "Rate-limit tool router sessions")).toEqual(
    expect.objectContaining({ source: "github", kind: "review_requested", workspace: "composio", state: "new", externalRef: "https://github.com/ComposioHQ/platform/pull/14310" }),
  );
  expect(byTitle(items, "Fix thermos webhook retries").kind).toBe("ci_failed");
  expect(byTitle(items, "Dashboard shows stale connection state").kind).toBe("mention");
});

test("A10 collecting again does not duplicate items", async () => {
  const before = (await d.json("/api/feed")).length;
  const res = await d.json("/api/collect/github", { method: "POST" });
  expect(res.added).toBe(0);
  expect((await d.json("/api/feed")).length).toBe(before);
});

test("A11 feed items can be snoozed, dismissed and promoted to a task", async () => {
  const items = await d.json("/api/feed");
  const [a, b, c] = EXPECTED_FEED.present.map((t) => byTitle(items, t));

  await d.json(`/api/feed/${a.id}/snooze`, { method: "POST", json: { until: "2099-01-01T00:00:00Z" } });
  await d.json(`/api/feed/${b.id}/dismiss`, { method: "POST" });
  const promoted = await d.json(`/api/feed/${c.id}/promote`, {
    method: "POST",
    json: { taskId: "PLEN-9", type: "bug", repos: ["platform"], slug: "stale connection state" },
  });
  expect(promoted).toEqual(expect.objectContaining({ id: "PLEN-9", state: "ready" }));

  const after = await d.json("/api/feed");
  expect(byTitle(after, a.title).state).toBe("snoozed");
  expect(byTitle(after, b.title).state).toBe("dismissed");
  expect(byTitle(after, c.title)).toEqual(expect.objectContaining({ state: "promoted", taskId: "PLEN-9" }));
  expect(readLog(join(env.workspace, "cws.log")).some((l) => l.startsWith("task new PLEN-9"))).toBe(true);
});

test("A11b jin's chat closes a finished task and clears several feed items at once", async () => {
  const items = (await d.json("/api/feed")) as { id: string; state: string }[];
  const open = items.filter((i) => i.state === "snoozed" || i.state === "dismissed").map((i) => i.id);
  expect(open.length).toBeGreaterThan(1);
  const chat = await d.json("/api/chats", {
    method: "POST",
    json: { kind: "jin", prompt: JSON.stringify({ script: [{ jinTool: "jin_archive_task", input: { taskIds: ["PLEN-9", "NOPE-1"] } }, { jinTool: "jin_update_feed", input: { itemIds: open, action: "done" } }, { text: "done" }] }) },
  });
  await until(async () => (await d.json(`/api/sessions/${chat.id}`)).state === "idle", 20_000, "chat turn");
  const out = async (tool: string) => ((await d.json(`/api/sessions/${chat.id}/events`)) as { kind: string; payload: { tool?: string; output?: unknown } }[]).find((e) => e.kind === "tool.result" && e.payload.tool === `mcp__jin__${tool}`)?.payload.output;
  const archived = (await out("jin_archive_task")) as { id: string; archived?: boolean; error?: string }[];
  expect(archived[0]).toEqual({ id: "PLEN-9", archived: true });
  expect(archived[1]!.error).toBeDefined(); // an unknown task is reported, not fatal
  expect((await d.json("/api/tasks/PLEN-9")).archived).toBe(true);
  const after = (await d.json("/api/feed")) as { id: string; state: string }[];
  expect(after.filter((i) => open.includes(i.id)).every((i) => i.state === "done")).toBe(true);
}, 30_000);
