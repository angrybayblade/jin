import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { setupEnv, startDaemon, WEB_ORIGIN, type Daemon, type Env } from "./helpers";

let env: Env;
let d: Daemon;
beforeAll(async () => {
  env = setupEnv();
  d = await startDaemon(env);
});
afterAll(async () => {
  await d?.stop();
  env?.cleanup();
});

test("A01 daemon starts, answers /health and listens on loopback only", async () => {
  expect(d.host).toBe("127.0.0.1");
  const res = await fetch(`${d.url}/health`);
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  // Not reachable on any non-loopback address of this machine.
  const external = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal);
  if (external) {
    const reached = await fetch(`http://${external.address}:${d.port}/health`, { signal: AbortSignal.timeout(2000) })
      .then(() => true)
      .catch(() => false);
    expect(reached).toBe(false);
  }
});

test("A02 API requires the local token and rejects foreign origins", async () => {
  expect((await d.api("/api/status", { noAuth: true })).status).toBe(401);
  expect((await d.api("/api/status", { headers: { authorization: "Bearer wrong" }, noAuth: true })).status).toBe(401);
  expect((await d.api("/api/status", { origin: "http://evil.example" })).status).toBe(403);
  expect((await d.api("/api/status", { origin: WEB_ORIGIN })).status).toBe(200);
  expect((await d.api("/api/status")).status).toBe(200);
  // Websocket upgrade without the token is refused.
  const ws = new WebSocket(`${d.url.replace("http", "ws")}/api/sessions/none/stream`);
  const outcome = await new Promise<string>((r) => {
    ws.onopen = () => r("open");
    ws.onerror = () => r("error");
    ws.onclose = () => r("closed");
  });
  expect(outcome).not.toBe("open");
  // The token never counts in a URL (it would end up in logs): only in the header.
  expect((await d.api(`/api/status?token=${d.token}`, { noAuth: true })).status).toBe(401);
});

test("A03 SQLite migrations create the v0 schema", () => {
  const db = new Database(join(env.home, "jin.db"), { readonly: true });
  const tables = db
    .query("select name from sqlite_master where type = 'table'")
    .all()
    .map((r: any) => r.name);
  for (const t of ["workspaces", "feed_items", "tasks", "sessions", "events", "approvals"]) expect(tables).toContain(t);
  expect((db.query("pragma user_version").get() as any).user_version).toBeGreaterThan(0);
  db.close();
});

test("A04 local mode registers no timers and refuses schedules", async () => {
  const status = await d.json("/api/status");
  expect(status.mode).toBe("local");
  expect(status.jobs).toBe(0);
  const res = await d.api("/api/schedules", { method: "POST", json: { cron: "30 8 * * 1-5", kind: "brief" } });
  expect(res.status).toBe(409);
  expect(await res.text()).toMatch(/vm/i);
});
