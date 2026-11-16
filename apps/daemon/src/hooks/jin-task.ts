#!/usr/bin/env bun
// `jin-task`: what Claude Code (or you) can run inside a jin task's terminal.
//   jin-task attach-pr <url>   attach a pull request to this task
//   jin-task prs               list the task's pull requests
// The terminal names the task (JIN_TERMINAL_ID, set by jin); the daemon's token is in JIN_HOME.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [cmd, arg] = process.argv.slice(2);
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
} else {
  console.log("usage:\n  jin-task attach-pr <url>   attach a pull request to this task\n  jin-task prs               list the task's pull requests");
  process.exit(cmd ? 1 : 0);
}
