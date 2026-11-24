import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workOutsidePRs } from "../src/tasks";

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

/** A remote with one commit on main, and a clone of it as a task's worktree. */
const repo = (root: string, name: string) => {
  const origin = join(root, `${name}.git`);
  const seed = join(root, `${name}-seed`);
  git(root, "init", "--bare", origin);
  git(root, "clone", origin, seed);
  writeFileSync(join(seed, "a.txt"), "a");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "first");
  git(seed, "push", "origin", "main");
  const dir = join(root, name);
  git(root, "clone", origin, dir);
  return dir;
};

test("a task's repos without a PR: their uncommitted changes and commits not on the default branch hold it open", () => {
  const root = mkdtempSync(join(tmpdir(), "jin-unfinished-"));
  const clean = repo(root, "clean");
  const busy = repo(root, "keyring");
  const done = repo(root, "platform");
  // keyring: a commit not on main (pushed to a branch or not, it is in no PR), and an edit.
  git(busy, "checkout", "-b", "feature");
  writeFileSync(join(busy, "b.txt"), "b");
  git(busy, "add", ".");
  git(busy, "commit", "-m", "work");
  writeFileSync(join(busy, "a.txt"), "changed");
  // platform has a PR (merged): whatever it holds is not asked about.
  writeFileSync(join(done, "a.txt"), "changed too");

  expect(workOutsidePRs({ clean, keyring: busy, platform: done }, ["Platform"])).toEqual([
    { repo: "keyring", problem: "1 uncommitted change" },
    { repo: "keyring", problem: "1 commit not on main" },
  ]);
  expect(workOutsidePRs({ clean }, [])).toEqual([]);
  expect(workOutsidePRs({ keyring: busy }, ["keyring"])).toEqual([]);
});
