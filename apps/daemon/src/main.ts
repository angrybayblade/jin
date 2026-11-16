import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadWorkspaces } from "./config";
import { createAdapter } from "./adapters";
import { now, openDb } from "./db";
import { Feed, feedRoutes } from "./feed";
import { claudeHarness } from "./harness";
import { Sessions, sessionRoutes, type StreamSocket } from "./sessions";
import { Router } from "./http";
import { coreRoutes, guard, handle, type App } from "./server";
import { Tasks, taskRoutes } from "./tasks";

const HOST = "127.0.0.1"; // never a public interface; reach a VM over SSH or Tailscale

function loadToken(home: string): string {
  const file = join(home, "token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

const config = loadConfig();
const db = openDb(config.home);
const app: App = {
  config,
  db,
  token: loadToken(config.home),
  workspaces: loadWorkspaces(config.home),
  router: new Router(),
  jobs: () => 0,
};
coreRoutes(app);

const adapters = new Map(app.workspaces.map((w) => [w.id, createAdapter(w)]));
const upsertWorkspace = db.query(
  "insert into workspaces (id, adapter, root, updated_at) values (?, ?, ?, ?) on conflict (id) do update set adapter = excluded.adapter, root = excluded.root, updated_at = excluded.updated_at",
);
for (const w of app.workspaces) upsertWorkspace.run(w.id, w.adapter, w.root, now());
const tasks = new Tasks(db, adapters);
taskRoutes(app.router, tasks, adapters);
feedRoutes(app.router, new Feed(db), tasks, app.workspaces);
const sessions = new Sessions(db, tasks, adapters, app.workspaces, claudeHarness);
sessionRoutes(app.router, sessions, adapters);

const STREAM = /^\/api\/sessions\/([^/]+)\/stream$/;

const server = Bun.serve<{ sessionId: string; after: number }>({
  hostname: HOST,
  port: config.port,
  fetch(req, srv) {
    const url = new URL(req.url);
    const stream = url.pathname.match(STREAM);
    if (stream && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const denied = guard(app, req, url);
      if (denied) return denied;
      const sessionId = decodeURIComponent(stream[1]!);
      try {
        sessions.get(sessionId);
      } catch {
        return Response.json({ error: "unknown session" }, { status: 404 });
      }
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      if (srv.upgrade(req, { data: { sessionId, after } })) return undefined;
      return Response.json({ error: "upgrade failed" }, { status: 400 });
    }
    return handle(app, req, url);
  },
  websocket: {
    open: (ws) => sessions.subscribe(ws as StreamSocket),
    close: (ws) => sessions.unsubscribe(ws as StreamSocket),
    message: () => {},
  },
});

const info = join(config.home, "daemon.json");
writeFileSync(info, JSON.stringify({ host: HOST, port: server.port, token: app.token, pid: process.pid }, null, 2), { mode: 0o600 });
chmodSync(info, 0o600);
console.log(`jin daemon on http://${HOST}:${server.port} (${config.mode} mode)`);

function shutdown() {
  server.stop(true);
  db.close();
  rmSync(info, { force: true });
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
