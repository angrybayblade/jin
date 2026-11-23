// A31: a machine can run opencode in its agent tabs. An opencode tab starts with jin's plugin,
// every tool on "ask" (jin's plugin answers what jin allows), jin's tools and the task's rules,
// all in OPENCODE_CONFIG_CONTENT for that launch; its hooks deny what jin never runs and leave
// outward actions to opencode's prompt; status and session are reported, and it resumes its
// own session. `opencode` is a stand-in on PATH.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, startDaemon, until, type Daemon, type Env } from "./helpers";

let env: Env;
let d: Daemon;
let data: string;

const runs = (): { argv: string[]; config: string | null }[] => (existsSync(join(env.home, "oc-runs.json")) ? JSON.parse(readFileSync(join(env.home, "oc-runs.json"), "utf8")) : []);

beforeAll(async () => {
  env = setupEnv();
  writeFileSync(
    join(env.bin, "opencode"),
    `#!/usr/bin/env bun
const fs = require("node:fs");
const f = "${env.home}/oc-runs.json";
const runs = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
runs.push({ argv: process.argv.slice(2), config: process.env.OPENCODE_CONFIG_CONTENT ?? null });
fs.writeFileSync(f, JSON.stringify(runs));
setInterval(() => {}, 1000);
`,
  );
  chmodSync(join(env.bin, "opencode"), 0o755);
  const xdg = join(env.home, "..", "xdg-data");
  data = join(xdg, "opencode");
  mkdirSync(data, { recursive: true });
  d = await startDaemon(env, { XDG_DATA_HOME: xdg });
  const job = await d.json("/api/task-jobs", { method: "POST", json: { workspace: "composio", id: "OC-1", repos: ["platform"], slug: "oc", setup: false } });
  await until(async () => ((await d.json(`/api/task-jobs/${job.id}`)).state === "done" ? true : null), 20_000, "task created");
  expect((await d.json("/api/agents/default", { method: "PUT", json: { id: "opencode" } })).default).toBe("opencode");
});

afterAll(async () => {
  await d?.stop();
  env?.cleanup();
});

test("an opencode tab starts with jin's plugin, every tool on ask, jin's tools and the task's rules", async () => {
  const t = await d.json("/api/terminals", { method: "POST", json: { taskId: "OC-1", kind: "agent", prompt: "fix the bug" } });
  expect(t).toMatchObject({ kind: "agent", agent: "opencode", title: "opencode 1" });
  await until(() => runs().length === 1, 10000, "opencode launched");
  const { argv, config } = runs()[0]!;
  expect(argv).toEqual(["--prompt", "fix the bug"]);
  const c = JSON.parse(config!);
  expect(c.plugin[0]).toMatch(/opencode-plugin\.ts$/);
  expect(c.permission).toMatchObject({ "*": "ask", bash: "ask", edit: "ask" });
  expect(c.mcp.jin).toMatchObject({ type: "local", command: [expect.stringContaining("jin-task"), "mcp"], environment: { JIN_TERMINAL_ID: t.id } });
  expect(readFileSync(c.instructions[0], "utf8")).toContain("jin task OC-1");
});

test("an opencode tab's hooks: jin denies what it never runs, leaves a push to opencode's prompt, and hears status", async () => {
  const [t] = await d.json("/api/terminals?task=OC-1");
  const hook = (event: string, input: Record<string, unknown>) => d.json("/api/hooks/opencode", { method: "POST", json: { event, terminalId: t.id, sessionId: null, input } });
  await hook("SessionStart", { session_id: "ses_tab1", cwd: t.cwd });
  expect((await d.json(`/api/terminals/${t.id}`)).agentSessionId).toBe("ses_tab1");
  expect((await hook("PreToolUse", { tool_name: "bash", tool_input: { command: "vercel deploy --prod" } })).decision).toBe("deny");
  expect((await hook("PreToolUse", { tool_name: "write", cwd: t.cwd, tool_input: { filePath: `${env.home}/token`, content: "x" } })).decision).toBe("deny");
  expect(await hook("PreToolUse", { tool_name: "bash", tool_input: { command: "git push origin HEAD" } })).toMatchObject({ decision: "ask" });
  expect(await hook("PreToolUse", { tool_name: "mcp__slack__send_message", tool_input: { text: "hi" } })).toMatchObject({ decision: "ask" });
  await hook("Notification", { notification_type: "permission", message: "approval: git push origin HEAD" });
  expect(await d.json(`/api/terminals/${t.id}`)).toMatchObject({ status: "waiting", waitingFor: "approval: git push origin HEAD" });
  await hook("Resumed", {});
  expect((await d.json(`/api/terminals/${t.id}`)).status).toBe("working");
  expect(await hook("PreToolUse", { tool_name: "edit", cwd: t.cwd, tool_input: { filePath: "a.ts" } })).toEqual({});
  await hook("Stop", {});
  expect((await d.json(`/api/terminals/${t.id}`)).status).toBe("idle");
});

test("an opencode tab resumes its session when opencode has it, and cannot be forked", async () => {
  const [t] = await d.json("/api/terminals?task=OC-1");
  await d.json(`/api/terminals/${t.id}/restart`, { method: "POST", json: {} });
  await until(() => runs().length === 2, 10000, "opencode restarted");
  expect(runs()[1]!.argv).not.toContain("-s");
  await d.json("/api/hooks/opencode", { method: "POST", json: { event: "SessionStart", terminalId: t.id, sessionId: null, input: { session_id: "ses_tab1" } } });
  const db = new Database(join(data, "opencode.db"));
  db.exec("create table if not exists session (id text primary key); insert or ignore into session values ('ses_tab1');");
  db.close();
  await d.json(`/api/terminals/${t.id}/restart`, { method: "POST", json: {} });
  await until(() => runs().length === 3, 10000, "opencode resumed");
  expect(runs()[2]!.argv).toEqual(["-s", "ses_tab1"]);
  expect((await d.api("/api/terminals", { method: "POST", json: { taskId: "OC-1", kind: "agent", forkFrom: t.id } })).status).toBe(400);
}, 30_000);
