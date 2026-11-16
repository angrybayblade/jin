// A20: pull requests made in a task are attached to it: automatically when Claude Code runs
// `gh pr create`, by its jin-task command, and Claude Code is told to do so as a rule.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, startDaemon, until, type Daemon, type TestEnv } from "./helpers";

let env: TestEnv;
let d: Daemon;
let terminalId: string;

beforeAll(async () => {
  env = setupEnv();
  // A stand-in for Claude Code: records how jin launched it, then waits.
  writeFileSync(join(env.bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${env.home}/claude-args.txt"\nexec sleep 600\n`);
  chmodSync(join(env.bin, "claude"), 0o755);
  d = await startDaemon(env);
  await d.json("/api/workspaces/composio/tasks", { method: "POST", json: { id: "PR-1", repos: ["platform"], slug: "attach prs" } });
  terminalId = (await d.json("/api/terminals", { method: "POST", json: { taskId: "PR-1", kind: "claude" } })).id;
});
afterAll(async () => {
  await d.stop();
  env.cleanup();
});

test("A20 Claude Code in a task is launched with the attach-your-PRs rule and jin-task on PATH", async () => {
  await until(() => existsSync(join(env.home, "claude-args.txt")), 10000, "claude launched");
  const args = readFileSync(join(env.home, "claude-args.txt"), "utf8");
  expect(args).toContain("--append-system-prompt");
  expect(args).toContain("jin task PR-1");
  expect(args).toContain("jin-task attach-pr");
  // It starts in the task's folder, can read the whole workspace, and knows how to spawn sub-tasks.
  expect(args).toContain(`--add-dir\n${env.workspace}\n`);
  expect(args).toContain("TASK.md");
  expect(args).toContain("jin-task spawn");
  expect(statSync(join(env.home, "bin", "jin-task")).mode & 0o111).toBeGreaterThan(0);
});

test("A20 a PR created with `gh pr create` is attached by jin's hook", async () => {
  await d.json("/api/hooks/claude", {
    method: "POST",
    json: { event: "PostToolUse", terminalId, input: { tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, tool_response: { stdout: "https://github.com/ComposioHQ/platform/pull/15030\n" } } },
  });
  await until(async () => (await d.json<any[]>("/api/tasks/PR-1/prs"))[0]?.title === "PR 15030", 5000, "attached with its details");
  expect((await d.json<any[]>("/api/tasks/PR-1/prs"))[0]).toMatchObject({ number: 15030, repo: "ComposioHQ/platform", title: "PR 15030", state: "OPEN", checks: "passing", attachedBy: "hook" });
});

test("A20 `jin-task attach-pr` attaches a PR to the terminal's task", async () => {
  const run = Bun.spawnSync([join(env.home, "bin", "jin-task"), "attach-pr", "https://github.com/ComposioHQ/mercury/pull/30156"], { env: { ...process.env, JIN_HOME: env.home, JIN_TERMINAL_ID: terminalId } });
  expect(run.stdout.toString()).toContain("attached to the task");
  const prs = await d.json<any[]>("/api/tasks/PR-1/prs");
  expect(prs.map((p) => `${p.repo}#${p.number}:${p.attachedBy}`)).toEqual(["ComposioHQ/platform#15030:hook", "ComposioHQ/mercury#30156:claude"]);
  const bad = Bun.spawnSync([join(env.home, "bin", "jin-task"), "attach-pr", "not-a-link"], { env: { ...process.env, JIN_HOME: env.home, JIN_TERMINAL_ID: terminalId } });
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr.toString()).toContain("not a GitHub pull request link");
});

test("A20 `jin-task spawn` starts a sub-task under the terminal's task, asks first, and `jin-task subtasks` reports it", async () => {
  // Claude Code asks the user before spawning (jin's PreToolUse answer).
  const verdict = await d.json("/api/hooks/claude", { method: "POST", json: { event: "PreToolUse", terminalId, input: { tool_name: "Bash", tool_input: { command: 'jin-task spawn PR-1-a --repos platform --slug "split"' } } } });
  expect(verdict).toMatchObject({ decision: "ask" });

  const env2 = { ...process.env, JIN_HOME: env.home, JIN_TERMINAL_ID: terminalId };
  const run = Bun.spawnSync([join(env.home, "bin", "jin-task"), "spawn", "PR-1-a", "--repos", "platform", "--slug", "split part", "--no-setup"], { env: env2 });
  expect(run.stdout.toString()).toContain("sub-task PR-1-a of PR-1");
  const child = await until(async () => (await d.json<any[]>("/api/tasks")).find((t) => t.id === "PR-1-a"), 15000, "sub-task created");
  expect(child).toMatchObject({ parent: "PR-1", slug: "split part", repos: ["platform"] });
  const list = Bun.spawnSync([join(env.home, "bin", "jin-task"), "subtasks"], { env: env2 }).stdout.toString();
  expect(list).toContain("PR-1-a");

  const bad = Bun.spawnSync([join(env.home, "bin", "jin-task"), "spawn", "PR-1-b"], { env: env2 });
  expect(bad.exitCode).toBe(1);
});
