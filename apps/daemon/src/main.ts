import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createAdapter } from "./adapters";
import { bobbyRoutes } from "./bobby";
import { jinTools } from "./chats";
import { loadConfig, loadWorkspaces } from "./config";
import { now, openDb } from "./db";
import { dropInheritedClaudeSession } from "./env";
import { collectGithub, Feed, feedRoutes, type FeedItem } from "./feed";
import { fileRoutes } from "./files";
import { Finder, finderRoutes } from "./finder";
import { jobRoutes, TaskJobs } from "./jobs";
import { reviewRoutes } from "./reviews";
import { linkRoutes, ownLinks, TaskLinks, watchRoutes, Watches } from "./links";
import { skillRoutes, Skills, tagsFor, writeTaskPlugin, type SkillBody } from "./skills";
import { localVersion, machineId, machineRoutes, Machines } from "./machines";
import { exportHistory, historyRoutes } from "./history";
import { LocalSetup, setupRoutes } from "./setup";
import { Desks, deskRoutes } from "./desks";
import { subtaskRoutes } from "./subtasks";
import { type FiredEvent, Hooks, hookRoutes } from "./hooks";
import { Composio, composioRoutes, type LiveEvent } from "./composio";
import { GithubWatch } from "./github-watch";
import { claudeHarness } from "./harness";
import { json, Router } from "./http";
import { join } from "node:path";
import { coreRoutes, guard, handle, type App } from "./server";
import { Sessions, sessionRoutes, type StreamSocket } from "./sessions";
import { Tasks, taskRoutes } from "./tasks";
import { claudeHookRoutes, claudeLaunch, writeClaudeSettings, writeJinTaskCommand } from "./claude-cli";
import { Journal, journalRoutes } from "./journal";
import { prRoutes, TaskPRs } from "./prs";
import { liveNotifies, Notifier, notifyRoutes, watchForNotifications } from "./notify";
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
  version: () => localVersion(),
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
// jin's skills: kept on the home, tagged; a task's Claude Code gets the ones its kind asks for
// (a review: pr-review) as a plugin, fetched from the home when this machine has one.
const skills = new Skills(config.home);
skillRoutes(app.router, skills);
const prepareSkills = async (taskId: string) => {
  const tags = tagsFor(tasks.get(taskId).kind);
  const home = homeLink();
  const list = home ? await machines.call<SkillBody[]>(home.id, "GET", `/api/skills/bundle?tags=${encodeURIComponent(tags.join(","))}`) : skills.bundle(tags);
  writeTaskPlugin(config.home, taskId, list);
};
terminalRoutes(app.router, { terminals, tasks, workspaces: app.workspaces, claude, prepare: prepareSkills });
const jobs = new TaskJobs({ terminals, tasks, workspaces: app.workspaces, claude, feed });
jobs.prepare = prepareSkills;
jobRoutes(app.router, jobs);
reviewRoutes(app.router, { tasks, jobs });
sessions.provideJinTools(() =>
  jinTools({
    feed, tasks, sessions, adapters, workspaces: app.workspaces, terminals, claude, jobs, prs, hooks, links: taskLinks,
    machines: { list: () => machines.list(), call: (id, method, path, payload) => machines.call(id, method, path, payload) },
  }),
);
// Desktop notifications when a turn or a setup finishes, or something needs you.
const notifier = new Notifier(config);
notifyRoutes(app.router, notifier);
const hooks = new Hooks(config.home, {
  startChat: async (title, prompt) => sessions.startChat("jin", prompt, undefined, title),
  notify: (n) => void notifier.notify(n),
});
hookRoutes(app.router, hooks);
const onClaudeStatus = watchForNotifications(notifier, { sessions, jobs, terminals });
// A task's work journal: Claude Code writes decisions, work and findings by concern (jin's
// `journal` MCP tool); the hooks add the files, commits and test runs they see.
const journal = new Journal(db, (terminalId) => {
  try {
    const t = terminals.get(terminalId);
    const root = t.taskId ? tasks.get(t.taskId).root : undefined;
    return { taskId: t.taskId, title: t.title, root };
  } catch {
    return null;
  }
});
journalRoutes(app.router, journal);
claudeHookRoutes(app.router, terminals, adapters, (terminalId) => {
  const taskId = terminalId ? terminals.list().find((t) => t.id === terminalId)?.taskId : undefined;
  return taskId ? tasks.get(taskId).workspace : app.workspaces[0]?.id;
}, onClaudeStatus, (terminalId, urls) => {
  // Claude Code created a PR in a task: attach it, whatever it does next.
  const taskId = terminals.get(terminalId).taskId;
  if (taskId) for (const url of urls) void prs.attach(taskId, url, "hook").catch(() => {});
}, journal);

