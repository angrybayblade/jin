import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createAdapter } from "./adapters";
import { bobbyRoutes } from "./bobby";
import { jinTools } from "./chats";
import { loadConfig, loadWorkspaces } from "./config";
import { now, openDb } from "./db";
import { dropInheritedClaudeSession } from "./env";
import { Feed, feedRoutes } from "./feed";
import { fileRoutes } from "./files";
import { Finder, finderRoutes } from "./finder";
import { jobRoutes, TaskJobs } from "./jobs";
import { machineRoutes, Machines } from "./machines";
import { claudeHarness } from "./harness";
import { Router } from "./http";
import { join } from "node:path";
import { coreRoutes, guard, handle, type App } from "./server";
import { Sessions, sessionRoutes, type StreamSocket } from "./sessions";
import { Tasks, taskRoutes } from "./tasks";
import { claudeHookRoutes, claudeLaunch, writeClaudeSettings, writeJinTaskCommand } from "./claude-cli";
import { prRoutes, TaskPRs } from "./prs";
import { Notifier, notifyRoutes, watchForNotifications } from "./notify";
import { Terminals, terminalRoutes, type AttachSocket } from "./terminals";
import { Tickets } from "./tickets";

const HOST = "127.0.0.1"; // never a public interface; reach a VM over SSH or Tailscale

function loadToken(home: string): string {
  const file = join(home, "token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

// Started from inside Claude Code? Its session variables must not reach the agents jin runs.
const dropped = dropInheritedClaudeSession();
if (dropped.length) console.log(`ignoring ${dropped.length} inherited Claude Code session variables`);

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
finderRoutes(app.router, new Finder(tasks));
bobbyRoutes(app.router);
const sessions = new Sessions({ db, config, tasks, adapters, workspaces: app.workspaces, harness: claudeHarness });
sessionRoutes(app.router, sessions, adapters);
const terminals = new Terminals(db);
const claude = claudeLaunch(config, writeClaudeSettings(config), writeJinTaskCommand(config));
// A removed task's terminals close with it.
tasks.onRemoved((taskId) => {
  for (const t of [...terminals.list({ taskId }), ...terminals.list({ taskId, archived: true })]) terminals.close(t.id);
});
terminalRoutes(app.router, { terminals, tasks, workspaces: app.workspaces, claude });
const jobs = new TaskJobs({ terminals, tasks, workspaces: app.workspaces, claude, feed });
jobRoutes(app.router, jobs);
sessions.provideJinTools(() => jinTools({ feed, tasks, sessions, adapters, workspaces: app.workspaces, terminals, claude, jobs, prs }));
// Desktop notifications when a turn or a setup finishes, or something needs you.
const notifier = new Notifier(config);
notifyRoutes(app.router, notifier);
const onClaudeStatus = watchForNotifications(notifier, { sessions, jobs, terminals });
claudeHookRoutes(app.router, terminals, adapters, (terminalId) => {
  const taskId = terminalId ? terminals.list().find((t) => t.id === terminalId)?.taskId : undefined;
  return taskId ? tasks.get(taskId).workspace : app.workspaces[0]?.id;
}, onClaudeStatus, (terminalId, urls) => {
  // Claude Code created a PR in a task: attach it, whatever it does next.
  const taskId = terminals.get(terminalId).taskId;
  if (taskId) for (const url of urls) void prs.attach(taskId, url, "hook").catch(() => {});
});

// Pull requests attached to tasks; open ones are refreshed from GitHub every few minutes.
const prs = new TaskPRs(db);
prRoutes(app.router, prs, tasks, terminals);
tasks.onRemoved((taskId) => prs.removeTask(taskId));
// Every few minutes (and soon after start): find PRs opened from tasks' branches, refresh open ones.
const syncPrs = async () => {
  for (const t of tasks.list().filter((x) => x.state === "ready")) await prs.discover(t).catch(() => {});
  await prs.refreshOpen();
};
const prTimer = setInterval(() => void syncPrs(), 5 * 60_000);
setTimeout(() => void syncPrs(), 5_000);

// Remote machines over SSH: each runs its own jin daemon, reached through a tunnel.
const machines = new Machines(config, app.workspaces);
machineRoutes(app.router, machines);
machines.resume();

const STREAM = /^\/api\/sessions\/([^/]+)\/stream$/;
type SocketData = StreamSocket["data"] | AttachSocket["data"];
const ATTACH = /^\/api\/terminals\/([^/]+)\/attach$/;
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
    const attach = url.pathname.match(ATTACH);
    if (attach && isWebsocket(req)) {
      const denied = guard(app, req, url);
      if (denied) return denied;
      const terminalId = decodeURIComponent(attach[1]!);
      if (!terminals.isLive(terminalId)) return Response.json({ error: "terminal is not running" }, { status: 404 });
      if (srv.upgrade(req, { data: { type: "attach", terminalId } })) return undefined;
      return Response.json({ error: "upgrade failed" }, { status: 400 });
    }
    return handle(app, req, url);
  },
  websocket: {
    open(ws) {
      if (ws.data.type === "attach") terminals.attach(ws as AttachSocket);
      else sessions.subscribe(ws as StreamSocket);
    },
    message(ws, msg) {
      if (ws.data.type === "attach") terminals.message(ws as AttachSocket, msg);
    },
    close(ws) {
      if (ws.data.type === "attach") terminals.detach(ws as AttachSocket);
      else sessions.unsubscribe(ws as StreamSocket);
    },
  },
});

const info = join(config.home, "daemon.json");
writeFileSync(info, JSON.stringify({ host: HOST, port: server.port, token: app.token, pid: process.pid }, null, 2), { mode: 0o600 });
chmodSync(info, 0o600);
console.log(`jin daemon on http://${HOST}:${server.port} (${config.mode} mode, model ${config.model})`);

function shutdown() {
  clearInterval(prTimer);
  machines.stopAll();
  terminals.stopAll();
  server.stop(true);
  db.close();
  rmSync(info, { force: true });
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
