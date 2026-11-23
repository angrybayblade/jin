// A29: a machine can run Codex instead of Claude Code in its agent tabs. Picking Codex needs it
// installed; a Codex tab starts with jin's hooks (trusted first through Codex's app-server, or
// not at all), its sandbox and the task's rules; its hooks deny what jin never runs and report
// status; and it resumes its own conversation. `codex` is a stand-in on PATH.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scripted, setupEnv, startDaemon, until, type Daemon, type Env } from "./helpers";

let env: Env;
let d: Daemon;
let codexHome: string;

// The stand-in: `codex app-server` answers hooks/list from the -c hooks it was given (trusted
// once config/batchWrite marks them, unless codex-refuse exists); `codex ...` records its argv.
const FAKE_CODEX = (home: string) => `#!/usr/bin/env bun
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = "${home}/codex-trust.json";
if (args[0] !== "app-server") {
  const runs = fs.existsSync("${home}/codex-args.json") ? JSON.parse(fs.readFileSync("${home}/codex-args.json", "utf8")) : [];
  runs.push(args);
  fs.writeFileSync("${home}/codex-args.json", JSON.stringify(runs));
  setInterval(() => {}, 1000);
} else {
  const trusted = () => (fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : {});
  const hooks = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "-c" && /^hooks\\.\\w+=/.test(args[i + 1])) hooks.push(args[i + 1]);
  const entries = () => hooks.map((h) => {
    const key = "/<session-flags>/config.toml:" + h.split("=")[0].slice(6) + ":0:0";
    const hash = "sha256:" + Bun.hash(h).toString(16);
    return { key, source: "sessionFlags", currentHash: hash, trustStatus: trusted()[key] === hash ? "trusted" : "untrusted" };
  });
  let buf = "";
  process.stdin.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.id == null) continue;
      let result = {};
      if (m.method === "hooks/list") result = { data: [{ cwd: m.params.cwds[0], hooks: entries() }] };
      if (m.method === "config/batchWrite" && !fs.existsSync("${home}/codex-refuse")) {
        const t = trusted();
        for (const e of m.params.edits) t[JSON.parse(e.keyPath.slice("hooks.state.".length, -".trusted_hash".length))] = e.value;
        fs.writeFileSync(state, JSON.stringify(t));
        result = { status: "ok" };
      }
      process.stdout.write(JSON.stringify({ id: m.id, result }) + "\\n");
    }
  });
}
`;

const runs = (): string[][] => (existsSync(join(env.home, "codex-args.json")) ? JSON.parse(readFileSync(join(env.home, "codex-args.json"), "utf8")) : []);
const flagValues = (argv: string[]) => argv.flatMap((a, i) => (argv[i - 1] === "-c" ? [a] : []));

beforeAll(async () => {
  env = setupEnv();
  writeFileSync(join(env.bin, "codex"), FAKE_CODEX(env.home));
  chmodSync(join(env.bin, "codex"), 0o755);
  writeFileSync(join(env.bin, "claude"), `#!/bin/sh\n[ "$1" = auth ] && exit 1\nexec sleep 600\n`);
  chmodSync(join(env.bin, "claude"), 0o755);
  codexHome = join(env.home, "..", "codex-home");
  mkdirSync(codexHome, { recursive: true });
  d = await startDaemon(env, { CODEX_HOME: codexHome });
  const job = await d.json("/api/task-jobs", { method: "POST", json: { workspace: "composio", id: "CX-1", repos: ["platform"], slug: "codex", setup: false } });
  await until(async () => ((await d.json(`/api/task-jobs/${job.id}`)).state === "done" ? true : null), 20_000, "task created");
});

afterAll(async () => {
  await d?.stop();
  env?.cleanup();
});

test("a machine starts Claude Code until Codex is picked, and only an installed agent can be picked", async () => {
  const before = await d.json("/api/agents");
  expect(before.default).toBe("claude");
  expect(before.agents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "claude", label: "Claude Code", installed: true, problem: null }),
      expect.objectContaining({ id: "codex", label: "Codex", installed: true, problem: null }),
    ]),
  );
  expect((await d.api("/api/agents/default", { method: "PUT", json: { id: "cursor" } })).status).toBe(400);
  expect((await d.json("/api/agents/default", { method: "PUT", json: { id: "codex" } })).default).toBe("codex");
});

