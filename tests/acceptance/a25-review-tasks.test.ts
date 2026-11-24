// A25: reviewing pull requests as tasks, and jin's skills. A skill tagged pr-review is kept in
// jin; a PR link becomes a review task (numbered by the workspace's cws, its repo checked out
// at the PR head), Claude Code starts with the skill as a /jin: plugin and the review rules;
// asking again opens the same task; when the PR merges the task is archived and removed, and
// the merge clean-up hook (for your own PRs) does not run for it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, startDaemon, until, type Daemon, type TestEnv } from "./helpers";

let env: TestEnv;
let d: Daemon;

// A cws that has task kinds (0.2): review tasks are git checkouts at a "PR head".
const CWS = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dir, "..");
const a = process.argv.slice(2);
appendFileSync(join(root, "cws.log"), a.join(" ") + "\\n");
const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const all = (n) => a.flatMap((x, i) => (x === n ? [a[i + 1]] : []));
const git = (cwd, ...args) => { const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd }); return r.stdout.toString().trim(); };
if (a[0] === "--help") console.log("  cws task new linear --id <ISSUE-ID> --repos a,b\\n  cws task new review --pr <repo>#<n>");
else if (a[0] === "task" && a[1] === "next-id") {
  const n = existsSync(join(root, "tasks")) ? readdirSync(join(root, "tasks")).filter((x) => x.startsWith("REV-1117")).length : 0;
  console.log("REV-1117" + String(n + 1).padStart(2, "0"));
} else if (a[0] === "task" && a[1] === "new" && a[2] === "review") {
  const id = flag("--id");
  const prs = all("--pr").map((p) => { const [repo, n] = p.split("#"); return { repo, number: Number(n) }; });
  for (const p of prs) {
    const dir = join(root, "tasks", id, p.repo);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    writeFileSync(join(dir, "pr.txt"), "the PR\\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "pr");
    p.head = git(dir, "rev-parse", "HEAD");
    p.title = "PR " + p.number;
    p.url = "https://github.com/ComposioHQ/" + p.repo + "/pull/" + p.number;
  }
  writeFileSync(join(root, "tasks", id, "task.json"), JSON.stringify({ id, kind: "review", type: "review", branch: "", base: {}, repos: prs.map((p) => p.repo), prs, title: prs.map((p) => p.title).join(", "), created: new Date().toISOString() }));
  console.log("task " + id + " reviewing");
} else if (a[0] === "task" && a[1] === "rm") rmSync(join(root, "tasks", a[2]), { recursive: true, force: true });
else { console.error("fake cws: unsupported " + a.join(" ")); process.exit(1); }
`;

beforeAll(async () => {
  env = setupEnv();
  writeFileSync(join(env.workspace, "bin", "cws"), CWS);
  chmodSync(join(env.workspace, "bin", "cws"), 0o755);
  writeFileSync(join(env.bin, "claude"), `#!/bin/sh\n[ "$1" = --version ] && echo "2.0.0 (Claude Code)" && exit 0\nprintf '%s\\n' "$@" > "${env.home}/claude-args.txt"\nexec sleep 600\n`);
  chmodSync(join(env.bin, "claude"), 0o755);
  d = await startDaemon(env);
});
afterAll(async () => {
  await d.stop();
  env.cleanup();
});

const cwsLog = () => readFileSync(join(env.workspace, "cws.log"), "utf8").trim().split("\n");

test("A25 a PR becomes a review task with the skills tagged for reviews, and goes away when it merges", async () => {
  // Skills: one for reviews, one for other work.
  await d.json("/api/skills/review-deep", { method: "PUT", json: { body: "---\ndescription: How I review\n---\n\nRead the tests first.", tags: ["pr-review"] } });
  await d.json("/api/skills/ship-it", { method: "PUT", json: { body: "Ship carefully.", tags: ["linear-task"] } });
  const listed = await d.json("/api/skills");
  expect(listed.skills.map((s: { name: string; tags: string[] }) => [s.name, s.tags])).toEqual([["review-deep", ["pr-review"]], ["ship-it", ["linear-task"]]]);

  // Review a PR: the workspace numbers the task and checks out the PR.
  const started = await d.json("/api/reviews", { method: "POST", json: { prs: ["https://github.com/ComposioHQ/platform/pull/12"] } });
  expect(started).toMatchObject({ taskId: "REV-111701", existing: false });
  const task = await until(async () => ((await d.json("/api/tasks")) as { id: string; kind: string }[]).find((t) => t.id === "REV-111701") ?? null, 10_000, "review task");
  expect(task).toMatchObject({ kind: "review", prs: [{ repo: "platform", number: 12, title: "PR 12" }] });
  // No setup: a plain checkout; the reviewer installs only what it needs.
  expect(cwsLog()).toContain("task new review --id REV-111701 --pr platform#12");

  // Claude Code starts on it: the review skill as a plugin (not the other), and the review rules.
  await until(() => existsSync(join(env.home, "claude-args.txt")), 10_000, "claude launched");
  const args = readFileSync(join(env.home, "claude-args.txt"), "utf8");
  const plugin = join(env.home, "task-plugins", "REV-111701", "jin");
  expect(args).toContain(`--plugin-dir\n${plugin}\n`);
  expect(existsSync(join(plugin, "skills", "review-deep", "SKILL.md"))).toBe(true);
  expect(existsSync(join(plugin, "skills", "ship-it"))).toBe(false);
  expect(args).toContain("a REVIEW of pull requests: platform#12 (PR 12)");
  expect(args).toContain("/jin:review-deep");
  expect(args).toContain("SETUP IS YOURS TO DECIDE");
  expect(args).toContain("cws install <repo> --task REV-111701");
  expect(args).toContain("Review the pull requests in this task");

  // Asking again (as platform#12) opens the same task.
  expect(await d.json("/api/reviews", { method: "POST", json: { prs: ["platform#12"] } })).toMatchObject({ taskId: "REV-111701", existing: true });

  // The task follows the PR; when it merges, the task is archived and removed.
  const prs = await until(async () => {
    const p = (await d.json("/api/tasks/REV-111701/prs")) as { url: string; state: string }[];
    return p.length ? p : null;
  }, 10_000, "PR attached");
  expect(prs[0]).toMatchObject({ url: "https://github.com/ComposioHQ/platform/pull/12", state: "OPEN" });
  appendFileSync(join(env.home, "..", "gh-merged"), "12\n");
  await d.json("/api/tasks/REV-111701/prs/refresh", { method: "POST" });
  // cws logs the call as it starts: wait for jin to record the task removed, not for the log line.
  const after = await until(async () => {
    const t = ((await d.json("/api/tasks")) as { id: string; state: string; archived: boolean }[]).find((x) => x.id === "REV-111701");
    return t?.state === "removed" ? t : null;
  }, 10_000, "review task removed");
  expect(after).toMatchObject({ state: "removed", archived: true });
  expect(cwsLog()).toContain("task rm REV-111701");
  // Someone else's PR merging is not your work done: the merge clean-up hook stays quiet.
  expect((await d.json("/api/event-hooks")).runs).toEqual([]);
}, 60_000);
