import { protectJinHome } from "./policy";
import { randomUUID } from "node:crypto";
import { DOC_ID, DocAsk, docChatNote, docRoutes, Docs, docTools } from "./docs";
import { roomRoutes, Rooms } from "./rooms";
import { type IssueDetails, Trackers, trackerView, type IssueTracker } from "./trackers";
import { problemRoutes, problems } from "./problems";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createAdapter, provider } from "./adapters";
import { haikuTitle, scriptedTitle } from "./titles";
import { type MachineSnapshot, Mentions, mentionRoutes } from "./mentions";
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
import { linkRoutes, ownLinks, type TaskLink, TaskLinks, watchRoutes, Watches } from "./links";
import { skillRoutes, Skills, tagsFor, writeTaskPlugin, type SkillBody } from "./skills";
import { localVersion, machineId, machineRoutes, Machines } from "./machines";
import { forwardRoutes, Forwards } from "./forwards";
import { historyRoutes } from "./history";
import { exportHome, gaveUpHome, type HomeBundle, importHome, setNotHome } from "./home-move";
import { LocalSetup, setupRoutes } from "./setup";
import { Desks, deskRoutes } from "./desks";
import { subtaskRoutes } from "./subtasks";
import { type FiredEvent, Hooks, hookRoutes } from "./hooks";
import { ClaudeSettings, claudeSettingsRoutes } from "./claude-settings";
import { harnessSettings, harnessSettingsRoutes } from "./harness-settings";
import { ChatSkills, chatSkillRoutes } from "./chat-skills";
import { Composio, composioRoutes, type LiveEvent } from "./composio";
import { NotionSync, notionSyncRoutes } from "./notion-sync";
import { GithubWatch } from "./github-watch";
import { claudeHarness, type Harness } from "./harness";
import { CodexHarness } from "./harness/codex";
import { PiHarness } from "./harness/pi";
import { OpencodeHarness } from "./harness/opencode";
import { opencodeLaunch } from "./opencode-cli";
import { piLaunch } from "./pi-cli";
import { AgentTools, agentToolRoutes } from "./agent-tools";
import { body, HttpError, json, Router } from "./http";
import { viewRoutes } from "./views";
import { join } from "node:path";
import { coreRoutes, guard, handle, type App } from "./server";
import { Sessions, sessionRoutes, type StreamSocket } from "./sessions";
import { Tasks, taskRoutes } from "./tasks";
import { claudeLaunch, writeClaudeSettings, writeJinTaskCommand } from "./claude-cli";
import { codexLaunch } from "./codex-cli";
import { agentHookRoutes } from "./agent-hooks";
import { Agents, agentRoutes } from "./agents";
import { Journal, type JournalEntry, journalRoutes, memoryText } from "./journal";
import { SlackThreads } from "./involvement";
import { haikuClassify, haikuJudge, scriptedClassify, scriptedJudge, SlackReads, StaleChecker, Triager } from "./triage";
import { candidatesFor, haikuChooser, PreContext, preContextRoutes, scriptedChooser } from "./precontext";
import { prRoutes, rollup, TaskPRs } from "./prs";
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
// Agents never reach jin's own credentials, database or SSH keys (policy.ts).
protectJinHome(config.home);
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
// Issue trackers: how each reaches its issues is wired below (Linear through Composio, GitHub through gh).
let lookupLinear: ((id: string) => Promise<IssueDetails | null>) | undefined;
const trackers = new Trackers({
  linear: (id) => lookupLinear?.(id) ?? Promise.resolve(null),
  github: async (id) => {
    const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(id);
    if (!m) return null;
    const p = Bun.spawn(["gh", "issue", "view", m[2]!, "-R", m[1]!, "--json", "title,url,state,assignees"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return null;
    const d = JSON.parse(out) as { title: string; url: string; state: string; assignees?: { login: string }[] };
    return { title: d.title, url: d.url, state: d.state.toLowerCase(), assignee: d.assignees?.[0]?.login ?? null, team: m[1]! };
  },
  owners: () => app.workspaces.flatMap((w) => w.github.owners),
});
/** A workspace's tracker (null: its tasks have no issues). */
const trackerOf = (workspace: string) => trackers.get(app.workspaces.find((w) => w.id === workspace)?.tracker);
const tasks = new Tasks(db, adapters, (workspace, t) => {
  // A change task named after its issue (the provider says its workspaces do): that issue, in the workspace's tracker.
  const w = app.workspaces.find((x) => x.id === workspace);
  const tracker = trackerOf(workspace);
  if (!w || !tracker || (t.kind ?? "change") !== "change" || !provider(w.adapter).taskIdIsIssue) return null;
  const id = tracker.parseId(t.id);
  return id ? { tracker: tracker.id, id, url: tracker.urlOf(id) } : null;
});
const feed = new Feed(db);
taskRoutes(app.router, tasks, adapters, (w) => trackerOf(w));
feedRoutes(app.router, feed, tasks, app.workspaces, (i) => {
  const owner = watches.ownerOf(i.thread?.key, i.meta?.channel);
  const hint = !owner && i.triage?.taskHint ? (watches.tasks().find((t) => t.taskId === i.triage!.taskHint) ?? null) : null;
  return { owner, hint };
});
fileRoutes(app.router, tasks);
finderRoutes(app.router, new Finder(tasks));
bobbyRoutes(app.router);
// @mentions in chats: every machine's tasks, PRs (gh) and Linear issues (Composio); set up below.
let mentions: Mentions | null = null;
// New chats are named by Claude Haiku (a stand-in under the scripted harness, in tests).
// jin docs (on the home, next to the chats): each doc has its own chat with jin.
const docs = new Docs(db);
// A task's agent room (set up below, once sessions exist): its agents are sessions with a role.
let rooms: Rooms | null = null;
// jin's tools for Codex runs, served to them through an MCP bridge (agent-tools.ts).
const agentTools = new AgentTools();
agentToolRoutes(app.router, agentTools);
const codexHarness = new CodexHarness({ home: config.home, tools: agentTools });
// A chat on pi or opencode checks, as a tab does, that this machine's version is one jin has checked.
const piHarness = new PiHarness({ home: config.home, tools: agentTools, ensure: () => agents.pick("pi") });
const opencodeHarness = new OpencodeHarness({ home: config.home, tools: agentTools, ensure: () => agents.pick("opencode") });
// Chats and room agents run on Claude through the Agent SDK; on a machine whose agent is Codex,
// the work in a task (its chats, its room agents) runs on Codex. A resumed session keeps its own.
// jin's chat, desks and doc chats stay on Claude: they work through claude.ai's connectors.
const harnessFor = ({ kind, id }: { kind: string; id?: string }): Harness => {
  if (process.env.JIN_HARNESS === "scripted") return claudeHarness();
  const which = id ?? (kind === "task" || kind === "room" ? agents.defaultId() : "claude");
  return which === "codex" ? codexHarness : which === "pi" ? piHarness : which === "opencode" ? opencodeHarness : claudeHarness();
};
const sessions = new Sessions({ db, config, tasks, adapters, workspaces: app.workspaces, harness: harnessFor, titler: process.env.JIN_HARNESS === "scripted" ? scriptedTitle : haikuTitle, mentions: (text) => mentions?.resolve(text) ?? Promise.resolve([]),
  // The scripted harness (tests) has no Claude Code to ask.
  chatSkills: new ChatSkills(process.env.JIN_HARNESS === "scripted" ? async () => [] : undefined),
  kindTools: (s) => (s.kind === "room" ? (rooms?.toolsFor(s) ?? []) : s.kind === "jin" || s.kind === "desk" || s.kind === "doc" ? docTools(docs) : []),
  toolBlock: (s, tool, input) => rooms?.blocked(s, tool, input) ?? null,
  chatNote: (s) => {
    if (s.kind === "room") return rooms?.noteFor(s);
    if (s.kind !== "doc") return undefined;
    const d = docs.byChat(s.id);
    return d ? docChatNote(d) : undefined;
  } });
sessionRoutes(app.router, sessions, adapters);
problemRoutes(app.router);
rooms = new Rooms({
  db,
  sessions,
  tasks,
  // Docs live on the home: from another machine an agent's doc tools run there.
  docTools: (by) =>
    docTools(docs, by).map((t) => ({
      ...t,
      run: (args: Record<string, unknown>) => {
        const home = homeLink();
        return home ? machines.call<unknown>(home.id, "POST", `/api/doc-tools/${t.name}?by=${encodeURIComponent(by)}`, args) : t.run(args);
      },
    })),
  linkDoc: (taskId, docId) => retitle([taskLinks.add(taskId, `doc:${docId}`)]),
  // A doc the user tags: from the home when there is one (docs live there).
  docInfo: async (id) => {
    const home = homeLink();
    try {
      return home ? await machines.call<{ title: string; body: string }>(home.id, "GET", `/api/docs/${encodeURIComponent(id)}`) : docs.get(id);
    } catch {
      return null;
    }
  },
  mentions: (text) => mentions?.resolve(text) ?? Promise.resolve([]),
  // The task's journal, shared with its terminal tabs (made further down; reached when a turn runs).
  journal: { write: (taskId, by, e) => journal.write(taskId, by, e), contextText: (taskId) => journal.contextText(taskId) },
  memorySearch: async (taskId, query) => memoryText(await longTermSearch(tasks.get(taskId).workspace, query)),
  preContext: (taskId) => preContextText(taskId),
});
roomRoutes(app.router, rooms);
tasks.onRemoved((taskId) => rooms?.removeTask(taskId));
const docAsk = new DocAsk(docs, {
  start: (d, prompt, choice) => {
    // The doc names its chat before the chat starts, so the chat's first run knows its doc.
    const id = randomUUID();
    docs.setChat(d.id, id);
    return sessions.startChat("doc", prompt, undefined, d.title, choice, id).id;
  },
  send: (chatId, prompt, choice) => {
    try {
      sessions.get(chatId);
    } catch {
      return false;
    }
    sessions.send(chatId, prompt, choice);
    return true;
  },
  busy: (chatId) => {
    try {
      const s = sessions.get(chatId).state;
      return s === "running" || s === "waiting_approval";
    } catch {
      return false;
    }
  },
});
// A deleted doc's chat is archived with it (its history stays, out of the way).
docRoutes(app.router, docs, docAsk, (chatId) => {
  try {
    sessions.update(chatId, { archived: true });
  } catch {
    // already gone
  }
});
chatSkillRoutes(app.router, (kind) => sessions.chatPlace(kind), sessions.chatSkills);
const terminals = new Terminals(db);
const jinTaskBin = writeJinTaskCommand(config);
// The coding agents a tab can run, and this machine's default (Settings, or the machine's card).
const launches = { claude: claudeLaunch(config, writeClaudeSettings(config), jinTaskBin), codex: codexLaunch(config, jinTaskBin), pi: piLaunch(config, jinTaskBin), opencode: opencodeLaunch(config, jinTaskBin) };
const agents = new Agents(db, launches);
agentRoutes(app.router, agents);
// A removed task's terminals close with it.
tasks.onRemoved((taskId) => {
  for (const t of [...terminals.list({ taskId }), ...terminals.list({ taskId, archived: true })]) terminals.close(t.id);
});
// jin's skills: kept on the home, tagged; a task's Claude Code gets the ones its kind asks for
// (a review: pr-review) as a plugin, fetched from the home when this machine has one.
const skills = new Skills(config.home);
skillRoutes(app.router, skills);
claudeSettingsRoutes(app.router, new ClaudeSettings());
harnessSettingsRoutes(app.router, harnessSettings());
const prepareSkills = async (taskId: string) => {
  const tags = tagsFor(tasks.get(taskId).kind);
  const home = homeLink();
  const list = home ? await machines.call<SkillBody[]>(home.id, "GET", `/api/skills/bundle?tags=${encodeURIComponent(tags.join(","))}`) : skills.bundle(tags);
  writeTaskPlugin(config.home, taskId, list);
};
// Before an agent starts in a task: its skills, and its pre-context (picked now if it has not been;
// a few seconds at most), so its starting instructions carry what earlier tasks kept.
const prepareAgent = async (taskId: string) => {
  await prepareSkills(taskId);
  await Promise.race([preContext.ensure(taskId).then(() => preContext.text(taskId)), Bun.sleep(8_000)]).catch(() => {});
};
terminalRoutes(app.router, { terminals, tasks, workspaces: app.workspaces, agents, prepare: prepareAgent });
const jobs = new TaskJobs({ terminals, tasks, workspaces: app.workspaces, agents, prepare: prepareAgent, feed, db });
// A task that starts in its agent room: its first prompt is said there.
jobs.roomPost = (taskId, text) => void rooms?.post(taskId, text);
jobRoutes(app.router, jobs);
reviewRoutes(app.router, { tasks, jobs });
sessions.provideJinTools(() =>
  jinTools({
    feed, tasks, sessions, adapters, workspaces: app.workspaces, terminals, agents, jobs, prs, hooks, links: taskLinks,
    // Defined further down; read when a chat runs.
    journal: () => journal, linksOf: (id) => linksOf(id), notify: (n) => void notifier.notify(n), recordsOf: (id) => recordsOf(id),
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
// What one page shows, in one call (each call to the home is a round trip through its tunnel).
viewRoutes(app.router);
// Wrap up, asked from a machine whose task it is: the home's jin keeps what the task learned.
app.router.on("POST", "/api/memory/wrap-up", async (req) => {
  const b = (await req.json().catch(() => ({}))) as { task?: { id: string; title: string | null }; machine?: string | null };
  if (!b.task?.id) throw new HttpError(400, "a task is required");
  return json(await hooks.wrapUp({ task: b.task, machine: b.machine ?? null }), 202);
});
const onClaudeStatus = watchForNotifications(notifier, { sessions, jobs, terminals });
// A task's work journal: Claude Code writes decisions, work and findings by concern (jin's
// `journal` MCP tool); the hooks add the files, commits and test runs they see.
/** Long-term memory of a workspace: the home holds everyone's (this machine's own when there is no home). */
async function longTermSearch(workspace: string | null, query: string): Promise<JournalEntry[]> {
  const home = homeLink();
  if (home) return machines.call<JournalEntry[]>(home.id, "GET", `/api/memory/search?q=${encodeURIComponent(query)}&workspace=${encodeURIComponent(workspace ?? "")}`);
  return journal.search(query, { workspace: workspace ?? undefined, level: "global" });
}
const journal = new Journal(db, (terminalId) => {
  try {
    const t = terminals.get(terminalId);
    const root = t.taskId ? tasks.get(t.taskId).root : undefined;
    // The workspace's own check commands count as test runs too.
    const checks = t.taskId ? tasks.adapter(tasks.get(t.taskId).workspace).checkCommands?.() : undefined;
    return { taskId: t.taskId, title: t.title, root, checks };
  } catch {
    return null;
  }
}, {
  // A row belongs to its task's workspace (long-term memory is scoped by workspace).
  workspaceOf: (taskId) => {
    try {
      return tasks.get(taskId).workspace;
    } catch {
      return null;
    }
  },
});
// Rows from before memory had workspaces (live tasks come from their workspace, not jin's own table).
journal.fillWorkspaces();
// A task's pre-context: what jin picks for it from long-term memory (the home's), as links.
const homeRows = async (ids: string[]): Promise<JournalEntry[]> => {
  const home = homeLink();
  return home ? machines.call<JournalEntry[]>(home.id, "GET", `/api/memory/rows?ids=${ids.map(encodeURIComponent).join(",")}`) : journal.rows(ids);
};
const preContext = new PreContext(db, {
  task: (taskId) => {
    const t = tasks.get(taskId);
    // What it is, and what its agents have been working on (the journal's concerns).
    const concerns = [...new Set(journal.forTask(taskId).map((e) => e.concern).filter(Boolean))];
    const about = [t.title ?? t.slug, t.repos.length ? `Repos: ${t.repos.join(", ")}` : "", t.issue ? `Issue: ${t.issue.id}` : "", ...linksOf(taskId).map((l) => `Follows: ${l.label}`), concerns.length ? `Working on: ${concerns.join(", ")}` : ""];
    return { workspace: t.workspace, brief: about.filter(Boolean).join("\n") };
  },
  candidates: async (workspace, text) => {
    const home = homeLink();
    return home ? machines.call<JournalEntry[]>(home.id, "GET", `/api/memory/candidates?workspace=${encodeURIComponent(workspace ?? "")}&text=${encodeURIComponent(text.slice(0, 1500))}`) : candidatesFor(journal, workspace, text);
  },
  rows: homeRows,
  choose: process.env.JIN_HARNESS === "scripted" ? scriptedChooser : haikuChooser((): Record<string, string> => {
    const dir = chatClaudeDir();
    return dir ? { CLAUDE_CONFIG_DIR: dir } : {};
  }),
});
/** The task's pre-context as text, picked first if it has not been (agents' starts pick it; a short wait at most here). */
const preContextText = async (taskId: string) => {
  await Promise.race([preContext.ensure(taskId), Bun.sleep(3_000)]);
  return preContext.text(taskId);
};
// What this machine's tasks kept, resent to the home (only what it lacks), so a keep that reached
// here but not the home arrives once it answers.
const resendKept = () => {
  const home = homeLink();
  const rows = journal.ownGlobal();
  if (!home || !rows.length) return;
  void machines.call(home.id, "POST", "/api/memory/import", { rows, machine: machines.identity?.id ?? null, missingOnly: true }).catch(() => {});
};
setTimeout(resendKept, 60_000);
setInterval(resendKept, 30 * 60_000);
preContextRoutes(app.router, preContext, homeRows);
/** A task's records as platform ids (its PRs, issue, and the threads and pages it follows): what its summary points to. */
const recordsOf = (taskId: string): string[] => {
  const t = tasks.get(taskId);
  const ids = [...prs.list(taskId).map((p) => `github:${p.repo.toLowerCase()}#${p.number}`), t.issue ? `${t.issue.tracker}:${t.issue.id}` : "", ...linksOf(taskId).map((l) => l.key)];
  return [...new Set(ids.filter(Boolean))];
};
journalRoutes(app.router, journal, {
  longTerm: longTermSearch,
  recordsOf,
  candidates: (workspace, text) => candidatesFor(journal, workspace, text),
  taskOfTerminal: (terminalId) => {
    try {
      const t = terminals.get(terminalId);
      return t.taskId ? { taskId: t.taskId, workspace: tasks.get(t.taskId).workspace } : null;
    } catch {
      return null;
    }
  },
  // Wrap up runs where chats do: on the home, told which machine the task is on.
  wrapUp: async (taskId) => {
    const t = tasks.get(taskId);
    const task = { id: t.id, title: t.title ?? t.slug };
    const home = homeLink();
    return home ? machines.call<{ chatId: string }>(home.id, "POST", "/api/memory/wrap-up", { task, machine: machines.identity?.id ?? null }) : hooks.wrapUp({ task, machine: null });
  },
});
agentHookRoutes(app.router, {
  terminals,
  adapters,
  workspaceOf: (terminalId) => {
    const taskId = terminalId ? terminals.list().find((t) => t.id === terminalId)?.taskId : undefined;
    return taskId ? tasks.get(taskId).workspace : app.workspaces[0]?.id;
  },
  onStatus: onClaudeStatus,
  precheck: (sessionId, tool, input) => sessions.precheck(sessionId, tool, input),
  sessionGate: (sessionId, tool, input, signal) => sessions.check(sessionId, tool, input, signal),
  // The agent created a PR in a task: attach it, whatever it does next.
  onPrsCreated: (terminalId, urls) => {
    const taskId = terminals.get(terminalId).taskId;
    if (taskId) for (const url of urls) void prs.attach(taskId, url, "hook").catch(problems.catch(`attaching ${url} to ${taskId}`));
  },
  journal,
});

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
      if (url) await prs.attach(t.id, url, "review").catch(problems.catch(`attaching ${url} to ${t.id}`));
    }
  })().catch((err) => console.error(`review ${job.taskId}: ${err}`));
});
prs.onEnded((taskId) => {
  void (async () => {
    const t = tasks.get(taskId);
    if (t.kind !== "review" || !prs.list(taskId).every((p) => p.state === "MERGED" || p.state === "CLOSED")) return;
    tasks.update(taskId, { archived: true });
    await tasks.removeIfClean(taskId).catch((err) => console.log(`review ${taskId} archived, kept: ${err instanceof Error ? err.message : err}`));
  })().catch(problems.catch("archiving a finished review"));
});
// Every few minutes (and soon after start): find PRs opened from tasks' branches, refresh open ones.
const syncPrs = async () => {
  for (const t of tasks.list().filter((x) => x.state === "ready")) await prs.discover(t).catch(problems.catch(`finding ${t.id}'s PRs`));
  await prs.refreshOpen();
};
const prTimer = setInterval(() => void syncPrs(), 5 * 60_000);
setTimeout(() => void syncPrs(), 5_000);