test("a Codex tab starts only once jin's hooks are trusted, sandboxed, with the task's rules", async () => {
  // Codex will not trust them: no tab, and nothing left behind.
  writeFileSync(join(env.home, "codex-refuse"), "");
  const refused = await d.api("/api/terminals", { method: "POST", json: { taskId: "CX-1", kind: "agent" } });
  expect(refused.status).toBe(409);
  expect(await refused.text()).toContain("trust its hooks");
  expect(runs()).toEqual([]);
  expect((await d.json("/api/terminals?task=CX-1")).length).toBe(0);
  rmSync(join(env.home, "codex-refuse"));

  const t = await d.json("/api/terminals", { method: "POST", json: { taskId: "CX-1", kind: "agent", prompt: "fix the bug" } });
  expect(t).toMatchObject({ kind: "agent", agent: "codex", title: "Codex 1" });
  await until(() => runs().length === 1, 10000, "codex launched");
  const argv = runs()[0]!;
  const flags = flagValues(argv);
  // Every hook Codex was given is now trusted.
  const trusted = JSON.parse(readFileSync(join(env.home, "codex-trust.json"), "utf8"));
  expect(Object.keys(trusted).sort()).toEqual(["PermissionRequest", "PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"].map((e) => `/<session-flags>/config.toml:${e}:0:0`).sort());
  expect(flags.filter((f) => f.startsWith("hooks.PreToolUse=") && f.includes("codex-hook.ts"))).toHaveLength(1);
  expect(argv.join(" ")).toContain("-s workspace-write -a on-request");
  expect(flags).toContain("sandbox_workspace_write.network_access=false");
  expect(flags.some((f) => f.startsWith("mcp_servers.jin.command=") && f.includes("jin-task"))).toBe(true);
  expect(flags).toContain('mcp_servers.jin.default_tools_approval_mode="approve"');
  const rules = flags.find((f) => f.startsWith("developer_instructions="))!;
  expect(rules).toContain("jin task CX-1");
  expect(rules).toContain("request escalated permissions");
  expect(argv.at(-1)).toBe("fix the bug");
}, 30_000);

test("a Codex tab's hooks: jin denies what it never runs, Codex asks for the network, status and session are reported", async () => {
  const [t] = await d.json("/api/terminals?task=CX-1");
  const hook = (event: string, input: Record<string, unknown>) => d.json("/api/hooks/codex", { method: "POST", json: { event, terminalId: t.id, input } });
  expect(await hook("SessionStart", { session_id: "019a-codex-1", cwd: t.cwd })).toEqual({});
  expect((await d.json(`/api/terminals/${t.id}`)).agentSessionId).toBe("019a-codex-1");

  const deploy = await hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "vercel deploy --prod" } });
  expect(deploy.decision).toBe("deny");
  // A patch that touches jin's credentials is an edit of them.
  const secret = await hook("PreToolUse", { tool_name: "apply_patch", cwd: t.cwd, tool_input: { command: `*** Begin Patch\n*** Update File: ${env.home}/daemon.json\n@@\n-a\n+b\n*** End Patch` } });
  expect(secret.decision).toBe("deny");
  // A push needs the network: Codex's sandbox asks the user, so jin stays silent.
  expect(await hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "git push origin HEAD" } })).toEqual({});
  // An outward tool Codex would run without asking: blocked.
  const slack = await hook("PreToolUse", { tool_name: "mcp__slack__send_message", tool_input: { text: "hi" } });
  expect(slack.decision).toBe("deny");
  expect(slack.reason).toContain("Codex tab cannot ask");
  expect(await hook("PreToolUse", { tool_name: "apply_patch", cwd: t.cwd, tool_input: { command: "*** Begin Patch\n*** Add File: notes.md\n+hi\n*** End Patch" } })).toEqual({});

  await hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "git push origin HEAD" } });
  expect(await d.json(`/api/terminals/${t.id}`)).toMatchObject({ status: "waiting", waitingFor: "approval: git push origin HEAD" });
  await hook("Stop", {});
  expect((await d.json(`/api/terminals/${t.id}`)).status).toBe("idle");
});

