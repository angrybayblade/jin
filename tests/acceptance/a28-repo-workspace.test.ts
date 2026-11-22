// A28: one repo is a workspace. Setup clones a repo jin is given (here from a local origin),
// uses the clone as a workspace named after it, next to the workspace already there, and its
// tasks are worktrees kept beside the clone, never inside it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, startDaemon, until, type Daemon, type Env } from "./helpers";

let env: Env;
let d: Daemon;
let userHome: string;
let origin: string;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

beforeAll(async () => {
  env = setupEnv();
  const base = realpathSync(join(env.home, ".."));
  origin = join(base, "site.git");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(base, "seed");
  git(base, "clone", "-q", origin, seed);
  writeFileSync(join(seed, "index.ts"), "export {};\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  // The user's home folder, where a cloned repo goes (~/repos/<name>).
  userHome = join(base, "user-home");
  mkdirSync(userHome);
  d = await startDaemon(env, { HOME: userHome });
});
afterAll(async () => {
  await d.stop();
  env.cleanup();
});

test("A28 a repo as a workspace: cloned by setup, named after it, tasks beside the clone", async () => {
  const setup = await d.json<any>("/api/setup");
  expect(setup.providers.find((p: { id: string }) => p.id === "git")).toMatchObject({ installsTo: "~/repos", source: { hint: "owner/repo or a git URL" } });

  // What is not a repo is refused before anything runs.
  const bad = await d.api("/api/setup/install", { method: "POST", json: { provider: "git", source: "site; rm -rf ~" } });
  expect(bad.status).toBe(400);

  await d.json("/api/setup/install", { method: "POST", json: { provider: "git", source: `file://${origin}` } });
  await until(async () => ((await d.json<any>("/api/setup")).install?.state === "done" ? true : null), 20_000, "repo cloned");
  const root = join(userHome, "repos", "site");
  const all = await d.json<any[]>("/api/workspaces");
  // Next to the workspace jin already had.
  expect(all.map((w) => w.id).sort()).toEqual(["composio", "site"]);
  expect(all.find((w) => w.id === "site")).toMatchObject({ adapter: "git", root });
  expect(await d.json<any[]>("/api/workspaces/site/repos")).toMatchObject([{ name: "site", path: root, branch: "main" }]);

  // A scratch task: a worktree beside the clone.
  const job = await d.json<any>("/api/task-jobs", { method: "POST", json: { workspace: "site", kind: "scratch", repos: ["site"], slug: "Try it" } });
  await until(async () => ((await d.json<any>(`/api/task-jobs/${job.id}`)).state === "done" ? true : null), 15_000, "task created");
  const [task] = (await d.json<any[]>("/api/tasks")).filter((t) => t.workspace === "site");
  expect(task.kind).toBe("scratch");
  expect(task.root.startsWith(join(userHome, "repos", ".jin-tasks", "site"))).toBe(true);
  expect(existsSync(join(task.dirs.site, "index.ts"))).toBe(true);
  expect(git(root, "status", "--porcelain")).toBe("");

  // The same repo again is refused: jin already uses it.
  const again = await d.api("/api/setup/install", { method: "POST", json: { provider: "git", source: `file://${origin}` } });
  expect(again.status).toBe(409);
});