// Remote machines over SSH: each runs its own jin daemon, reached through a tunnel.
const machines = new Machines(config, app.workspaces);
// Chats run with the first workspace's Claude profile (if it has one), so their transcripts are there.
const chatClaudeDir = () => app.workspaces[0]?.profile.claudeConfigDir;
machineRoutes(app.router, machines);
// A machine's ports, reached on this machine's loopback, each over an ssh connection of its own.
const forwards = new Forwards(config.home, (id) => {
  const m = machines.records().find((r) => r.id === id);
  return m?.token && !m.attached ? { host: m.host, reserved: [m.remotePort, ...(m.reversePort ? [m.reversePort] : [])] } : null;
});
machines.forwards = forwards;
forwardRoutes(app.router, forwards);

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
  // The issue as its tracker reads it: an agent acting on the event is told how to read and close it.
  const tracker = t.issue ? trackers.get(t.issue.tracker) : null;
  const task = { id: t.id, title: t.title ?? t.slug, issue: t.issue && { ...t.issue, url: t.issue.url ?? tracker?.urlOf(t.issue.id) ?? null, noun: tracker?.noun ?? "issue", read: tracker?.howToRead(t.issue.id) ?? null, close: tracker?.howToClose ?? null } };
  fireEvent({ event: "pr.merged", key: pr.url, payload: { task, pr: { url: pr.url, repo: pr.repo, number: pr.number, title: pr.title } } });
  const all = prs.list(taskId);
  if (!all.every((p) => p.state === "MERGED" || p.state === "CLOSED")) return;
  // A repo with work but no PR yet (its PR not opened, or not attached) holds the task open: its
  // merge, once attached, comes back here.
  const unfinished = tasks.unfinished(taskId, all.map((p) => p.repo.split("/").pop() ?? p.repo));
  if (unfinished.length) {
    notifier.notify({
      key: `unfinished:${taskId}`,
      title: `${t.id}: a PR merged; the task stays open`,
      body: `Not in a pull request yet: ${unfinished.map((u) => `${u.repo} (${u.problem})`).join(", ")}. jin cleans up once those are merged too.`,
      path: `/t/${t.id}`,
    });
    return;
  }
  fireEvent({ event: "task.merged", key: taskId, payload: { task, prs: all.map((p) => ({ url: p.url, repo: p.repo, number: p.number, title: p.title, state: p.state })) } });
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
const setup = new LocalSetup(
  config,
  app.workspaces,
  (w) => {
    app.workspaces.push(w);
    adapters.set(w.id, createAdapter(w));
    upsertWorkspace.run(w.id, w.adapter, w.root, now());
  },
  undefined,
  undefined,
  (id) => {
    const i = app.workspaces.findIndex((w) => w.id === id);
    if (i >= 0) app.workspaces.splice(i, 1);
    adapters.delete(id);
  },
  (id) => tasks.list().filter((t) => t.workspace === id && t.state !== "removed").length,
);
setupRoutes(app.router, setup);
// Whether each desk's connection (gh, Claude's connectors) is there.
const desks = new Desks(config, app.workspaces);
deskRoutes(app.router, desks);
setTimeout(() => void desks.status().catch(problems.catch("checking the desks' connections")), 8_000); // warm, so a desk page does not wait

