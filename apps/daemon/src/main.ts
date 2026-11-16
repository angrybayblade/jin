import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createAdapter } from "./adapters";
import { jinTools } from "./chats";
import { loadConfig, loadWorkspaces } from "./config";
import { now, openDb } from "./db";
import { Feed, feedRoutes } from "./feed";
import { fileRoutes } from "./files";
import { claudeHarness } from "./harness";
import { Router } from "./http";
import { join } from "node:path";
import { coreRoutes, guard, handle, type App } from "./server";
import { Sessions, sessionRoutes, type StreamSocket } from "./sessions";
import { Tasks, taskRoutes } from "./tasks";
import { terminalHandlers, type TerminalSocket } from "./terminal";
import { Tickets } from "./tickets";

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
  tickets: new Tickets(),
  jobs: () => 0,
};
coreRoutes(app);

const adapters = new Map(app.workspaces.map((w) => [w.id, createAdapter(w)]));
const upsertWorkspace = db.query(
  "insert into workspaces (id, adapter, root, updated_at) values (?, ?, ?, ?) on conflict (id) do update set adapter = excluded.adapter, root = excluded.root, updated_at = excluded.updated_at",
);
for (const w of app.workspaces) upsertWorkspace.run(w.id, w.adapter, w.root, now());
const tasks = new Tasks(db, adapters);
const feed = new Feed(db);
taskRoutes(app.router, tasks, adapters);
feedRoutes(app.router, feed, tasks, app.workspaces);
fileRoutes(app.router, tasks);
const sessions = new Sessions({ db, config, tasks, adapters, workspaces: app.workspaces, harness: claudeHarness });
sessions.provideJinTools(() => jinTools({ feed, tasks, sessions, adapters, workspaces: app.workspaces }));
sessionRoutes(app.router, sessions, adapters);

const STREAM = /^\/api\/sessions\/([^/]+)\/stream$/;
type SocketData = StreamSocket["data"] | TerminalSocket["data"];
const isWebsocket = (req: Request) => req.headers.get("upgrade")?.toLowerCase() === "websocket";

const server = Bun.serve<SocketData>({
  hostname: HOST,
  port: config.port,
  fetch(req, srv) {
    const url = new URL(req.url);
    const stream = url.pathname.match(STREAM);
    if (stream && isWebsocket(req)) {
      const denied = guard(app, req, url);
      if (denied) return denied;
      const sessionId = decodeURIComponent(stream[1]!);
      try {
        sessions.get(sessionId);
      } catch {
        return Response.json({ error: "unknown session" }, { status: 404 });
      }
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      if (srv.upgrade(req, { data: { type: "stream", sessionId, after } })) return undefined;
      return Response.json({ error: "upgrade failed" }, { status: 400 });
    }
    if (url.pathname === "/api/terminal" && isWebsocket(req)) {
      const denied = guard(app, req, url);
      if (denied) return denied;
      const taskId = url.searchParams.get("task");
      let cwd: string;
      try {
        cwd = taskId ? tasks.get(taskId).root : (app.workspaces[0]?.root ?? config.home);
      } catch {
        return Response.json({ error: "unknown task" }, { status: 404 });
      }
      const cols = Number(url.searchParams.get("cols")) || 100;
      const rows = Number(url.searchParams.get("rows")) || 30;
      if (srv.upgrade(req, { data: { type: "terminal", cwd, cols, rows } })) return undefined;
      return Response.json({ error: "upgrade failed" }, { status: 400 });
    }
    return handle(app, req, url);
  },
  websocket: {
    open(ws) {
      if (ws.data.type === "terminal") terminalHandlers.open(ws as TerminalSocket);
      else sessions.subscribe(ws as StreamSocket);
    },
    message(ws, msg) {
      if (ws.data.type === "terminal") terminalHandlers.message(ws as TerminalSocket, msg);
    },
    close(ws) {
      if (ws.data.type === "terminal") terminalHandlers.close(ws as TerminalSocket);
      else sessions.unsubscribe(ws as StreamSocket);
    },
  },
});

const info = join(config.home, "daemon.json");
writeFileSync(info, JSON.stringify({ host: HOST, port: server.port, token: app.token, pid: process.pid }, null, 2), { mode: 0o600 });
chmodSync(info, 0o600);
console.log(`jin daemon on http://${HOST}:${server.port} (${config.mode} mode, model ${config.model})`);

function shutdown() {
  server.stop(true);
  db.close();
  rmSync(info, { force: true });
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
