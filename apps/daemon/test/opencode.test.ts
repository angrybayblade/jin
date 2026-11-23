import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answer, opencodeCalls } from "../src/agent-hooks";
import { AgentTools } from "../src/agent-tools";
import { OpencodeHarness } from "../src/harness/opencode";
import { opencodeConfig, opencodeHasSession } from "../src/opencode-cli";

test("opencode's tools as jin knows them: filePath becomes file_path, a patch edits each file it touches", () => {
  expect(opencodeCalls("bash", { command: "ls", description: "x" })).toEqual([{ tool: "Bash", input: { command: "ls" } }]);
  expect(opencodeCalls("write", { filePath: "notes.md", content: "x" }, "/t")).toEqual([{ tool: "Write", input: { file_path: "/t/notes.md" } }]);
  expect(opencodeCalls("edit", { filePath: "/abs/a.ts" }, "/t")[0]).toEqual({ tool: "Edit", input: { file_path: "/abs/a.ts" } });
  expect(opencodeCalls("patch", { patchText: "*** Begin Patch\n*** Add File: a.md\n+x\n*** Update File: b.ts\n*** End Patch" }, "/t").map((c) => c.input.file_path)).toEqual(["/t/a.md", "/t/b.ts"]);
  expect(opencodeCalls("mcp__jin__journal", { text: "x" })).toEqual([{ tool: "mcp__jin__journal", input: { text: "x" } }]);
  expect(answer("opencode", "Bash", { decision: "ask", reason: "pushes" })).toEqual({ decision: "ask", reason: "pushes" });
});

test("a tab's opencode config asks for every tool (named ones too, past a user's own allow); a chat's leaves that to its gate", () => {
  const tab = JSON.parse(opencodeConfig({ ask: true, mcp: { command: ["jin-task", "mcp"], environment: { JIN_TERMINAL_ID: "t1" } }, instructions: "/r.md" }));
  expect(tab.plugin[0]).toMatch(/^file:\/\/.*opencode-plugin\.ts$/);
  expect(tab.permission).toMatchObject({ "*": "ask", bash: "ask", edit: "ask", webfetch: "ask" });
  expect(tab.mcp.jin).toEqual({ type: "local", command: ["jin-task", "mcp"], environment: { JIN_TERMINAL_ID: "t1" }, enabled: true });
  expect(tab.instructions).toEqual(["/r.md"]);
  expect(JSON.parse(opencodeConfig({ ask: false })).permission).toBeUndefined();
});

const dir = mkdtempSync(join(tmpdir(), "jin-opencode-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("an opencode session can be continued when opencode's database has it", () => {
  const data = join(dir, "data");
  mkdirSync(data);
  const db = new Database(join(data, "opencode.db"));
  db.exec("create table session (id text primary key); insert into session values ('ses_abc');");
  db.close();
  expect(opencodeHasSession("ses_abc", data)).toBe(true);
  expect(opencodeHasSession("ses_none", data)).toBe(false);
  expect(opencodeHasSession("../x", data)).toBe(false);
});

// A stand-in `opencode run --format json`: one tool call (a jin tool) and a message.
writeFileSync(
  join(dir, "opencode"),
  `#!/usr/bin/env bun
require("node:fs").writeFileSync(${JSON.stringify(join(dir, "log.json"))}, JSON.stringify({ argv: process.argv.slice(2), config: process.env.OPENCODE_CONFIG_CONTENT ?? null, session: process.env.JIN_SESSION_ID ?? null }));
const out = (e) => process.stdout.write(JSON.stringify({ sessionID: "ses_run_1", ...e }) + "\\n");
out({ type: "step_start", part: { type: "step-start" } });
out({ type: "tool_use", part: { type: "tool", tool: "jin_room_history", callID: "c1", state: { status: "completed", input: {} } } });
out({ type: "tool_use", part: { type: "tool", tool: "write", callID: "c2", state: { status: "error", input: { filePath: "r.md" }, error: "jin: read-only" } } });
out({ type: "text", part: { type: "text", text: "done" } });
`,
);
chmodSync(join(dir, "opencode"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;

test("an opencode turn: jin's plugin, tools and instructions are passed; events recorded; the session id returned", async () => {
  const events: [string, Record<string, unknown>][] = [];
  const { z } = await import("zod");
  const result = await new OpencodeHarness({ home: dir, tools: new AgentTools() }).run({
    jinSessionId: "s-5",
    prompt: "go",
    cwd: dir,
    env: {},
    resume: "ses_prev",
    instructions: "be brief",
    tools: [{ name: "room_history", description: "the room", input: { after: z.number().optional() }, run: async () => "" }],
    gate: async () => ({ allow: true }),
    emit: (kind, payload) => events.push([kind, payload]),
    signal: new AbortController().signal,
  });
  expect(result.sessionId).toBe("ses_run_1");
  const out = JSON.parse(readFileSync(join(dir, "log.json"), "utf8"));
  expect(out.argv).toEqual(["run", "--format", "json", "-s", "ses_prev", "go"]);
  expect(out.session).toBe("s-5");
  const config = JSON.parse(out.config);
  expect(config.permission).toBeUndefined();
  expect(config.mcp.jin.command[1]).toEndWith("agent-tools-mcp.ts");
  expect(readFileSync(config.instructions[0], "utf8")).toBe("be brief");
  expect(events.map(([k, p]) => `${k}:${p.tool ?? p.text ?? p.subtype ?? ""}${p.isError ? "!" : ""}`)).toEqual([
    "tool.started:mcp__jin__room_history",
    "tool.result:",
    `tool.started:Write`,
    "tool.result:!",
    "message:done",
    "result:success",
  ]);
});
