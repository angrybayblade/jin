// A24: hooks. A task's PR merges (the fake gh starts reporting it merged): the default hook
// starts a jin chat with its clean-up instructions and the event, and notifies; a hook you
// add on "a PR merged" runs too; each runs once. Removing a task refuses while work would be
// lost, and jin's chat asks before removing.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, startDaemon, until, type Daemon, type TestEnv } from "./helpers";

let env: TestEnv;
let d: Daemon;

beforeAll(async () => {
  env = setupEnv();
  d = await startDaemon(env);
  await d.json("/api/workspaces/composio/tasks", { method: "POST", json: { id: "HK-1", repos: ["platform"], slug: "hooked" } });
  await d.json("/api/tasks/HK-1/prs", { method: "POST", json: { url: "https://github.com/ComposioHQ/platform/pull/777" } });
});
afterAll(async () => {
  await d.stop();
  env.cleanup();
});

const notices = () => (existsSync(join(env.home, "notifications.log")) ? readFileSync(join(env.home, "notifications.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("A24 a merged PR fires the merge clean-up hook and your own hook, once each", async () => {
  const status = await d.json("/api/event-hooks");
  expect(status.hooks.map((h: { name: string }) => h.name)).toEqual(["Clean up after a merge"]);
  expect(status.events.map((e: { id: string }) => e.id)).toEqual(["pr.merged", "task.merged", "live.event"]);
  await d.json("/api/event-hooks", { method: "POST", json: { name: "Tell me", event: "pr.merged", filter: { "pr.repo": "ComposioHQ/platform" }, instructions: "Say which PR merged." } });
  expect((await d.json("/api/tasks/HK-1/prs"))[0].state).toBe("OPEN");

  appendFileSync(join(env.home, "..", "gh-merged"), "777\n");
  await d.json("/api/tasks/HK-1/prs/refresh", { method: "POST" });
  const runs = await until(async () => {
    const r = (await d.json("/api/event-hooks")).runs as { hookName: string; key: string; chatId: string | null }[];
    return r.length >= 2 ? r : null;
  }, 10_000, "hooks ran");
  expect(runs.map((r) => [r.hookName, r.key]).sort()).toEqual([
    ["Clean up after a merge", "HK-1"],
    ["Tell me", "https://github.com/ComposioHQ/platform/pull/777"],
  ]);
  const cleanup = runs.find((r) => r.hookName === "Clean up after a merge")!;
  const session = await d.json(`/api/sessions/${cleanup.chatId}`);
  expect(session).toMatchObject({ kind: "jin", title: "Clean up after a merge: HK-1" });
  const prompt = ((await d.json(`/api/sessions/${cleanup.chatId}/events`)) as { kind: string; payload: { text?: string } }[]).find((e) => e.kind === "prompt")!.payload.text!;
  expect(prompt).toContain("jin_remove_task");
  expect(prompt).toContain("https://github.com/ComposioHQ/platform/pull/777");
  await until(() => notices().some((n) => n.title === "Clean up after a merge"), 5_000, "notified");
  expect(notices().find((n) => n.title === "Clean up after a merge")).toMatchObject({ subtitle: "HK-1", chat: cleanup.chatId });

  // Refreshing again changes nothing.
  await d.json("/api/tasks/HK-1/prs/refresh", { method: "POST" });
  expect((await d.json("/api/event-hooks")).runs).toHaveLength(2);
}, 30_000);

test("A24 removing a task refuses while work would be lost; jin's chat asks before removing", async () => {
  // The fake workspace's folders are not git repositories: jin cannot tell, so it refuses.
  expect((await d.json("/api/tasks/HK-1/unsaved")).length).toBeGreaterThan(0);
  const refused = await d.api("/api/tasks/HK-1/remove-if-clean", { method: "POST" });
  expect(refused.status).toBe(409);
  const chat = await d.json("/api/chats", { method: "POST", json: { kind: "jin", prompt: JSON.stringify({ script: [{ jinTool: "jin_remove_task", input: { taskId: "HK-1" } }, { text: "done" }] }) } });
  await until(async () => (await d.json(`/api/sessions/${chat.id}`)).state === "waiting_approval", 10_000, "asks first");
  const approval = ((await d.json("/api/approvals?state=pending")) as { sessionId: string; action: { tool: string } }[]).find((a) => a.sessionId === chat.id);
  expect(approval?.action.tool).toBe("mcp__jin__jin_remove_task");
}, 30_000);