// Pull requests attached to tasks; open ones are refreshed from GitHub every few minutes.
const prs = new TaskPRs(db);
prRoutes(app.router, prs, tasks, terminals);
// A task's Claude Code can split work into sub-tasks (jin-task spawn).
subtaskRoutes(app.router, { terminals, tasks, jobs, prs });
tasks.onRemoved((taskId) => prs.removeTask(taskId));
// A review task follows its PRs (attached once it is made); when they are all merged or closed,
// it is archived and, when nothing would be lost, removed.
jobs.onFinish((job) => {
  if (job.state !== "done") return;
  void (async () => {
    const t = tasks.get(job.taskId);
    if (t.kind !== "review") return;
    const repos = await tasks.adapter(t.workspace).repos();
    for (const p of t.prs) {
      const url = p.url ?? (repos.find((r) => r.name === p.repo)?.github ? `https://github.com/${repos.find((r) => r.name === p.repo)!.github}/pull/${p.number}` : null);
      if (url) await prs.attach(t.id, url, "review").catch(() => {});
    }
  })().catch((err) => console.error(`review ${job.taskId}: ${err}`));
});
prs.onEnded((taskId) => {
  void (async () => {
    const t = tasks.get(taskId);
    if (t.kind !== "review" || !prs.list(taskId).every((p) => p.state === "MERGED" || p.state === "CLOSED")) return;
    tasks.update(taskId, { archived: true });
    await tasks.removeIfClean(taskId).catch((err) => console.log(`review ${taskId} archived, kept: ${err instanceof Error ? err.message : err}`));
  })().catch(() => {});
});
// Every few minutes (and soon after start): find PRs opened from tasks' branches, refresh open ones.
const syncPrs = async () => {
  for (const t of tasks.list().filter((x) => x.state === "ready")) await prs.discover(t).catch(() => {});
  await prs.refreshOpen();
};
const prTimer = setInterval(() => void syncPrs(), 5 * 60_000);
setTimeout(() => void syncPrs(), 5_000);

// Remote machines over SSH: each runs its own jin daemon, reached through a tunnel.
const machines = new Machines(config, app.workspaces);
// Chats run with the first workspace's Claude profile (if it has one), so their transcripts are there.
const chatClaudeDir = () => app.workspaces[0]?.profile.claudeConfigDir;
machineRoutes(app.router, machines, () => exportHistory(db, { claudeDir: chatClaudeDir() }));

// Hooks: an event (a PR merged, a task's PRs all merged, a live event) starts a jin chat with
// the hook's instructions. They run where chats do: with a home, this machine sends its events
// there.
const homeLink = () => machines.list().find((m) => m.home && m.connected) ?? null;
const fireEvent = (ev: Omit<FiredEvent, "machine">) => {
  const home = homeLink();
  const sent = home
    ? machines.call(home.id, "POST", "/api/event-hooks/emit", { ...ev, machine: machines.identity?.id ?? null })
    : hooks.fire({ ...ev, machine: null });
  void sent.catch((err) => console.error(`hook event ${ev.event} ${ev.key}: ${err}`));
};
prs.onMerged((taskId, pr) => {
  const t = tasks.get(taskId);
  if (t.kind === "review") return; // someone else's PR: its merge is not this task's work done
  const task = { id: t.id, title: t.title ?? t.slug };
  fireEvent({ event: "pr.merged", key: pr.url, payload: { task, pr: { url: pr.url, repo: pr.repo, number: pr.number, title: pr.title } } });
  const all = prs.list(taskId);
  if (all.every((p) => p.state === "MERGED" || p.state === "CLOSED")) {
    fireEvent({ event: "task.merged", key: taskId, payload: { task, prs: all.map((p) => ({ url: p.url, repo: p.repo, number: p.number, title: p.title, state: p.state })) } });
  }
});
historyRoutes(app.router, db, { home: config.home, claudeDir: chatClaudeDir });
// What a machine's agents want you to know shows here, under its name; a click opens it there.
// With a home (hub), only the home is collected: it gathers its machines' notices itself, so
// nothing arrives twice. A hub does not collect from machines attached to it (they show their own).
machines.relayNotices((m, n) => {
  const records = machines.records();
  const hasHome = records.some((r) => r.home);
  if (m.attached || (hasHome && !m.home)) return;
  const fromHome = Boolean(m.home);
  notifier.notify({
    ...n,
    key: `${m.id}:${n.key}`,
    // The home already names the machine a notice came from, and links into it with /m/<machine>.
    subtitle: fromHome ? n.subtitle : [m.label, n.subtitle].filter(Boolean).join(" · "),
    // From the home, links stay as they are: chats, desks and the feed already open on the home,
    // and /m/<home> would switch this window to the hub's own tasks. Another machine's links go to it.
    path: fromHome || n.path.startsWith("/m/") ? n.path : `/m/${m.id}${n.path}`,
  });
});
// First-run setup for this machine; a workspace added there is live at once.
const setup = new LocalSetup(config, app.workspaces, (w) => {
  app.workspaces.push(w);
  adapters.set(w.id, createAdapter(w));
  upsertWorkspace.run(w.id, w.adapter, w.root, now());
});
setupRoutes(app.router, setup);
// Whether each desk's connection (gh, Claude's connectors) is there.
const desks = new Desks(config, app.workspaces);
deskRoutes(app.router, desks);
setTimeout(() => void desks.status().catch(() => {}), 8_000); // warm, so a desk page does not wait

