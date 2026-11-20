import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { scripted, setupEnv, startDaemon, until, type Daemon, type Env } from "./helpers";

let env: Env;
let d: Daemon;
beforeAll(async () => {
  env = setupEnv();
  d = await startDaemon(env);
  await d.json("/api/workspaces/composio/tasks", { method: "POST", json: { id: "PLEN-5", repos: ["platform"], slug: "s" } });
});
afterAll(async () => {
  await d?.stop();
  env?.cleanup();
});

const events = (id: string, after = 0) => d.json<any[]>(`/api/sessions/${id}/events?after=${after}`);
const startSession = (prompt: string) => d.json("/api/tasks/PLEN-5/sessions", { method: "POST", json: { prompt } });
const idle = (id: string) => until(async () => (await d.json(`/api/sessions/${id}`)).state === "idle", 10_000, "session idle");

const DENIED = [
  "pulumi up --yes",
  "cd infra && pulumi destroy",
  "vercel deploy --prod",
  "gh workflow run deploy.yml",
  "doppler secrets set FOO=bar",
  "pnpm run deploy:production",
  "npm publish",
];
const ALLOWED = ["pnpm test", "git status", "ls -la", "cws check", "git diff --stat"];

test("A12 the deny hook blocks deploy commands and allows normal ones", async () => {
  for (const command of DENIED) {
    const r = await d.json("/api/policy/evaluate", { method: "POST", json: { workspace: "composio", tool: "Bash", input: { command } } });
    expect({ command, decision: r.decision }).toEqual({ command, decision: "deny" });
  }
  for (const command of ALLOWED) {
    const r = await d.json("/api/policy/evaluate", { method: "POST", json: { workspace: "composio", tool: "Bash", input: { command } } });
    expect({ command, decision: r.decision }).toEqual({ command, decision: "allow" });
  }
  // Wired into a real session: the agent's denied call never runs.
  const s = await startSession(scripted([{ tool: "Bash", input: { command: "pulumi up --yes" } }, { text: "done" }]));
  await idle(s.id);
  const ev = await events(s.id);
  expect(ev.some((e) => e.kind === "tool.denied" && e.payload.input.command === "pulumi up --yes")).toBe(true);
  expect(ev.some((e) => e.kind === "tool.result" && e.payload.input?.command === "pulumi up --yes")).toBe(false);
});

test("A13 outward actions wait for approval; approve runs, reject blocks", async () => {
  for (const command of ["git push origin HEAD", "gh pr create --fill", "gh pr comment 12 --body hi"]) {
    const r = await d.json("/api/policy/evaluate", { method: "POST", json: { workspace: "composio", tool: "Bash", input: { command } } });
    expect({ command, decision: r.decision }).toEqual({ command, decision: "ask" });
  }
  const s = await startSession(
    scripted([
      { tool: "Bash", input: { command: "git push origin HEAD" } },
      { tool: "Bash", input: { command: "gh pr create --fill" } },
      { text: "done" },
    ]),
  );
  const first = await until(async () => (await d.json<any[]>("/api/approvals?state=pending")).find((a) => a.sessionId === s.id), 10_000, "first approval");
  expect(first.action).toEqual(expect.objectContaining({ tool: "Bash", input: { command: "git push origin HEAD" } }));
  expect((await d.json(`/api/sessions/${s.id}`)).state).toBe("waiting_approval");
  await d.json(`/api/approvals/${first.id}`, { method: "POST", json: { decision: "approve" } });

  const second = await until(
    async () => (await d.json<any[]>("/api/approvals?state=pending")).find((a) => a.sessionId === s.id && a.id !== first.id),
    10_000,
    "second approval",
  );
  await d.json(`/api/approvals/${second.id}`, { method: "POST", json: { decision: "reject" } });
  await idle(s.id);

  const ev = await events(s.id);
  expect(ev.some((e) => e.kind === "tool.allowed" && e.payload.input.command === "git push origin HEAD")).toBe(true);
  expect(ev.some((e) => e.kind === "tool.denied" && e.payload.input.command === "gh pr create --fill")).toBe(true);
});

