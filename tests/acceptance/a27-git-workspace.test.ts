// A27: jin is not tied to one workspace. With only a plain folder of git clones (the git
// provider) and no cws anywhere, it sets the workspace up, creates a task as git worktrees,
// starts Claude Code there with that workspace's brief, and removes the task.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, startDaemon, until, type Daemon, type Env } from "./helpers";

let env: Env;
let d: Daemon;
let ws: string;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

beforeAll(async () => {
  env = setupEnv();
  // No composio workspace and no cws: only a folder with one clone.
  rmSync(join(env.home, "workspaces", "composio.yaml"));
  rmSync(join(env.workspace, "bin", "cws"));
  const base = realpathSync(join(env.home, ".."));
  const origin = join(base, "web.git");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(base, "seed");
  git(base, "clone", "-q", origin, seed);
  writeFileSync(join(seed, "index.ts"), "export {};\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  ws = join(base, "code");
  mkdirSync(ws);
  git(ws, "clone", "-q", origin, "web");
  writeFileSync(join(env.bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${env.home}/claude-args.txt"\nexec sleep 600\n`);
  chmodSync(join(env.bin, "claude"), 0o755);
  d = await startDaemon(env);
});
afterAll(async () => {
  await d.stop();
  env.cleanup();
});

test("A27 a plain git workspace: set up by path, a task as worktrees, Claude Code with its brief, removed", async () => {
  // Setup knows the kinds of workspace, and takes this folder as a git one.
  const setup = await d.json<any>("/api/setup");
  expect(setup.providers.map((p: { id: string }) => p.id)).toEqual(["cws", "git"]);
  await d.json("/api/setup/workspace", { method: "POST", json: { path: ws } });
  const [w] = await d.json<any[]>("/api/workspaces");
  expect(w).toMatchObject({ id: "repos", adapter: "git", root: ws });
  expect(w.taskKinds.map((k: { id: string }) => k.id)).toEqual(["change", "review"]);
  expect(await d.json<any[]>("/api/workspaces/repos/repos")).toMatchObject([{ name: "web", branch: "main" }]);

  // A change: a worktree on its own branch, set up in the background.
  const job = await d.json<any>("/api/task-jobs", { method: "POST", json: { workspace: "repos", id: "ENG-9", repos: ["web"], slug: "Dark mode" } });
  await until(async () => ((await d.json<any>(`/api/task-jobs/${job.id}`)).state === "done" ? true : null), 15_000, "task created");
  const task = await d.json<any>("/api/tasks/ENG-9");
  expect(task).toMatchObject({ kind: "change", slug: "Dark mode", repos: ["web"], issue: null });
  expect(git(task.dirs.web, "branch", "--show-current")).toBe("change/ENG-9-dark-mode");

  // Its Claude Code gets the git workspace's brief, and nothing of cws.
  await d.json("/api/terminals", { method: "POST", json: { taskId: "ENG-9", kind: "claude" } });
  await until(() => existsSync(join(env.home, "claude-args.txt")), 10_000, "claude launched");
  const args = readFileSync(join(env.home, "claude-args.txt"), "utf8");
  expect(args).toContain("a git worktree per repo (web), on the task's own branch.");
  expect(args).not.toMatch(/cws|TASK\.md|docs\/map/);

  // No task has a Linear issue just because its id looks like one.
  expect((await d.json<any[]>("/api/tasks/ENG-9/links")).map((l: { key: string }) => l.key)).toEqual([]);

  await d.json("/api/tasks/ENG-9", { method: "DELETE" });
  expect(existsSync(task.root)).toBe(false);
});