// A cheap fingerprint of what the app shows (tasks, tabs, chats, approvals, setups, PRs, feed):
// the web app re-renders when it changes instead of on a timer.
app.router.on("GET", "/api/stamp", () => {
  const summary = JSON.stringify([
    tasks.list().map((t) => [t.id, t.state, t.title, t.archived]),
    [...terminals.list(), ...terminals.list({ archived: true })].map((t) => [t.id, t.status, t.title, t.archived, t.claudeSessionId]),
    sessions.list({}).map((x) => [x.id, x.state, x.title, x.lastEventAt]),
    sessions.approvals("pending").map((a) => a.id),
    jobs.list().map((j) => [j.id, j.state, j.log.length]),
    prs.list().map((p) => [p.url, p.state, p.checks, p.review, p.title, p.draft]),
    feed.list().map((f) => [f.id, f.state]),
    app.workspaces.map((w) => w.id),
  ]);
  return json({ stamp: Bun.hash(summary).toString(36) });
});

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

// How this jin introduces itself to a home (hub) it attaches to.
{
  const { hostname } = await import("node:os");
  const name = hostname().replace(/\.local$/, "");
  machines.identity = { id: machineId(name), label: name, port: server.port ?? config.port, token: app.token };
}
// Tunnels reopen once this jin knows itself (the one to a home carries the reverse line).
machines.resume();

// Live events through Composio (on the always-on home): the listener runs while any event is on.
// GitHub activity on your PRs is watched with gh here (one call every two minutes), not with triggers.
let liveDeliver: (e: LiveEvent) => void = () => {};
const githubWatch = new GithubWatch(config.home, (e) => liveDeliver(e));
// What tasks follow (links): on the home, the Slack threads and channels they watch.
const watches = new Watches(config.home);
watchRoutes(app.router, watches);
const taskLinks = new TaskLinks(db);
tasks.onRemoved((taskId) => taskLinks.removeTask(taskId));
const linksOf = (taskId: string) => {
  const t = tasks.get(taskId);
  return [...ownLinks(t, prs.list(taskId)), ...taskLinks.list(taskId)];
};
// This machine's tasks' Slack links go to the home, where events are read (or stay here).
const pushWatches = () => {
  const live = new Set(tasks.list().filter((t) => t.state === "ready" && !t.archived).map((t) => t.id));
  const keys = taskLinks.list().filter((l) => live.has(l.taskId)).map((l) => l.key);
  const home = homeLink();
  if (!home) return watches.set("local", keys);
  void machines.call(home.id, "PUT", "/api/feed/watches", { machine: machines.identity?.id ?? "local", keys }).catch(() => {});
};
linkRoutes(app.router, {
  links: taskLinks,
  linksOf,
  changed: pushWatches,
  context: {
    taskOf: (terminalId) => terminals.get(terminalId).taskId ?? null,
    task: (id) => tasks.get(id),
    prs: (taskId) => prs.list(taskId),
  },
  // Events are read on the home: a task's Activity comes from its feed.
  feedItems: async () => {
    const home = homeLink();
    return home ? machines.call<FeedItem[]>(home.id, "GET", "/api/feed") : feed.list();
  },
});
claude.linksOf = linksOf;
jobs.addLinks = (taskId, urls) => {
  const problems: string[] = [];
  for (const u of urls.map((x) => x.trim()).filter(Boolean)) {
    try {
      taskLinks.add(taskId, u);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  pushWatches();
  return problems;
};
setTimeout(pushWatches, 10_000);
const watchTimer = setInterval(pushWatches, 5 * 60_000);
const composio = new Composio(config, {
  feed,
  workspaces: app.workspaces,
  watched: (key, channel) => watches.watched(key, channel),
  notify: (n) => void notifier.notify(n),
  onEvent: (e) => fireEvent({ event: "live.event", key: e.id, payload: { ...e } }),
  shouldNotify: (e) => liveNotifies(notifier.settings, e),
  github: githubWatch,
});
liveDeliver = (e) => composio.deliver(e);
composioRoutes(app.router, composio);
composio.startListener();
composio.resumeNative();

// Always on (vm mode, e.g. the hub): the GitHub feed refreshes on its own every 10 minutes.
const feedTimer = config.mode === "vm" && !process.env.JIN_NO_TIMERS
  ? setInterval(() => void collectGithub(app.workspaces).then((items) => feed.add(items)).catch(() => {}), 10 * 60_000)
  : null;

function shutdown() {
  clearInterval(prTimer);
  clearInterval(watchTimer);
  if (feedTimer) clearInterval(feedTimer);
  machines.stopAll();
  composio.stopAll();
  githubWatch.stop();
  setup.stopAll();
  terminals.stopAll();
  server.stop(true);
  db.close();
  rmSync(info, { force: true });
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
