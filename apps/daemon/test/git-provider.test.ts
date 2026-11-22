import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkspaceAt } from "../src/adapters";
import { GitAdapter, gitProvider } from "../src/adapters/git";

const base = realpathSync(mkdtempSync(join(tmpdir(), "jin-git-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const run = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

/** A workspace folder with one clone (api) of a local "origin" that has a pull request ref. */
function fixture(name = "ws") {
  const origin = join(base, `${name}-origin-api.git`);
  run(base, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(base, `${name}-seed`);
  run(base, "clone", "-q", origin, seed);
  writeFileSync(join(seed, "a.txt"), "one\n");
  run(seed, "add", ".");
  run(seed, "commit", "-qm", "one");
  run(seed, "push", "-q", "origin", "HEAD:main");
  writeFileSync(join(seed, "a.txt"), "two\n");
  run(seed, "commit", "-qam", "two");
  run(seed, "push", "-q", "origin", "HEAD:refs/pull/7/head");
  const pr = run(seed, "rev-parse", "HEAD");
  const root = join(base, name);
  mkdirSync(root);
  run(root, "clone", "-q", origin, "api");
  mkdirSync(join(root, "notes")); // not a repo
  return { root, pr, adapter: new GitAdapter({ id: "repos", adapter: "git", root, github: { owners: [] }, profile: {} }) };
}

test("a folder of git clones: its repos, a change as a branch worktree per repo, a review at the PR's head, then removed", async () => {
  const { root, pr, adapter } = fixture();
  expect(isWorkspaceAt(gitProvider, root)).toBe(true);
  expect(isWorkspaceAt(gitProvider, join(root, "notes"))).toBe(false);
  expect((await adapter.repos()).map((r) => [r.name, r.branch])).toEqual([["api", "main"]]);

  const lines: string[] = [];
  const t = await adapter.startTask({ id: "ENG-1", kind: "change", type: "fix", repos: ["api"], slug: "Retry webhooks" }, { onOutput: (l) => lines.push(l) });
  expect(t.dirs.api).toBe(join(root, ".jin-tasks", "ENG-1", "api"));
  expect(run(t.dirs.api!, "branch", "--show-current")).toBe("fix/ENG-1-retry-webhooks");
  expect(lines.at(-1)).toContain("ready");
  expect(adapter.listTasks()).toMatchObject([{ id: "ENG-1", kind: "change", type: "fix", slug: "Retry webhooks", repos: ["api"], issue: null }]);

  const id = await adapter.nextTaskId("review");
  expect(id).toMatch(/^REV-\d{4}01$/);
  const r = await adapter.startTask({ id, kind: "review", prs: ["api#7"], repos: ["api"], slug: "" });
  expect(run(r.dirs.api!, "rev-parse", "HEAD")).toBe(pr);
  expect(JSON.parse(readFileSync(join(r.root, "task.json"), "utf8")).prs).toEqual([{ repo: "api", number: 7, head: pr }]);
  expect(await adapter.nextTaskId("review")).not.toBe(id);

  // The brief says what the workspace is, nothing about any particular one.
  expect(adapter.agentBrief({ id: "ENG-1", kind: "change", root: t.root, repos: ["api"] }).start).toContain("on the task's own branch");

  await adapter.removeTask("ENG-1");
  expect(existsSync(t.root)).toBe(false);
  expect(adapter.listTasks().map((x) => x.id)).toEqual([id]);
  await expect(adapter.startTask({ id: "ENG-2", kind: "change", repos: ["nope"], slug: "x" })).rejects.toThrow("not a repo of this workspace");
  expect(existsSync(join(root, ".jin-tasks", "ENG-2"))).toBe(false);
});

test("a scratch task: numbered EXP-, on a scratch/ branch, and discarded whole", async () => {
  const { root, adapter } = fixture("scratch");
  const id = await adapter.nextTaskId("scratch");
  expect(id).toMatch(/^EXP-\d{4}01$/);
  const t = await adapter.startTask({ id, kind: "scratch", repos: ["api"], slug: "" });
  expect(run(t.dirs.api!, "branch", "--show-current")).toBe(`scratch/${id}`);
  expect(adapter.listTasks()).toMatchObject([{ id, kind: "scratch", type: "scratch", issue: null }]);
  expect(adapter.agentBrief({ id, kind: "scratch", root: t.root, repos: ["api"] }).rules?.[0]).toContain("scratch task");

  // Work that would block a normal removal goes with it.
  writeFileSync(join(t.dirs.api!, "b.txt"), "b\n");
  run(t.dirs.api!, "add", ".");
  run(t.dirs.api!, "commit", "-qm", "try");
  writeFileSync(join(t.dirs.api!, "wip.txt"), "wip\n");
  await adapter.removeTask(id, { discard: true });
  expect(existsSync(t.root)).toBe(false);
  expect(run(join(root, "api"), "branch", "--list", `scratch/${id}`)).toBe("");

  const c = await adapter.startTask({ id: "ENG-9", kind: "change", type: "fix", repos: ["api"], slug: "keep" });
  await expect(adapter.removeTask("ENG-9", { discard: true })).rejects.toThrow("only scratch tasks are discarded");
  expect(existsSync(c.root)).toBe(true);
});

test("one clone is a workspace of that repo: tasks live next to it, never inside", async () => {
  const { root: folder, pr } = fixture("solo");
  const root = join(folder, "api");
  expect(isWorkspaceAt(gitProvider, root)).toBe(true);
  expect(gitProvider.idFor?.(root)).toBe("api");
  expect(gitProvider.idFor?.(folder)).toBeNull();
  const adapter = new GitAdapter({ id: "api", adapter: "git", root, github: { owners: [] }, profile: {} });
  expect(await adapter.repos()).toMatchObject([{ name: "api", path: root, branch: "main" }]);

  const change = await adapter.startTask({ id: "T-1", kind: "change", repos: ["api"], slug: "Fix it" });
  expect(change.root).toBe(join(folder, ".jin-tasks", "api", "T-1"));
  expect(run(change.dirs.api!, "branch", "--show-current")).toBe("change/T-1-fix-it");
  expect(run(root, "status", "--porcelain")).toBe(""); // nothing appeared in the clone
  await expect(adapter.startTask({ id: "T-2", kind: "change", repos: ["notes"], slug: "" })).rejects.toThrow("not a repo of this workspace");

  const review = await adapter.startTask({ id: await adapter.nextTaskId("review"), kind: "review", repos: [], slug: "", prs: ["api#7"] });
  expect(run(review.dirs.api!, "rev-parse", "HEAD")).toBe(pr);
  expect(adapter.listTasks().map((t) => t.id).sort()).toEqual(["T-1", review.root.split("/").pop()!].sort());
  expect(adapter.agentBrief({ id: "T-1", kind: "change", root: change.root, repos: ["api"] } as never).readable).toContain(`The clone at ${root}`);

  await adapter.removeTask("T-1");
  expect(existsSync(change.root)).toBe(false);
  expect(run(root, "worktree", "list").split("\n").length).toBe(2); // the clone and the review
});

test("a repo to clone, as typed: GitHub in any spelling goes to gh, other URLs to git, nothing else passes", async () => {
  const { parseRepo } = await import("../src/adapters/git");
  for (const t of ["acme/web", "https://github.com/acme/web", "https://github.com/acme/web.git/", "git@github.com:acme/web.git", " acme/web "]) {
    expect(parseRepo(t)).toEqual({ source: "acme/web", root: "repos/web", id: "web" });
  }
  expect(parseRepo("https://gitlab.com/acme/tools/My.Api.git")).toEqual({ source: "https://gitlab.com/acme/tools/My.Api.git", root: "repos/My.Api", id: "my-api" });
  expect(parseRepo("git@example.com:team/web.git")).toMatchObject({ source: "git@example.com:team/web.git", id: "web" });
  for (const bad of ["", "web", "-oProxyCommand=x/y", "acme/web; rm -rf ~", "acme/$(id)", "acme/`id`", "a b/c", "acme/web'", "https://x.com/..", "../../etc"]) expect(parseRepo(bad)).toBeNull();
});

test("the installer clones a repo into its folder, and reuses a clone already there", () => {
  const { root: folder } = fixture("inst");
  const origin = join(base, "inst-origin-api.git");
  const src = `file://${origin}`;
  const install = (root: string) => spawnSync("sh", ["-c", `set -e\n${gitProvider.install!.script}`], { env: { ...process.env, ROOT: root, SOURCE: src }, encoding: "utf8" });
  const root = join(folder, "cloned", "api");
  const first = install(root);
  expect(first.status).toBe(0);
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
  expect(install(root).stdout).toContain("using the clone already at");
  const notClone = join(folder, "notes");
  expect(install(notClone).status).toBe(1);
});
