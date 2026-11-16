import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