test("A14 a session starts in the task with the workspace's Claude profile, and its events are saved", async () => {
  const s = await startSession(scripted([{ tool: "Read", input: { file_path: "README.md" } }, { text: "hello from the agent" }]));
  await idle(s.id);
  const ev = await events(s.id);
  const started = ev.find((e) => e.kind === "harness.started");
  expect(started.payload).toEqual(
    expect.objectContaining({
      harness: "claude",
      cwd: join(env.workspace, "tasks/PLEN-5"),
      env: expect.objectContaining({ CLAUDE_CONFIG_DIR: join(env.home, "profiles/composio/claude") }),
    }),
  );
  expect(ev.some((e) => e.kind === "message" && e.payload.text === "hello from the agent")).toBe(true);
  const seqs = ev.map((e) => e.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
});

test("A14 a chat runs with the model and effort picked in the composer, and keeps them", async () => {
  const s = await d.json<any>("/api/tasks/PLEN-5/sessions", { method: "POST", json: { prompt: scripted([{ text: "one" }]), model: "claude-sonnet-5-5", effort: "high" } });
  expect(s).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
  await idle(s.id);
  // The next message keeps them unless it asks for others; "default" goes back to the model's effort.
  await d.json(`/api/sessions/${s.id}/messages`, { method: "POST", json: { prompt: scripted([{ text: "two" }]) } });
  await idle(s.id);
  await d.json(`/api/sessions/${s.id}/messages`, { method: "POST", json: { prompt: scripted([{ text: "three" }]), model: "claude-haiku-5-5", effort: "default" } });
  await idle(s.id);
  const runs = (await events(s.id)).filter((e) => e.kind === "harness.started").map((e) => [e.payload.model, e.payload.effort]);
  expect(runs).toEqual([["claude-sonnet-5-5", "high"], ["claude-sonnet-5-5", "high"], ["claude-haiku-5-5", null]]);
  expect(await d.json<any>(`/api/sessions/${s.id}`)).toMatchObject({ model: "claude-haiku-5-5", effort: null });
  const bad = await d.api(`/api/sessions/${s.id}/messages`, { method: "POST", json: { prompt: "x", effort: "turbo" } });
  expect(bad.status).toBe(400);
  const list = await d.json<any>("/api/models");
  expect(list.models.map((m: { id: string }) => m.id)).toContain("claude-opus-5-5");
  expect(list.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
});

test("A15 events stream over a websocket and replay from a cursor without duplicates", async () => {
  const s = await startSession(scripted([{ text: "one" }, { text: "two" }, { text: "three" }]));
  await idle(s.id);
  const all = await events(s.id);
  const cursor = all[1].seq;
  const received: any[] = [];
  const ws = new WebSocket(`${d.url.replace("http", "ws")}/api/sessions/${s.id}/stream?after=${cursor}`, { headers: { authorization: `Bearer ${d.token}` } } as never);
  ws.onmessage = (m) => received.push(JSON.parse(String(m.data)));
  await until(() => received.length >= all.length - 2, 5_000, "replayed events");
  await Bun.sleep(300); // anything extra would be a duplicate
  ws.close();
  expect(received.map((e) => e.seq)).toEqual(all.slice(2).map((e) => e.seq));

  // Live: a follow-up message arrives on an open stream.
  const live: any[] = [];
  const ws2 = new WebSocket(`${d.url.replace("http", "ws")}/api/sessions/${s.id}/stream?after=${all.at(-1).seq}`, { headers: { authorization: `Bearer ${d.token}` } } as never);
  ws2.onmessage = (m) => live.push(JSON.parse(String(m.data)));
  await new Promise((r) => (ws2.onopen = r));
  await d.json(`/api/sessions/${s.id}/messages`, { method: "POST", json: { prompt: scripted([{ text: "four" }]) } });
  await until(() => live.some((e) => e.kind === "message" && e.payload.text === "four"), 5_000, "live event");
  ws2.close();
});

test("A16 a session resumes after the daemon restarts", async () => {
  const s = await startSession(scripted([{ text: "before restart" }]));
  await idle(s.id);
  const before = await d.json(`/api/sessions/${s.id}`);
  expect(before.harnessSessionId).toBeTruthy();
  const lastSeq = (await events(s.id)).at(-1).seq;

  await d.stop();
  d = await startDaemon(env);

  await d.json(`/api/sessions/${s.id}/messages`, { method: "POST", json: { prompt: scripted([{ text: "after restart" }]) } });
  await idle(s.id);
  const ev = await events(s.id, lastSeq);
  const restarted = ev.find((e) => e.kind === "harness.started");
  expect(restarted.payload.resume).toBe(before.harnessSessionId);
  expect(ev.some((e) => e.kind === "message" && e.payload.text === "after restart")).toBe(true);
  expect(ev.every((e) => e.seq > lastSeq)).toBe(true);
});
