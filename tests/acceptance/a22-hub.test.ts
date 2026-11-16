// A22: an always-on home (hub). This jin onboards a stand-in machine and makes it its home:
// the line to the hub also carries a reverse port, this jin attaches itself there, the hub
// reaches it back, its chats move over, and the hub's own key can be fetched to add elsewhere.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FAKE_SSH, scripted, setupEnv, startDaemon, until, type Daemon, type Env as TestEnv } from "./helpers";

let env: TestEnv;
let d: Daemon;
let hubHome: string;

beforeAll(async () => {
  env = setupEnv();
  hubHome = join(env.home, "..", "hub-home");
  mkdirSync(hubHome, { recursive: true });
  writeFileSync(join(env.bin, "ssh"), FAKE_SSH);
  chmodSync(join(env.bin, "ssh"), 0o755);
  d = await startDaemon(env, { FAKE_SSH_HOME: hubHome, REAL_BUN_CACHE: process.env.BUN_INSTALL_CACHE_DIR ?? join(homedir(), ".bun", "install", "cache") });
});
afterAll(async () => {
  await d.stop();
  Bun.spawnSync(["pkill", "-f", join(hubHome, ".jin/app/apps/daemon/src/main.ts")]);
  env.cleanup();
});

test("A22 a machine becomes jin's home: this jin attaches to it, is reached back, and moves its chats there", async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const remotePort = probe.port;
  probe.stop(true);

  await d.json("/api/machines", { method: "POST", json: { host: "hub.example", remotePort } });
  const ready = await until(async () => {
    const v = await d.json("/api/machines/hub");
    return v.busy ? null : v;
  }, 180_000, "onboarding the hub");
  expect(ready.steps.filter((s: { state: string }) => s.state !== "done")).toEqual([]);

  // A chat on this machine, to move.
  const chat = await d.json("/api/chats", { method: "POST", json: { kind: "jin", prompt: scripted([{ text: "moved with me" }]) } });
  await until(async () => (await d.json(`/api/sessions/${chat.id}`)).state === "idle", 15_000, "chat turn");

  // Home: the tunnel reopens with a reverse line, and this jin attaches itself on the hub.
  const home = await d.json("/api/machines/hub/home", { method: "POST", json: { home: true } });
  expect(home).toMatchObject({ home: true });
  const record = () => JSON.parse(readFileSync(join(env.home, "machines/hub.json"), "utf8"));
  const hub = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${record().localPort}${path}`, { ...init, headers: { authorization: `Bearer ${record().token}`, "content-type": "application/json" } }).then((r) => r.json());
  const attached = await until(async () => {
    const list = (await hub("/api/machines").catch(() => [])) as { id: string; attached?: boolean; connected: boolean }[];
    return list.find((m) => m.attached && m.connected);
  }, 30_000, "this jin attached to the hub and reachable back");
  expect(attached.attached).toBe(true);

  // The hub works on this machine through the reverse line (its chat tools use the same path).
  const tasksHere = (await d.json("/api/tasks")) as { id: string }[];
  const hubChat = await hub("/api/chats", { method: "POST", body: JSON.stringify({ kind: "jin", prompt: JSON.stringify({ script: [{ jinTool: "jin_list_tasks", input: { machine: attached.id } }, { text: "ok" }] }) }) });
  await until(async () => (await hub(`/api/sessions/${hubChat.id}`)).state === "idle", 15_000, "hub chat turn");
  const events = (await hub(`/api/sessions/${hubChat.id}/events`)) as { kind: string; payload: { tool?: string; output?: { id?: string; error?: string }[] } }[];
  const listed = events.find((e) => e.kind === "tool.result" && e.payload.tool === "mcp__jin__jin_list_tasks")?.payload.output ?? [];
  expect(listed.filter((t) => t.error)).toEqual([]);
  expect(listed.map((t) => t.id).sort()).toEqual(tasksHere.map((t) => t.id).sort());

  // Moving: this machine's chats are on the hub now; chats and the feed come from the home.
  const moved = await d.json("/api/machines/hub/move", { method: "POST" });
  expect(moved.history.sessions).toBeGreaterThanOrEqual(1);
  const onHub = (await hub("/api/sessions?kind=jin")) as { id: string; harnessSessionId: string | null }[];
  expect(onHub.find((s) => s.id === chat.id)).toMatchObject({ harnessSessionId: null });

  // The hub's own key, made on the hub, for adding to the other machines.
  const key = await d.json("/api/machines/hub/hub-key", { method: "POST" });
  expect(key.publicKey).toMatch(/^ssh-ed25519 /);
  expect(readFileSync(join(hubHome, ".ssh/id_ed25519.pub"), "utf8").trim()).toBe(key.publicKey);
}, 240_000);