// A cheap fingerprint of what the app shows (tasks, tabs, chats, approvals, setups, PRs, feed):
// the web app re-renders when it changes instead of on a timer.
app.router.on("GET", "/api/stamp", () => {
  const summary = JSON.stringify([
    tasks.list().map((t) => [t.id, t.state, t.title, t.archived, t.removing, t.removeError]),
    [...terminals.list(), ...terminals.list({ archived: true })].map((t) => [t.id, t.status, t.title, t.archived, t.agentSessionId]),
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
  // Some answers take a while (the setup check asks every tool; a review fetches its PRs): the
  // default would drop a request that is quiet for ten seconds. This is the longest Bun allows.
  idleTimeout: 255,
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
forwards.resume();

// Live events through Composio (on the always-on home): the listener runs while any event is on.
// GitHub activity on your PRs is watched with gh here (one call every two minutes), not with triggers.
let liveDeliver: (e: LiveEvent) => void = () => {};
// It also settles the feed: items on PRs no longer open are done, and so is what came before your own comment or review.
const githubWatch = new GithubWatch(config.home, (e) => liveDeliver(e), undefined, ({ open, mine }) => {
  feed.settlePrs(open);
  for (const m of mine) feed.clearThread(m.key, m.at);
});
// What tasks follow (links): on the home, the Slack threads and channels they watch.
const watches = new Watches(config.home);
watchRoutes(app.router, watches);
const taskLinks = new TaskLinks(db, trackers);
tasks.onRemoved((taskId) => taskLinks.removeTask(taskId));
const linksOf = (taskId: string) => {
  const t = tasks.get(taskId);
  return [...ownLinks(t, prs.list(taskId)), ...taskLinks.list(taskId)];
};
// This machine's tasks' Slack links go to the home, where events are read (or stay here).
const pushWatches = () => {
  const live = tasks.list().filter((t) => t.state === "ready" && !t.archived);
  const liveIds = new Set(live.map((t) => t.id));
  const keys = taskLinks.list().filter((l) => liveIds.has(l.taskId)).map((l) => l.key);
  // Every key each task follows (its PRs and issue too), so the home's desk groups their events under the task.
  const owned = live.flatMap((t) => {
    try {
      return linksOf(t.id).map((l) => ({ key: l.key, taskId: t.id, title: t.title ?? t.slug }));
    } catch {
      return [];
    }
  });
  const home = homeLink();
  if (!home) return watches.set("local", keys, owned);
  void machines.call(home.id, "PUT", "/api/feed/watches", { machine: machines.identity?.id ?? "local", keys, tasks: owned }).catch(problems.catch("telling the home what tasks follow"));
};
// A Notion link's address may not carry its title (app.notion.com/p/<id>): ask Notion, through
// the connection on the home (or here).
const linkTitle = async (l: TaskLink): Promise<string | null> => {
  if (l.kind === "doc") {
    const home = homeLink();
    const d = await within(home ? machines.call<{ title: string }>(home.id, "GET", `/api/docs/${l.key.slice(4)}`) : Promise.resolve(docs.get(l.key.slice(4))), 10_000);
    return d?.title ?? null;
  }
  if (l.kind !== "notion") return null;
  const id = l.key.slice("notion:".length);
  const home = homeLink();
  const page = await within(home ? machines.call<{ title: string } | null>(home.id, "GET", `/api/composio/notion-page?id=${id}`) : composio.notionPage(id), 15_000);
  return page?.title ?? null;
};
const retitle = (links: TaskLink[]) =>
  void (async () => {
    for (const l of links.filter((x) => x.kind === "notion" || x.kind === "doc")) {
      const t = await linkTitle(l).catch(problems.catch(`the title of ${l.key}`, null));
      if (t && t !== l.label) taskLinks.setLabel(l.taskId, l.key, t);
    }
  })();
linkRoutes(app.router, {
  trackers,
  links: taskLinks,
  linksOf,
  changed: pushWatches,
  title: linkTitle,
  context: {
    taskOf: (terminalId) => terminals.get(terminalId).taskId ?? null,
    task: (id) => tasks.get(id),
    prs: (taskId) => prs.list(taskId),
    journal: async (taskId) => [await preContextText(taskId).catch(() => ""), journal.contextText(taskId)].filter(Boolean).join("\n\n"),
  },
  // Events are read on the home: a task's Activity comes from its feed.
  feedItems: async () => {
    const home = homeLink();
    return home ? machines.call<FeedItem[]>(home.id, "GET", "/api/feed") : feed.list();
  },
});
// What the task's workspace tells its agent: where it starts, what to read, how to set up.
const briefOf = (taskId: string) => {
  const t = tasks.get(taskId);
  return tasks.adapter(t.workspace).agentBrief({ id: t.id, kind: t.kind, root: t.root, repos: t.repos });
};
for (const launch of agents.all()) Object.assign(launch, { linksOf, briefOf, preContextOf: (taskId: string) => preContext.cached(taskId) });
jobs.addLinks = (taskId, urls) => {
  const problems: string[] = [];
  for (const u of urls.map((x) => x.trim()).filter(Boolean)) {
    try {
      retitle([taskLinks.add(taskId, u)]);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  pushWatches();
  return problems;
};
setTimeout(pushWatches, 10_000);
// Notion links added before titles were looked up.
setTimeout(() => retitle(taskLinks.list().filter((l) => (l.kind === "notion" && l.label === "Notion page") || l.kind === "doc")), 20_000);
// A task's Claude Code reads a linked jin doc here (jin-task doc, read_doc); docs live on the home.
app.router.on("GET", "/api/task-docs/:id", async (_req, p) => {
  const id = p.id ?? "";
  if (!DOC_ID.test(id)) throw new HttpError(404, `no doc ${id}`);
  const home = homeLink();
  const d = home ? await machines.call<{ title: string; body: string; version: number }>(home.id, "GET", `/api/docs/${id}`) : docs.get(id);
  return new Response(`# ${d.title}\n\n(jin doc ${id}, version ${d.version})\n\n${d.body}`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
});
const watchTimer = setInterval(pushWatches, 5 * 60_000);
const slackThreads = new SlackThreads(config.home);
const composio = new Composio(config, {
  feed,
  workspaces: app.workspaces,
  // Followed by a task: a Slack thread or channel it links, or any key a task follows (its Linear issue).
  watched: (key, channel) => watches.watched(key, channel) || Boolean(watches.ownerOf(key, channel || undefined)),
  slackThreads,
  notify: (n) => void notifier.notify(n),
  onEvent: (e) => fireEvent({ event: "live.event", key: e.id, payload: { ...e } }),
  shouldNotify: (e) => liveNotifies(notifier.settings, e),
  holdsDesk: () => holdsFeed(),
  github: githubWatch,
});
liveDeliver = (e) => composio.deliver(e);
composioRoutes(app.router, composio);
// A doc synced to Notion only when you ask, through the Notion connection you pick.
notionSyncRoutes(app.router, new NotionSync(db, docs, { tool: (slug, input, opts) => composio.tool(slug, input, opts), accounts: (t) => composio.accounts(t) }));

// The desk's life cycle, where the feed is (the home, or this machine without one): triage of
// new items, the Slack read check, and the context check that marks handled items stale.
const deskModelEnv = (): Record<string, string> => {
  const dir = chatClaudeDir();
  return dir ? { CLAUDE_CONFIG_DIR: dir } : {};
};
const scripted = process.env.JIN_HARNESS === "scripted";
const slackTool = <T,>(slug: string, args: Record<string, unknown>) => composio.tool(slug, args).then((d) => (d ?? undefined) as T | undefined);
const triager = new Triager(feed, {
  classify: scripted ? scriptedClassify : haikuClassify(deskModelEnv),
  me: () => composio.settings.me,
  tasks: () => watches.tasks().map((t) => ({ id: t.taskId, title: t.title })),
  ownerOf: (i) => watches.ownerOf(i.thread?.key, i.meta?.channel),
});
const slackReads = new SlackReads(feed, {
  lastRead: async (channel) => {
    const d = await slackTool<{ channel?: { last_read?: string }; last_read?: string }>("SLACK_RETRIEVE_CONVERSATION_INFORMATION", { channel });
    return d?.channel?.last_read ?? d?.last_read ?? null;
  },
});
const staleChecker = new StaleChecker(feed, {
  judge: scripted ? scriptedJudge : haikuJudge(deskModelEnv),
  // Slack: the thread's replies (or the DM's later messages) since the item, yours marked as "you".
  since: async (item) => {
    const m = item.meta;
    if (item.source !== "slack" || !m?.channel || !m.ts || !composio.installed) return "";
    const dm = item.thread?.key.startsWith("slack:dm:");
    const d = dm
      ? await slackTool<{ messages?: { user?: string; text?: string; ts?: string }[] }>("SLACK_FETCH_CONVERSATION_HISTORY", { channel: m.channel, oldest: m.ts, limit: 20 })
      : await slackTool<{ messages?: { user?: string; text?: string; ts?: string }[] }>("SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION", { channel: m.channel, ts: m.threadTs ?? m.ts, oldest: m.ts, limit: 20 });
    const me = composio.settings.me.slack;
    return (d?.messages ?? [])
      .filter((x) => Number(x.ts) > Number(m.ts))
      .slice(0, 15)
      .map((x) => `${x.user && x.user === me ? "you" : (x.user ?? "someone")}: ${(x.text ?? "").replace(/\s+/g, " ").slice(0, 280)}`)
      .join("\n");
  },
});
// The desk runs where the home is: on the home, or here without one, unless this machine gave the home up.
const holdsFeed = () => !homeLink() && !gaveUpHome(config.home);
setInterval(() => holdsFeed() && void triager.run().catch(problems.catch("triaging the desk")), 20_000);
setInterval(() => {
  if (!holdsFeed() || scripted || !composio.installed || !composio.settings.events.slack_dms && !composio.settings.events.slack_mentions) return;
  void slackReads
    .run()
    .then(() => staleChecker.run())
    .catch(problems.catch("checking what you read in Slack"));
}, 2 * 60_000);
setInterval(() => holdsFeed() && void staleChecker.run().catch(problems.catch("checking what was handled on the desk")), 30 * 60_000);

// Only what involves you reaches the desk: the Slack threads you wrote in lately (so their replies
// count from the start), refreshed daily; and, once, what came in before that rule is cleared.
const slackOn = () => !scripted && composio.installed && Boolean(composio.settings.events.slack_dms || composio.settings.events.slack_mentions);
const seedThreads = () => holdsFeed() && slackOn() && void composio.seedSlackThreads().then((n) => n && console.log(`slack: ${n} thread${n === 1 ? "" : "s"} you wrote in`)).catch(problems.catch("finding the Slack threads you are in"));
setTimeout(seedThreads, 30_000);
setInterval(seedThreads, 24 * 3_600_000);
const RESCOPED = join(config.home, "involvement-v1");
setTimeout(() => {
  if (!holdsFeed() || existsSync(RESCOPED)) return;
  const dismissed = feed.dismissUninvolved();
  const notion = scripted || !composio.installed || !composio.settings.events.notion_comments ? Promise.resolve(0) : composio.rescopeNotion();
  void notion
    .then((moved) => {
      writeFileSync(RESCOPED, new Date().toISOString());
      console.log(`desk: ${dismissed} item${dismissed === 1 ? "" : "s"} not involving you dismissed, ${moved} Notion comment${moved === 1 ? "" : "s"} to probably done`);
    })
    .catch(problems.catch("clearing what does not involve you from the desk"));
}, 45_000);

// What @mentions resolve against: this machine's tasks and every connected machine's (each within a
// moment, or left out), the feed, a PR's live state through gh, a Linear issue's through Composio.
const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, Bun.sleep(ms).then(() => { throw new Error("slow"); })]);
mentions = new Mentions({
  machines: async () => {
    const here: MachineSnapshot = { machine: "local", label: machines.identity?.label ?? "this machine", tasks: tasks.list(), prs: prs.list(), terminals: terminals.list() };
    const there = await Promise.all(
      machines
        .list()
        .filter((m) => m.connected)
        .map(async (m): Promise<MachineSnapshot | null> => {
          try {
            const [t, p, x] = await within(Promise.all([machines.call<any[]>(m.id, "GET", "/api/tasks"), machines.call<any[]>(m.id, "GET", "/api/prs").catch(() => []), machines.call<any[]>(m.id, "GET", "/api/terminals").catch(() => [])]), 2500);
            return { machine: m.id, label: m.label, tasks: t, prs: p, terminals: x };
          } catch {
            return null;
          }
        }),
    );
    return [here, ...there.filter((s): s is MachineSnapshot => s !== null)];
  },
  feed: () => feed.list(),
  pr: async (repo, number) => {
    const p = Bun.spawn(["gh", "pr", "view", String(number), "-R", repo, "--json", "title,url,state,isDraft,reviewDecision,statusCheckRollup,author"], { stdout: "pipe", stderr: "ignore" });
    const out = await within(new Response(p.stdout).text(), 8000);
    if ((await p.exited) !== 0) return null;
    const d = JSON.parse(out) as { title: string; url: string; state: string; isDraft: boolean; reviewDecision: string | null; statusCheckRollup?: { conclusion?: string; state?: string; status?: string }[]; author?: { login?: string } };
    return { title: d.title, url: d.url, state: d.state, draft: d.isDraft, review: d.reviewDecision || null, checks: rollup(d.statusCheckRollup ?? []), author: d.author?.login ?? null };
  },
  trackers,
  inUse: () => app.workspaces.map((w) => trackers.get(w.tracker)).filter((t): t is IssueTracker => t !== null),
});
mentionRoutes(app.router, mentions, (id) => sessions.events(id));
// Linear's issues are read through Composio (only the fields shown, and the issue's own link).
lookupLinear = async (id) => {
  const d = await within(composio.tool("LINEAR_RUN_QUERY_OR_MUTATION", { query_or_mutation: "query($id:String!){ issue(id:$id){ title url state{name} assignee{displayName} team{name} } }", variables: { id } }), 10_000);
  const i = ((d?.data as Record<string, unknown> | undefined)?.issue ?? null) as { title?: string; url?: string; state?: { name?: string }; assignee?: { displayName?: string } | null; team?: { name?: string } | null } | null;
  return i?.title ? { title: i.title, url: i.url ?? null, state: i.state?.name ?? null, assignee: i.assignee?.displayName ?? null, team: i.team?.name ?? null } : null;
};
// A machine that gave the home up does not run the desk again after a restart.
if (!gaveUpHome(config.home)) {
  composio.startListener();
  composio.resumeNative();
}

// Moving the home: this machine gives it up (and stops running the desk), hands over what it
// holds, or takes it over (rows and files in, then everything that read those files reads them again).
const homeData = {
  giveUp: () => {
    setNotHome(config.home, true);
    composio.reload(false);
  },
  keep: () => {
    setNotHome(config.home, false);
    composio.reload(holdsFeed());
  },
  export: () => exportHome(db, config.home, { claudeDir: chatClaudeDir() }),
  import: (b: HomeBundle) => {
    const moved = importHome(db, config.home, b, { claudeDir: chatClaudeDir() });
    for (const r of [slackThreads, watches, notifier, hooks, githubWatch]) r.reload();
    composio.reload(holdsFeed());
    return moved;
  },
};
machines.homeData = homeData;
app.router
  .on("POST", "/api/home/give-up", () => (homeData.giveUp(), json({ ok: true })))
  .on("POST", "/api/home/keep", () => (homeData.keep(), json({ ok: true })))
  .on("GET", "/api/home/export", () => json(homeData.export()))
  .on("POST", "/api/home/import", async (req) => json(homeData.import(await body<HomeBundle>(req))));

// Always on (vm mode, e.g. the hub): the GitHub feed refreshes on its own every 10 minutes.
const feedTimer = config.mode === "vm" && !process.env.JIN_NO_TIMERS
  ? setInterval(() => holdsFeed() && void collectGithub(app.workspaces).then((items) => feed.add(items)).catch(problems.catch("collecting GitHub")), 10 * 60_000)
  : null;

function shutdown() {
  clearInterval(prTimer);
  clearInterval(watchTimer);
  if (feedTimer) clearInterval(feedTimer);
  machines.stopAll();
  forwards.stopAll();
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
