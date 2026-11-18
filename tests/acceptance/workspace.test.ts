import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readLog, setupEnv, startDaemon, until, type Daemon, type Env } from "./helpers";

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

test("A05 loads the workspace profile from JIN_HOME (an old `adapter: composio` is cws)", async () => {
  const workspaces = await d.json("/api/workspaces");
  expect(workspaces).toEqual([expect.objectContaining({ id: "composio", adapter: "cws", root: env.workspace })]);
});

test("A06 lists the workspace's repos", async () => {
  const repos = await d.json("/api/workspaces/composio/repos");
  expect(repos).toEqual([
    expect.objectContaining({ name: "platform", branch: "master", description: "Apollo, Thermos and shared packages", path: join(env.workspace, "repos/platform") }),
    expect.objectContaining({ name: "mercury", branch: "master", description: "Tool execution runtime", path: join(env.workspace, "repos/mercury") }),
  ]);
});

test("A07 starting a task runs `cws task new ... --setup` and records it", async () => {
  const task = await d.json("/api/workspaces/composio/tasks", {
    method: "POST",
    json: { id: "PLEN-1", type: "bug", repos: ["platform", "mercury"], slug: "webhook retries" },
  });
  expect(task).toEqual(
    expect.objectContaining({
      id: "PLEN-1",
      workspace: "composio",
      state: "ready",
      dirs: { platform: join(env.workspace, "tasks/PLEN-1/platform"), mercury: join(env.workspace, "tasks/PLEN-1/mercury") },
    }),
  );
  const call = readLog(join(env.workspace, "cws.log")).find((l) => l.startsWith("task new"));
  expect(call).toBe("task new PLEN-1 --type bug --repos platform,mercury --slug webhook retries --setup");
  expect(existsSync(join(env.workspace, "tasks/PLEN-1/platform"))).toBe(true);
  const tasks = await d.json("/api/tasks");
  expect(tasks.map((t: any) => t.id)).toContain("PLEN-1");
});

test("A08 removing a task runs `cws task rm` (in the background) and updates the record", async () => {
  await d.json("/api/workspaces/composio/tasks", { method: "POST", json: { id: "PLEN-2", repos: ["platform"], slug: "x" } });
  const res = await d.api("/api/tasks/PLEN-2", { method: "DELETE" });
  expect(res.status).toBe(202);
  await until(async () => (await d.json<any[]>("/api/tasks")).find((t) => t.id === "PLEN-2")?.state === "removed", 10_000, "task removed");
  expect(readLog(join(env.workspace, "cws.log"))).toContain("task rm PLEN-2");
  expect(existsSync(join(env.workspace, "tasks/PLEN-2"))).toBe(false);
  const task = (await d.json("/api/tasks")).find((t: any) => t.id === "PLEN-2");
  expect(task.state).toBe("removed");
});
