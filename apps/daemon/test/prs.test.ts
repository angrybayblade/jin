import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskRules } from "../src/claude-cli";
import { openDb } from "../src/db";
import { createdPrs, prUrls, rollup, TaskPRs } from "../src/prs";

test("a PR created by `gh pr create` or a GitHub tool is noticed; other commands are not", () => {
  const out = "Creating pull request for fix/x into main\n\nhttps://github.com/ComposioHQ/platform/pull/15030\n";
  expect(createdPrs("Bash", { command: "gh pr create --fill --draft" }, { stdout: out })).toEqual(["https://github.com/ComposioHQ/platform/pull/15030"]);
  expect(createdPrs("Bash", { command: "gh pr view 15030" }, { stdout: out })).toEqual([]);
  expect(createdPrs("mcp__github__create_pull_request", {}, { html_url: "https://github.com/a/b/pull/7" })).toEqual(["https://github.com/a/b/pull/7"]);
  expect(prUrls("see https://github.com/a/b/pull/1 and https://github.com/a/b/pull/1#x")).toEqual(["https://github.com/a/b/pull/1"]);
});

test("checks roll up to failing, pending or passing", () => {
  expect(rollup([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }])).toBe("failing");
  expect(rollup([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS", conclusion: "" }])).toBe("pending");
  expect(rollup([{ conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toBe("passing");
  expect(rollup([])).toBeNull();
});

test("attaching is idempotent, canonicalises the link and stores GitHub's view", async () => {
  const home = mkdtempSync(join(tmpdir(), "jin-prs-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const db = openDb(home);
  const calls: string[][] = [];
  const prs = new TaskPRs(db, async (args) => {
    calls.push(args);
    return JSON.stringify({ title: "fix(apollo): preload org blocks", state: "OPEN", isDraft: true, reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [{ conclusion: "FAILURE" }], headRefName: "fix/PLEN-4548" });
  });
  await prs.attach("PLEN-4548", "https://github.com/ComposioHQ/platform/pull/15030/files", "hook");
  const again = await prs.attach("PLEN-4548", "https://github.com/ComposioHQ/platform/pull/15030", "claude");
  expect(prs.list("PLEN-4548")).toHaveLength(1);
  expect(again).toMatchObject({ url: "https://github.com/ComposioHQ/platform/pull/15030", repo: "ComposioHQ/platform", number: 15030, title: "fix(apollo): preload org blocks", draft: true, checks: "failing", attachedBy: "hook" });
  expect(calls[0]).toEqual(["pr", "view", "https://github.com/ComposioHQ/platform/pull/15030", "--json", "number,title,state,isDraft,reviewDecision,statusCheckRollup,headRefName"]);
  await expect(prs.attach("PLEN-4548", "https://gitlab.com/x/y/merge_requests/1", "you")).rejects.toThrow("not a GitHub pull request link");
});

test("Claude Code in a task is told to attach every PR it creates", () => {
  const rules = taskRules("PLEN-4548");
  expect(rules).toContain("jin task PLEN-4548");
  expect(rules).toContain("MUST-FOLLOW");
  expect(rules).toContain("jin-task attach-pr <pull request URL>");
});

test("PRs opened from a task's branch are found, and a detached one stays detached", async () => {
  const home = mkdtempSync(join(tmpdir(), "jin-prs-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "tasks", "PLEN-4548");
  mkdirSync(join(root, "platform"), { recursive: true });
  const db = openDb(home);
  const gh = async (args: string[]) =>
    args[0] === "pr" && args[1] === "list"
      ? JSON.stringify(args.includes("ComposioHQ/platform") && args.includes("fix/PLEN-4548-preload") ? [{ url: "https://github.com/ComposioHQ/platform/pull/15030" }] : [])
      : JSON.stringify({ title: "fix: preload", state: "OPEN" });
  const git = async (_cwd: string, args: string[]) => (args[0] === "remote" ? "git@github.com:ComposioHQ/platform.git\n" : "fix/PLEN-4548-preload\n");
  const prs = new TaskPRs(db, gh, git);
  const task = { id: "PLEN-4548", root, repos: ["platform", "missing-repo"] };
  await prs.discover(task);
  expect(prs.list("PLEN-4548").map((p) => `${p.number}:${p.attachedBy}`)).toEqual(["15030:branch"]);
  prs.detach("PLEN-4548", "https://github.com/ComposioHQ/platform/pull/15030");
  await prs.discover(task);
  expect(prs.list("PLEN-4548")).toEqual([]);
  // Attaching it on purpose brings it back.
  await prs.attach("PLEN-4548", "https://github.com/ComposioHQ/platform/pull/15030", "you");
  expect(prs.list("PLEN-4548")).toHaveLength(1);
});

test("a task's rules carry its workspace's brief, and say nothing workspace-specific without one", () => {
  const bare = taskRules({ taskId: "T-1", kind: "change", taskRoot: "/w/tasks/T-1", workspaceRoot: "/w" });
  expect(bare).toContain("You start in the task's folder, /w/tasks/T-1: one checkout per repo.");
  expect(bare).not.toMatch(/cws|TASK\.md|docs\/map|repos\/<repo>/);
  const review = taskRules({ taskId: "R-1", kind: "review", taskRoot: "/w/tasks/R-1" });
  expect(review).toContain("draft comments in your reply");
  expect(review).not.toMatch(/cws|TASK\.md/);
  const briefed = taskRules({ taskId: "R-1", kind: "review", brief: { start: "Start in R-1.", notes: "NOTES.md", setup: "Run `make deps`.", rules: ["Never touch vendor/."] } });
  expect(briefed).toContain("Start in R-1.");
  expect(briefed).toContain("draft comments in NOTES.md");
  expect(briefed).toContain("Run `make deps`.");
  expect(briefed).toContain("WORKSPACE RULE: Never touch vendor/.");
});
