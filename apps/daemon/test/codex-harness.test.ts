import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AgentTools } from "../src/agent-tools";
import { CodexHarness, innerCommand } from "../src/harness/codex";

// A stand-in `codex app-server`: one turn that runs a command needing approval, calls an MCP
// tool (an approval too), and answers. It records its argv and jin's answers.
const dir = mkdtempSync(join(tmpdir(), "jin-codex-harness-"));
const log = join(dir, "log.json");
writeFileSync(
  join(dir, "codex"),
  `#!/usr/bin/env bun
const fs = require("node:fs");
const out = { argv: process.argv.slice(2), answers: [], requests: [] };
const save = () => fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(out));
save();
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const pending = new Map();
const ask = (id, method, params) => new Promise((r) => { pending.set(id, r); send({ id, method, params }); });
let buf = "";
process.stdin.on("data", async (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id != null && m.method == null) { pending.get(m.id)?.(m.result ?? m.error); continue; }
    if (m.id == null) continue;
    out.requests.push([m.method, m.params]); save();
    if (m.method === "thread/start" || m.method === "thread/resume") { send({ id: m.id, result: { thread: { id: m.params.threadId ?? "th-1" } } }); continue; }
    if (m.method !== "turn/start") { send({ id: m.id, result: {} }); continue; }
    send({ id: m.id, result: { turn: { id: "tu-1" } } });
    const T = { threadId: "th-1", turnId: "tu-1" };
    send({ method: "turn/started", params: { ...T, turn: { id: "tu-1" } } });
    send({ method: "item/started", params: { ...T, item: { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'git push origin HEAD'" } } });
    const a1 = await ask(900, "item/commandExecution/requestApproval", { ...T, itemId: "c1", command: "/bin/zsh -lc 'git push origin HEAD'" });
    out.answers.push(a1); save();
    send({ method: "item/completed", params: { ...T, item: { type: "commandExecution", id: "c1", status: a1.decision === "accept" ? "completed" : "declined" } } });
    send({ method: "item/started", params: { ...T, item: { type: "mcpToolCall", id: "m1", server: "jin", tool: "room_history", arguments: {} } } });
    const a2 = await ask(901, "mcpServer/elicitation/request", { ...T, serverName: "jin", mode: "form", _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "room_history", tool_params: {} } });
    out.answers.push(a2); save();
    send({ method: "item/completed", params: { ...T, item: { type: "mcpToolCall", id: "m1", server: "jin", tool: "room_history", status: "completed" } } });
    send({ method: "item/agentMessage/delta", params: { ...T, delta: "done" } });
    send({ method: "item/completed", params: { ...T, item: { type: "agentMessage", id: "a1", text: "done" } } });
    send({ method: "turn/completed", params: { ...T, turn: { id: "tu-1", status: "completed" } } });
  }
});
`,
);
chmodSync(join(dir, "codex"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("Codex runs a command as /bin/zsh -lc '…': policy sees the command itself", () => {
  expect(innerCommand("/bin/zsh -lc 'git push origin HEAD'")).toBe("git push origin HEAD");
  expect(innerCommand("bash -c \"ls -la\"")).toBe("ls -la");
  expect(innerCommand("/bin/zsh -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
  expect(innerCommand("git status")).toBe("git status");
});

const run = async (allow: (tool: string) => boolean) => {
  const tools = new AgentTools();
  const gated: [string, Record<string, unknown>][] = [];
  const events: [string, Record<string, unknown>][] = [];
  const harness = new CodexHarness({ home: dir, tools, trust: async () => {} });
  const result = await harness.run({
    jinSessionId: "s-1",
    prompt: "push it",
    cwd: dir,
    env: {},
    tools: [{ name: "room_history", description: "the room", input: { after: z.number().optional() }, run: async () => "nothing new" }],
    gate: async (tool, input) => {
      gated.push([tool, input]);
      return allow(tool) ? { allow: true } : { allow: false, reason: "no" };
    },
    emit: (kind, payload) => events.push([kind, payload]),
    signal: new AbortController().signal,
  });
  return { result, gated, events, out: JSON.parse(readFileSync(log, "utf8")) };
};

test("a Codex run: each approval Codex asks for goes through jin's gate, and its answer back to Codex", async () => {
  const { result, gated, events, out } = await run(() => true);
  expect(result.sessionId).toBe("th-1");
  expect(gated).toEqual([
    ["Bash", { command: "git push origin HEAD" }],
    ["mcp__jin__room_history", {}],
  ]);
  expect(out.answers).toEqual([{ decision: "accept" }, { action: "accept", content: {} }]);
  // Codex is sandboxed, gets jin's hooks and the tools bridge, and knows the session.
  const flags = out.argv.join(" ");
  expect(flags).toContain("sandbox_workspace_write.network_access=false");
  expect(flags).toContain("hooks.PreToolUse=");
  expect(flags).toContain("agent-tools-mcp.ts");
  expect(out.requests.find((r: [string]) => r[0] === "thread/start")[1]).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" });
  expect(events.map(([k, p]) => `${k}:${p.tool ?? p.text ?? p.subtype ?? ""}`)).toEqual([
    "tool.started:Bash",
    "tool.result:",
    "tool.started:mcp__jin__room_history",
    "tool.result:",
    "message:done",
    "result:success",
  ]);
});

test("what jin's gate refuses, Codex is told to decline", async () => {
  const { out, events } = await run((tool) => tool !== "Bash");
  expect(out.answers).toEqual([{ decision: "decline" }, { action: "accept", content: {} }]);
  expect(events.find(([k]) => k === "tool.result")![1]).toMatchObject({ isError: true });
});
