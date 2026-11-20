#!/usr/bin/env bun
// `jin-task`: what Claude Code (or you) can run inside a jin task's terminal.
//   jin-task attach-pr <url>   attach a pull request to this task
//   jin-task prs               list the task's pull requests
//   jin-task spawn <ID> --repos a,b --slug "..." [--prompt "..."] [--type bug] [--no-setup]
//                              split part of the work into a sub-task (own branch and PR)
//   jin-task subtasks          the sub-tasks spawned from this task, and how they are doing
//   jin-task context           the task's context: its PRs, what it follows (Slack threads and
//                              channels, Notion pages, its Linear issue) and the latest on each
//   jin-task doc <id>          a jin doc (a spec, an RFC) the task links, as markdown
//   jin-task mcp               jin's MCP server for Claude Code (stdio): `journal`, `task_context`, `read_doc`
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

/** The task's context, as text (also the task_context tool's answer). */
const context = async (): Promise<{ ok: string } | { error: string }> => {
  try {
    const res = await fetch(`http://${daemon.host}:${daemon.port}/api/terminals/${terminal}/context`, { headers: { authorization: `Bearer ${daemon.token}` } });
    const text = await res.text();
    if (!res.ok) return { error: (JSON.parse(text || "{}") as { error?: string }).error ?? `jin answered ${res.status}` };
    return { ok: text };
  } catch (e) {
    return { error: `could not reach jin: ${(e as Error).message}` };
  }
};

/** A jin doc as markdown (docs live on jin's home; this machine's daemon fetches it). */
const readDoc = async (id: string): Promise<{ ok: string } | { error: string }> => {
  try {
    const res = await fetch(`http://${daemon.host}:${daemon.port}/api/task-docs/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${daemon.token}` } });
    const text = await res.text();
    if (!res.ok) return { error: (JSON.parse(text || "{}") as { error?: string }).error ?? `jin answered ${res.status}` };
    return { ok: text };
  } catch (e) {
    return { error: `could not reach jin: ${(e as Error).message}` };
  }
};

type PR = { url: string; title: string | null; state: string | null; draft: boolean };
const line = (p: PR) => `${p.url}  ${p.draft ? "draft" : (p.state ?? "").toLowerCase()}  ${p.title ?? ""}`.trim();

if (cmd === "mcp") {
  await serveMcp();
} else if (cmd === "context") {
  const r = await context();
  if ("error" in r) fail(r.error);
  else console.log(r.ok);
} else if (cmd === "doc") {
  if (!arg) fail("usage: jin-task doc <doc id>");
  const r = await readDoc(arg!);
  if ("error" in r) fail(r.error);
  else console.log(r.ok);
} else if (cmd === "attach-pr") {
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
    'usage:\n  jin-task context           the task\'s PRs, what it follows, and the latest on each\n  jin-task attach-pr <url>   attach a pull request to this task\n  jin-task prs               list the task\'s pull requests\n  jin-task spawn <ID> --repos a,b --slug "..." [--prompt "..."] [--type bug] [--no-setup]\n                             split part of the work into a sub-task\n  jin-task subtasks          the sub-tasks spawned from this task\n  jin-task doc <id>          a jin doc the task links, as markdown',
  );
  process.exit(cmd ? 1 : 0);
}

/**
 * jin's MCP server over stdio (newline-delimited JSON-RPC), started by Claude Code in a task:
 * one tool, `journal`, that records a decision, finished work or a finding under a concern.
 * Replies are a word or two, so the journal costs Claude Code almost no context.
 */
async function serveMcp() {
  const TOOL = {
    name: "journal",
    description:
      "Record one line in the task's work journal, which the user watches: a decision (with why), work done, or a finding, under a short concern label (reuse existing labels). Files, commits and tests are recorded automatically. Call it alongside your next tool call; it replies \"ok\".",
    inputSchema: {
      type: "object",
      properties: {
        concern: { type: "string", description: 'short label for one area of the work, e.g. "rate limiter"' },
        kind: { type: "string", enum: ["decision", "done", "found"] },
        text: { type: "string", description: "one line" },
        why: { type: "string", description: "for decisions: the reason, one line" },
      },
      required: ["concern", "kind", "text"],
    },
  };
  const CONTEXT_TOOL = {
    name: "task_context",
    description:
      "The task's context from jin, as it is now: its pull requests (state, checks, review), what it follows (its Linear issue, Slack threads and channels, Notion pages, each with how to read it in full) and the latest on each, one line per event. Call it when the work depends on a discussion, a ticket or a doc, or to see what changed; then read only what you need in full with the Slack, Linear, Notion tools or gh.",
    inputSchema: { type: "object", properties: {} },
  };
  const DOC_TOOL = {
    name: "read_doc",
    description: "Read a jin doc (a spec, RFC or design the user wrote with jin) as markdown, by its id. task_context lists the docs this task links.",
    inputSchema: { type: "object", properties: { docId: { type: "string" } }, required: ["docId"] },
  };
  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const answer = async (m: { id?: number | string; method?: string; params?: any }) => {
    if (m.id === undefined) return; // a notification
    if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "jin", version: "1" } } });
    if (m.method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
    if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [TOOL, CONTEXT_TOOL, DOC_TOOL] } });
    if (m.method === "tools/call") {
      const text = await (async () => {
        if (m.params?.name === "task_context") return context();
        if (m.params?.name === "read_doc") return readDoc(String(m.params?.arguments?.docId ?? ""));
        if (m.params?.name !== "journal") return { error: `unknown tool ${m.params?.name}` };
        try {
          const res = await fetch(`http://${daemon.host}:${daemon.port}/api/terminals/${terminal}/journal`, {
            method: "POST",
            headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
            body: JSON.stringify(m.params?.arguments ?? {}),
          });
          const j = (await res.json().catch(() => ({}))) as { reply?: string; error?: string };
          return res.ok ? { ok: j.reply ?? "ok" } : { error: j.error ?? `jin answered ${res.status}` };
        } catch (e) {
          return { error: `could not reach jin: ${(e as Error).message}` };
        }
      })();
      return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" in text ? text.ok : text.error }], ...("error" in text ? { isError: true } : {}) } });
    }
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  };
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        await answer(JSON.parse(line));
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
    }
  }
}