test("a Codex tab resumes its conversation when Codex saved one, and cannot be forked", async () => {
  const [t] = await d.json("/api/terminals?task=CX-1");
  // Nothing saved under that id yet: it starts fresh.
  await d.json(`/api/terminals/${t.id}/restart`, { method: "POST", json: {} });
  await until(() => runs().length === 2, 10000, "codex restarted");
  expect(runs()[1]).not.toContain("resume");
  // Codex saved it (as it does once something is sent): the restart resumes it.
  await d.json("/api/hooks/codex", { method: "POST", json: { event: "SessionStart", terminalId: t.id, input: { session_id: "019a-codex-2" } } });
  mkdirSync(join(codexHome, "sessions", "2026", "11", "23"), { recursive: true });
  writeFileSync(join(codexHome, "sessions", "2026", "11", "23", "rollout-2026-11-23T10-00-00-019a-codex-2.jsonl"), "{}\n");
  await d.json(`/api/terminals/${t.id}/restart`, { method: "POST", json: {} });
  await until(() => runs().length === 3, 10000, "codex resumed");
  expect(runs()[2]!.slice(-2)).toEqual(["resume", "019a-codex-2"]);

  const fork = await d.api("/api/terminals", { method: "POST", json: { taskId: "CX-1", kind: "agent", forkFrom: t.id } });
  expect(fork.status).toBe(400);
}, 30_000);

test("Claude Code tabs still open when asked for by their old name, on the machine's default agent", async () => {
  await d.json("/api/agents/default", { method: "PUT", json: { id: "claude" } });
  const t = await d.json("/api/terminals", { method: "POST", json: { taskId: "CX-1", kind: "claude" } });
  expect(t).toMatchObject({ kind: "agent", agent: "claude", title: "Claude 1" });
});

test("a chat or room agent on Codex: its hooks ask jin whether a call may start, by the session's rules", async () => {
  const hook = (sessionId: string, input: Record<string, unknown>) => d.json("/api/hooks/codex", { method: "POST", json: { event: "PreToolUse", terminalId: null, sessionId, input } });
  const chat = await d.json("/api/tasks/CX-1/sessions", { method: "POST", json: { prompt: scripted([{ text: "ok" }]) } });
  expect((await hook(chat.id, { tool_name: "Bash", tool_input: { command: "vercel deploy --prod" } })).decision).toBe("deny");
  // Outward: not decided here; Codex's sandbox sends it to the session's gate as an approval.
  expect(await hook(chat.id, { tool_name: "Bash", tool_input: { command: "git push origin HEAD" } })).toEqual({});
  const [t] = await d.json("/api/terminals?task=CX-1");
  expect((await hook(chat.id, { tool_name: "apply_patch", cwd: t.cwd, tool_input: { command: `*** Begin Patch\n*** Add File: ${env.home}/token\n+x\n*** End Patch` } })).decision).toBe("deny");
  const events = await d.json(`/api/sessions/${chat.id}/events`);
  expect(events.some((e: { kind: string; payload: { by?: string } }) => e.kind === "tool.denied" && e.payload.by === "policy")).toBe(true);

  // A read-only room agent: an edit is refused whatever it says; reading is fine.
  await d.json("/api/tasks/CX-1/room/messages", { method: "POST", json: { text: "@reviewer have a look" } });
  const reviewer = await until(async () => (await d.json("/api/tasks/CX-1/room")).agents.find((a: { handle: string; sessionId: string | null }) => a.handle === "reviewer" && a.sessionId), 10000, "reviewer's session");
  const edit = await hook(reviewer.sessionId, { tool_name: "apply_patch", cwd: t.cwd, tool_input: { command: "*** Begin Patch\n*** Add File: review.md\n+hi\n*** End Patch" } });
  expect(edit.decision).toBe("deny");
  expect(await hook(reviewer.sessionId, { tool_name: "Bash", tool_input: { command: "git diff" } })).toEqual({});
  expect((await hook(reviewer.sessionId, { tool_name: "Bash", tool_input: { command: "git commit -am x" } })).decision).toBe("deny");
}, 30_000);
