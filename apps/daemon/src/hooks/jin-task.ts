#!/usr/bin/env bun
// `jin-task`: what Claude Code (or you) can run inside a jin task's terminal.
//   jin-task attach-pr <url>   attach a pull request to this task
//   jin-task prs               list the task's pull requests
//   jin-task spawn <ID> --repos a,b --slug "..." [--prompt "..."] [--type bug] [--no-setup]
//                              split part of the work into a sub-task (own branch and PR)
//   jin-task subtasks          the sub-tasks spawned from this task, and how they are doing
// The terminal names the task (JIN_TERMINAL_ID, set by jin); the daemon's token is in JIN_HOME.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const [cmd, arg] = argv;
/** --name value (or --name=value) from the command line. */
const flag = (name: string): string | undefined => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = argv[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
};
const terminal = process.env.JIN_TERMINAL_ID;
const fail = (msg: string): never => {
  process.stderr.write(`jin-task: ${msg}\n`);
  process.exit(1);
};
if (!terminal) fail("not inside a jin terminal (JIN_TERMINAL_ID is not set)");

const home = process.env.JIN_HOME ?? join(homedir(), ".jin");
let daemon: { host: string; port: number; token: string };
try {
  daemon = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
} catch {
  fail("jin's daemon is not running");
}
const call = async (method: string, path: string, payload?: unknown) => {
  const res = await fetch(`http://${daemon.host}:${daemon.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  }).catch((e) => fail(`could not reach jin's daemon: ${e.message}`));
  const text = await res.text();
  if (!res.ok) fail((JSON.parse(text || "{}") as { error?: string }).error ?? `daemon answered ${res.status}`);
  return JSON.parse(text);
};

type PR = { url: string; title: string | null; state: string | null; draft: boolean };
const line = (p: PR) => `${p.url}  ${p.draft ? "draft" : (p.state ?? "").toLowerCase()}  ${p.title ?? ""}`.trim();

if (cmd === "attach-pr") {
  if (!arg) fail("usage: jin-task attach-pr <pull request url>");
  const pr = (await call("POST", `/api/terminals/${terminal}/prs`, { url: arg })) as PR;
  console.log(`attached to the task: ${line(pr)}`);
} else if (cmd === "prs") {
  const prs = (await call("GET", `/api/terminals/${terminal}/prs`)) as PR[];
  console.log(prs.length ? prs.map(line).join("\n") : "no pull requests attached to this task");
} else if (cmd === "spawn") {
  const repos = (flag("repos") ?? "").split(",").map((r) => r.trim()).filter(Boolean);
  const slug = flag("slug");
  if (!arg || arg.startsWith("--") || !repos.length || !slug) fail('usage: jin-task spawn <ID> --repos <repo,repo> --slug "<short title>" [--prompt "<what to do>"] [--type bug] [--no-setup]');
  const r = (await call("POST", `/api/terminals/${terminal}/subtasks`, { id: arg, repos, slug, prompt: flag("prompt"), type: flag("type"), setup: !argv.includes("--no-setup") })) as { taskId: string; parent: string };
  console.log(`sub-task ${r.taskId} of ${r.parent} is being set up; Claude Code opens there${flag("prompt") ? " with your prompt" : ""} once it is ready. Check on it with: jin-task subtasks`);
} else if (cmd === "subtasks") {
  type Sub = { id: string; title: string | null; state: string; error: string | null; claude: string | null; pullRequests: { url: string; state: string | null; checks: string | null }[] };
  const subs = (await call("GET", `/api/terminals/${terminal}/subtasks`)) as Sub[];
  if (!subs.length) console.log("no sub-tasks spawned from this task");
  for (const s of subs) {
    console.log(`${s.id}  ${s.state}${s.claude ? `  claude: ${s.claude}` : ""}  ${s.title ?? ""}`.trim());
    if (s.error) console.log(`  error: ${s.error}`);
    for (const p of s.pullRequests) console.log(`  ${p.url}  ${(p.state ?? "").toLowerCase()}${p.checks ? `  checks ${p.checks}` : ""}`);
  }
} else {
  console.log(
    'usage:\n  jin-task attach-pr <url>   attach a pull request to this task\n  jin-task prs               list the task\'s pull requests\n  jin-task spawn <ID> --repos a,b --slug "..." [--prompt "..."] [--type bug] [--no-setup]\n                             split part of the work into a sub-task\n  jin-task subtasks          the sub-tasks spawned from this task',
  );
  process.exit(cmd ? 1 : 0);
}
