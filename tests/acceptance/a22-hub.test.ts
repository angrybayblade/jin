// A22: an always-on home (hub). This jin onboards a stand-in machine and makes it its home:
// what this jin held as home (its chats, the desk's files) moves there first, the line to the
// hub also carries a reverse port, this jin attaches itself there, the hub reaches it back, and
// the hub's own key can be fetched to add elsewhere. Stopping brings the home back here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  // The hub runs this working tree, as a development jin's machines do (the routes under test included).
  appendFileSync(join(env.home, "config.yaml"), "machines:\n  source: worktree\n");
  writeFileSync(join(env.home, "composio.json"), JSON.stringify({ userId: "u-test", events: {} }));
  writeFileSync(join(env.bin, "ssh"), FAKE_SSH);
  chmodSync(join(env.bin, "ssh"), 0o755);
  d = await startDaemon(env, { FAKE_SSH_HOME: hubHome, REAL_BUN_CACHE: process.env.BUN_INSTALL_CACHE_DIR ?? join(homedir(), ".bun", "install", "cache") });
});
afterAll(async () => {
  await d.stop();
  Bun.spawnSync(["pkill", "-f", join(hubHome, ".jin/app/apps/daemon/src/main.ts")]);
  env.cleanup();
});

test("A22 a machine becomes jin's home: what the home holds moves there, this jin attaches to it and is reached back; stopping brings it back", async () => {
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

  // Not signed in to Claude Code and gh there: chats and the desk could not run, so it is refused.
  const refused = await fetch(`${d.url}/api/machines/hub/home`, { method: "POST", headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" }, body: JSON.stringify({ home: true }) });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toContain("sign in to Claude Code and GitHub (gh) on hub first");
  // Signed in (stand-ins that answer only the status questions, ahead on the hub's PATH).
  const stubs = join(hubHome, ".local", "bin");
  mkdirSync(stubs, { recursive: true });
  const passOn = 'D=$(dirname "$0"); PATH=$(echo "$PATH" | tr ":" "\\n" | grep -vx "$D" | paste -sd: -); exec "$(basename "$0")" "$@"';
  writeFileSync(join(stubs, "gh"), `#!/bin/sh\nif [ "$1 $2" = "auth status" ]; then exit 0; fi\nif [ "$1 $2" = "api user" ]; then echo tester; exit 0; fi\n${passOn}\n`);
  writeFileSync(join(stubs, "claude"), `#!/bin/sh\nif [ "$1 $2" = "auth status" ]; then echo '{"loggedIn": true, "email": "t@example.com"}'; exit 0; fi\n${passOn}\n`);
  for (const f of ["gh", "claude"]) chmodSync(join(stubs, f), 0o755);

  // Home: this jin's chats and the desk's files move first, then the tunnel reopens with a reverse
  // line, and this jin attaches itself on the hub.
  const home = await d.json("/api/machines/hub/home", { method: "POST", json: { home: true } });
  expect(home).toMatchObject({ home: true, lastMove: { from: "this machine" } });
  expect(home.moved.sessions).toBeGreaterThanOrEqual(1);
  expect(readFileSync(join(hubHome, ".jin", "composio.json"), "utf8")).toContain("u-test");
  // This machine gave the home up: it no longer runs the desk, even after a restart.
  expect(existsSync(join(env.home, "not-home"))).toBe(true);
  const record = () => JSON.parse(readFileSync(join(env.home, "machines/hub.json"), "utf8"));
  const hub = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${record().localPort}${path}`, { ...init, headers: { authorization: `Bearer ${record().token}`, "content-type": "application/json" } }).then((r) => r.json());
  // It returns only once this jin is attached there: the app never switches to a home it cannot reach.
  const atOnce = (await hub("/api/machines")) as { id: string; attached?: boolean; connected: boolean }[];
  expect(atOnce.some((m) => m.attached)).toBe(true);
  const attached = await until(async () => {
    const list = (await hub("/api/machines").catch(() => [])) as { id: string; attached?: boolean; connected: boolean }[];
    return list.find((m) => m.attached && m.connected);
  }, 30_000, "this jin attached to the hub and reachable back");
  expect(attached.attached).toBe(true);

  // The same machine attaching again under a new name (its hostname changed) replaces its old record.
  const full = (await hub("/api/machines")).find((m: { id: string }) => m.id === attached.id) as { remotePort: number };
  const again = await hub("/api/machines/attach", { method: "POST", body: JSON.stringify({ id: "renamed-mac", label: "renamed-mac", port: full.remotePort, token: "t-renamed" }) });
  expect(again.id).toBe("renamed-mac");
  const afterRename = (await hub("/api/machines")) as { id: string; attached?: boolean }[];
  expect(afterRename.filter((m) => m.attached).map((m) => m.id)).toEqual(["renamed-mac"]);
  // Back as it was, for the rest of the test.
  await hub("/api/machines/attach", { method: "POST", body: JSON.stringify({ id: attached.id, label: attached.id, port: full.remotePort, token: d.token }) });

  // The hub works on this machine through the reverse line (its chat tools use the same path).
  const tasksHere = (await d.json("/api/tasks")) as { id: string }[];
  const hubChat = await hub("/api/chats", { method: "POST", body: JSON.stringify({ kind: "jin", prompt: JSON.stringify({ script: [{ jinTool: "jin_list_tasks", input: { machine: attached.id } }, { text: "ok" }] }) }) });
  await until(async () => (await hub(`/api/sessions/${hubChat.id}`)).state === "idle", 15_000, "hub chat turn");
  const events = (await hub(`/api/sessions/${hubChat.id}/events`)) as { kind: string; payload: { tool?: string; output?: { id?: string; error?: string }[] } }[];
  const listed = events.find((e) => e.kind === "tool.result" && e.payload.tool === "mcp__jin__jin_list_tasks")?.payload.output ?? [];
  expect(listed.filter((t) => t.error)).toEqual([]);
  expect(listed.map((t) => t.id).sort()).toEqual(tasksHere.map((t) => t.id).sort());

  // This machine's chat is on the hub now; chats and the feed come from the home.
  const onHub = (await hub("/api/sessions?kind=jin")) as { id: string; harnessSessionId: string | null }[];
  expect(onHub.find((s) => s.id === chat.id)).toMatchObject({ harnessSessionId: null });
  // The hub can be asked to reach this jin's other machines (there are none here).
  expect(await d.json("/api/machines/hub/move", { method: "POST" })).toEqual({ machines: [] });

  // The hub's own key, made on the hub, for adding to the other machines.
  const key = await d.json("/api/machines/hub/hub-key", { method: "POST" });
  expect(key.publicKey).toMatch(/^ssh-ed25519 /);
  expect(readFileSync(join(hubHome, ".ssh/id_ed25519.pub"), "utf8").trim()).toBe(key.publicKey);

  // Stopping: the home comes back here, with the chat started on the hub, and the hub gives it up.
  await d.json("/api/machines/hub/home", { method: "POST", json: { home: false } });
  const here = (await d.json("/api/sessions?kind=jin")) as { id: string }[];
  expect(here.map((s) => s.id)).toContain(hubChat.id);
  expect(existsSync(join(env.home, "not-home"))).toBe(false);
  expect(existsSync(join(hubHome, ".jin", "not-home"))).toBe(true);
}, 240_000);
