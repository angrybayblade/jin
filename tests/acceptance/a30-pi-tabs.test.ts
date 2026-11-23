// A30: a machine can run pi in its agent tabs. A pi tab starts with jin's extension (no trust
// step: pi loads an extension given with -e), the task's rules and jin's tools; its hooks deny
// what jin never runs and ask, in pi's own prompt, before outward actions; status and session
// are reported, and it resumes its own conversation. `pi` is a stand-in on PATH.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, startDaemon, until, type Daemon, type Env } from "./helpers";

let env: Env;
let d: Daemon;
let piDir: string;

const runs = (): { argv: string[]; mcp: string | null }[] => (existsSync(join(env.home, "pi-runs.json")) ? JSON.parse(readFileSync(join(env.home, "pi-runs.json"), "utf8")) : []);

beforeAll(async () => {
  env = setupEnv();
  // The stand-in records its argv and jin's MCP server, then stays up like pi's TUI.
  writeFileSync(
    join(env.bin, "pi"),
    `#!/usr/bin/env bun
if (process.argv[2] === "--version") { console.log("1.3.0"); process.exit(0); }
const fs = require("node:fs");
const f = "${env.home}/pi-runs.json";
const runs = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
runs.push({ argv: process.argv.slice(2), mcp: process.env.JIN_PI_MCP ?? null });
fs.writeFileSync(f, JSON.stringify(runs));
setInterval(() => {}, 1000);
`,
  );
  chmodSync(join(env.bin, "pi"), 0o755);
  piDir = join(env.home, "..", "pi-agent");
  mkdirSync(piDir, { recursive: true });
  d = await startDaemon(env, { PI_CODING_AGENT_DIR: piDir });
  const job = await d.json("/api/task-jobs", { method: "POST", json: { workspace: "composio", id: "PI-1", repos: ["platform"], slug: "pi", setup: false } });
  await until(async () => ((await d.json(`/api/task-jobs/${job.id}`)).state === "done" ? true : null), 20_000, "task created");
  expect((await d.json("/api/agents/default", { method: "PUT", json: { id: "pi" } })).default).toBe("pi");
});

afterAll(async () => {
  await d?.stop();
  env?.cleanup();
});

test("a pi tab starts with jin's extension, the task's rules and jin's tools", async () => {
  const t = await d.json("/api/terminals", { method: "POST", json: { taskId: "PI-1", kind: "agent", prompt: "fix the bug" } });
  expect(t).toMatchObject({ kind: "agent", agent: "pi", title: "pi 1" });
  await until(() => runs().length === 1, 10000, "pi launched");
  const { argv, mcp } = runs()[0]!;
  expect(argv[0]).toBe("-e");
  expect(argv[1]).toEndWith("pi-extension.ts");
  expect(argv[2]).toBe("--append-system-prompt");
  expect(argv[3]).toContain("jin task PI-1");
  expect(argv.at(-1)).toBe("fix the bug");
  expect(JSON.parse(mcp!)).toMatchObject({ args: ["mcp"], env: { JIN_TERMINAL_ID: t.id }, exposure: "direct" });
});

test("a pi tab's hooks: jin denies what it never runs, asks in pi before a push, and hears status", async () => {
  const [t] = await d.json("/api/terminals?task=PI-1");
  const hook = (event: string, input: Record<string, unknown>) => d.json("/api/hooks/pi", { method: "POST", json: { event, terminalId: t.id, sessionId: null, input } });
  await hook("SessionStart", { session_id: "01pi-session", cwd: t.cwd });
  expect((await d.json(`/api/terminals/${t.id}`)).agentSessionId).toBe("01pi-session");
  expect((await hook("PreToolUse", { tool_name: "bash", tool_input: { command: "vercel deploy --prod" } })).decision).toBe("deny");
  expect((await hook("PreToolUse", { tool_name: "write", cwd: t.cwd, tool_input: { path: `${env.home}/daemon.json`, content: "x" } })).decision).toBe("deny");
  const push = await hook("PreToolUse", { tool_name: "bash", tool_input: { command: "git -C platform push origin HEAD" } });
  expect(push).toMatchObject({ decision: "ask", reason: expect.stringContaining("pushes to a remote") });
  expect(await d.json(`/api/terminals/${t.id}`)).toMatchObject({ status: "waiting", waitingFor: expect.stringContaining("approval:") });
  await hook("Resumed", {});
  expect((await d.json(`/api/terminals/${t.id}`)).status).toBe("working");
  expect(await hook("PreToolUse", { tool_name: "edit", cwd: t.cwd, tool_input: { path: "notes.md", edits: [] } })).toEqual({});
  await hook("Stop", {});
  expect((await d.json(`/api/terminals/${t.id}`)).status).toBe("idle");
});

test("a pi tab resumes its conversation when pi saved one, and cannot be forked", async () => {
  const [t] = await d.json("/api/terminals?task=PI-1");
  await d.json(`/api/terminals/${t.id}/restart`, { method: "POST", json: {} });
  await until(() => runs().length === 2, 10000, "pi restarted");
  expect(runs()[1]!.argv).not.toContain("--session");
  // pi saved it (as it does once something is sent): the restart resumes it.
  await d.json("/api/hooks/pi", { method: "POST", json: { event: "SessionStart", terminalId: t.id, sessionId: null, input: { session_id: "01pi-session" } } });
  mkdirSync(join(piDir, "sessions", "--task--"), { recursive: true });
  writeFileSync(join(piDir, "sessions", "--task--", "2026-11-23T10-00-00-000Z_01pi-session.jsonl"), "{}\n");
  await d.json(`/api/terminals/${t.id}/restart`, { method: "POST", json: {} });
  await until(() => runs().length === 3, 10000, "pi resumed");
  expect(runs()[2]!.argv.slice(-2)).toEqual(["--session", "01pi-session"]);
  expect((await d.api("/api/terminals", { method: "POST", json: { taskId: "PI-1", kind: "agent", forkFrom: t.id } })).status).toBe(400);
}, 30_000);
