import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { agentHookRoutes, answer, piCalls } from "../src/agent-hooks";
import { AgentTools } from "../src/agent-tools";
import { PiHarness } from "../src/harness/pi";
import { Router } from "../src/http";
import type { Terminals } from "../src/terminals";

test("pi's tools as jin knows them: bash, edit, write, read with absolute paths; MCP as it is", () => {
  expect(piCalls("bash", { command: "ls" })).toEqual([{ tool: "Bash", input: { command: "ls" } }]);
  expect(piCalls("edit", { path: "src/a.ts", edits: [] }, "/task")).toEqual([{ tool: "Edit", input: { file_path: "/task/src/a.ts" } }]);
  expect(piCalls("write", { path: "/abs/b.md", content: "x" }, "/task")).toEqual([{ tool: "Write", input: { file_path: "/abs/b.md" } }]);
  expect(piCalls("read", { path: "c" }, "/t")[0]).toEqual({ tool: "Read", input: { file_path: "/t/c" } });
  expect(piCalls("find", { pattern: "*.ts" }, "/t")[0]).toEqual({ tool: "Glob", input: { pattern: "*.ts", path: undefined } });
  expect(piCalls("mcp__jin__journal", { text: "x" })).toEqual([{ tool: "mcp__jin__journal", input: { text: "x" } }]);
});

test("in a pi tab, what jin asks about is asked in pi's own prompt", () => {
  expect(answer("pi", "Bash", { decision: "ask", reason: "pushes to a remote" })).toEqual({ decision: "ask", reason: "pushes to a remote" });
  expect(answer("pi", "mcp__slack__send_message", { decision: "ask", reason: "sends" }).decision).toBe("ask");
});

test("a pi chat or room agent's tool call is decided by its session's gate, and pi is told", async () => {
  const router = new Router();
  const asked: [string, string, Record<string, unknown>][] = [];
  agentHookRoutes(router, {
    terminals: { isLive: () => false } as unknown as Terminals,
    adapters: new Map(),
    workspaceOf: () => undefined,
    sessionGate: async (sessionId, tool, input) => {
      asked.push([sessionId, tool, input]);
      return tool === "Write" ? { allow: false, reason: "@reviewer is read-only" } : { allow: true };
    },
  });
  const call = async (input: Record<string, unknown>) => {
    const m = router.match("POST", "/api/hooks/pi")!;
    const req = new Request("http://x/api/hooks/pi", { method: "POST", body: JSON.stringify({ event: "PreToolUse", terminalId: null, sessionId: "s-1", input }) });
    return (await m.handler(req, m.params, new URL(req.url))).json();
  };
  expect(await call({ tool_name: "write", tool_input: { path: "review.md" }, cwd: "/task" })).toEqual({ decision: "deny", reason: "@reviewer is read-only" });
  expect(await call({ tool_name: "bash", tool_input: { command: "git diff" }, cwd: "/task" })).toEqual({ decision: "allow" });
  expect(asked).toEqual([
    ["s-1", "Write", { file_path: "/task/review.md" }],
    ["s-1", "Bash", { command: "git diff" }],
  ]);
});

// A stand-in `pi --mode rpc`: answers a prompt with one tool call and a message, then settles;
// get_state names the session. It records its argv and environment.
const dir = mkdtempSync(join(tmpdir(), "jin-pi-harness-"));
const log = join(dir, "log.json");
writeFileSync(
  join(dir, "pi"),
  `#!/usr/bin/env bun
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), mcp: process.env.JIN_PI_MCP ?? null, session: process.env.JIN_SESSION_ID ?? null }));
const send = (r) => process.stdout.write(JSON.stringify(r) + "\\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const r = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (r.type === "get_state") { send({ id: r.id, type: "response", command: "get_state", success: true, data: { sessionId: "pi-sess-1" } }); continue; }
    if (r.type !== "prompt") continue;
    send({ id: r.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    send({ type: "agent_start" });
    send({ type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: { path: "a.ts" } });
    send({ type: "tool_execution_end", toolCallId: "t1", toolName: "edit", isError: false });
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
    send({ type: "agent_settled", aborted: false });
  }
});
process.stdin.on("end", () => process.exit(0));
`,
);
chmodSync(join(dir, "pi"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a pi run over RPC: jin's extension and tools are passed, events recorded, the session id returned", async () => {
  const events: [string, Record<string, unknown>][] = [];
  const result = await new PiHarness({ home: dir, tools: new AgentTools() }).run({
    jinSessionId: "s-9",
    prompt: "go",
    cwd: dir,
    env: {},
    instructions: "be brief",
    tools: [{ name: "room_history", description: "the room", input: { after: z.number().optional() }, run: async () => "" }],
    gate: async () => ({ allow: true }),
    emit: (kind, payload) => events.push([kind, payload]),
    signal: new AbortController().signal,
  });
  expect(result.sessionId).toBe("pi-sess-1");
  const out = JSON.parse(readFileSync(log, "utf8"));
  expect(out.argv.slice(0, 3)).toEqual(["--mode", "rpc", "-e"]);
  expect(out.argv[3]).toEndWith("pi-extension.ts");
  expect(out.argv.slice(4)).toEqual(["--append-system-prompt", "be brief"]);
  expect(out.session).toBe("s-9");
  expect(JSON.parse(out.mcp)).toMatchObject({ args: [expect.stringContaining("agent-tools-mcp.ts")], exposure: "direct" });
  expect(events.map(([k, p]) => `${k}:${p.tool ?? p.text ?? p.subtype ?? ""}`)).toEqual(["tool.started:Edit", "tool.result:", "message:done", "result:success"]);
});
