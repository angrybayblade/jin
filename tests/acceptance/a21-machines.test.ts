// A21: onboarding a machine over ssh, end to end, against a stand-in host. A fake `ssh` runs
// the remote side on this computer with its own HOME, and forwards -L ports itself; so the
// whole flow runs for real: tools check, jin copied with git archive, its daemon started
// and answering through the tunnel, notices relayed back, and forgetting it stops it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setupEnv, startDaemon, until, type Daemon, type Env as TestEnv } from "./helpers";

let env: TestEnv;
let d: Daemon;
let remoteHome: string;
const notices = () => (existsSync(join(env.home, "notifications.log")) ? readFileSync(join(env.home, "notifications.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const FAKE_SSH = `#!/usr/bin/env bun
// Stand-in ssh: options are skipped, -L is forwarded here, the command runs with the "remote" HOME.
const args = process.argv.slice(2);
let forward = null;
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-o") { i++; continue; }
  if (a === "-L") { forward = args[++i]; continue; }
  if (a === "-tt" || a === "-N") continue;
  rest.push(a);
}
const [host, ...command] = rest;
// A real ssh starts a fresh login: none of this jin's own variables reach the far side.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("JIN_")));
Object.assign(env, { HOME: process.env.FAKE_SSH_HOME, BUN_INSTALL_CACHE_DIR: process.env.REAL_BUN_CACHE });
if (forward) {
  const [, lport, , rport] = forward.split(":");
  Bun.listen({
    hostname: "127.0.0.1",
    port: Number(lport),
    socket: {
      async open(client) {
        client.data = { queue: [] };
        client.data.upstream = await Bun.connect({ hostname: "127.0.0.1", port: Number(rport), socket: {
          data(_s, chunk) { client.write(chunk); },
          close() { client.end(); },
          error() { client.end(); },
        } }).catch(() => (client.end(), null));
        for (const c of client.data.queue) client.data.upstream?.write(c);
      },
      data(client, chunk) { client.data.upstream ? client.data.upstream.write(chunk) : client.data.queue.push(chunk); },
      close(client) { client.data.upstream?.end(); },
    },
  });
  await new Promise(() => {});
}
if (!host) process.exit(255);
const proc = Bun.spawn(["bash", "-c", command.join(" ")], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await proc.exited);
`;

beforeAll(async () => {
  env = setupEnv();
  remoteHome = join(env.home, "..", "remote-home");
  mkdirSync(remoteHome, { recursive: true });
  // A composio workspace already on the machine, in a folder only its cws link leads to.
  const ws = join(remoteHome, "projects", "cw");
  mkdirSync(join(ws, "bin"), { recursive: true });
  mkdirSync(join(ws, "tasks"), { recursive: true });
  writeFileSync(join(ws, "workspace.yaml"), "repos:\n  platform:\n    description: Apollo\n    mode: work\n");
  writeFileSync(join(ws, ".gitmodules"), '[submodule "repos/platform"]\n\tpath = repos/platform\n\turl = https://github.com/ComposioHQ/platform.git\n');
  writeFileSync(join(ws, "bin", "cws"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(ws, "bin", "cws"), 0o755);
  mkdirSync(join(remoteHome, ".local", "bin"), { recursive: true });
  symlinkSync(join(ws, "bin", "cws"), join(remoteHome, ".local", "bin", "cws"));
  writeFileSync(join(env.bin, "ssh"), FAKE_SSH);
  chmodSync(join(env.bin, "ssh"), 0o755);
  d = await startDaemon(env, { FAKE_SSH_HOME: remoteHome, REAL_BUN_CACHE: process.env.BUN_INSTALL_CACHE_DIR ?? join(homedir(), ".bun", "install", "cache") });
});
afterAll(async () => {
  await d.stop();
  Bun.spawnSync(["pkill", "-f", join(remoteHome, ".jin/app/apps/daemon/src/main.ts")]);
  env.cleanup();
});

test("A21 a machine onboards over ssh, answers through its tunnel, relays its notices, and stops when forgotten", async () => {
  // A free port for the machine's daemon.
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const remotePort = probe.port;
  probe.stop(true);

  const added = await d.json("/api/machines", { method: "POST", json: { host: "stand-in.example", remotePort } });
  expect(added.id).toBe("stand-in");
  const m = await until(async () => {
    const v = await d.json("/api/machines/stand-in");
    return v.busy ? null : v;
  }, 180_000, "onboarding");
  const failed = m.steps.find((s: { state: string }) => s.state === "failed");
  expect(failed ? `${failed.label}: ${failed.error}\n${failed.log.join("\n")}` : null).toBeNull();
  expect(m.steps.map((s: { id: string }) => s.id)).toEqual(["connect", "tools", "jin", "daemon", "tunnel"]);
  expect(m).toMatchObject({ connected: true, tunnel: "up", outdated: false });

  // The machine's jin: its config allows this jin's web app, and it answers through the tunnel.
  expect(readFileSync(join(remoteHome, ".jin/config.yaml"), "utf8")).toContain("webOrigins: [");
  const record = JSON.parse(readFileSync(join(env.home, "machines/stand-in.json"), "utf8"));
  const remote = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${record.localPort}${path}`, { ...init, headers: { authorization: `Bearer ${record.token}` } });
  expect(await (await remote("/api/status")).json()).toMatchObject({ mode: "vm" });

  // A notice on the machine shows here under its name, opening it there.
  expect(await (await remote("/api/notifications/test", { method: "POST" })).json()).toMatchObject({ skipped: "kept for relay" });
  await until(() => notices().some((n) => n.subtitle?.startsWith("stand-in")), 15_000, "relayed notice");
  expect(notices().find((n) => n.subtitle?.startsWith("stand-in"))).toMatchObject({ path: "/m/stand-in/" });

  // The workspace already there is found, and using it gives the machine's jin that workspace.
  const ws = realpathSync(join(remoteHome, "projects", "cw"));
  const seen = await until(async () => {
    const v = await d.json("/api/machines/stand-in");
    return v.workspaceCandidates ? v : null;
  }, 20_000, "workspace detection");
  expect(seen.workspaceCandidates).toEqual([ws]);
  expect(seen.workspaceCws).toBe(ws);
  await d.json("/api/machines/stand-in/workspace", { method: "POST", json: { path: ws } });
  const used = await until(async () => {
    const v = await d.json("/api/machines/stand-in");
    return v.workspaceStep?.state !== "running" ? v : null;
  }, 30_000, "workspace setup");
  expect(used.workspaceStep.error).toBeNull();
  expect(used).toMatchObject({ workspace: ws, workspaceCandidates: [] });
  await until(async () => (await remote("/api/status").then((r) => r.json()).catch(() => null))?.workspaces?.includes("composio"), 20_000, "machine's jin with the workspace");

  // Forgetting it stops jin there and drops its record.
  expect(await d.json("/api/machines/stand-in", { method: "DELETE" })).toEqual({ removed: true });
  expect(existsSync(join(env.home, "machines/stand-in.json"))).toBe(false);
  await until(async () => !(await fetch(`http://127.0.0.1:${remotePort}/health`).then((r) => r.ok).catch(() => false)), 10_000, "machine's daemon stopped");
}, 240_000);
