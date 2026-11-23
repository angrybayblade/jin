// Server-only access to the jin daemon. The token is read from $JIN_HOME/daemon.json
// on the server; the browser never sees it and never talks to the daemon directly.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { headers } from "next/headers";
import { homedir } from "node:os";
import { join } from "node:path";

export interface FeedItem {
  id: string;
  workspace: string;
  source: string;
  kind: string;
  externalRef: string;
  title: string;
  summary: string;
  receivedAt: string;
  state: "new" | "snoozed" | "done" | "dismissed" | "promoted";
  taskId: string | null;
  priority: { score: number; why: string } | null;
  thread?: { key: string; title: string; ref: string | null; url: string | null } | null;
  actor?: string | null;
  /** Why it might concern you: authored, reviewer, team-review, requested, mentioned, dm, mention, person, assigned, comment… */
  tags?: string[];
}

export interface Task {
  id: string;
  workspace: string;
  type: string | null;
  slug: string;
  repos: string[];
  root: string;
  state: "ready" | "removed";
  createdAt: string;
  branch?: string | null;
  /** jin's display title, when renamed in jin. */
  title: string | null;
  archived: boolean;
  /** The task this one was spawned from (jin-task spawn). */
  parent?: string | null;
  /** A change (named after its issue, in a workspace that does that), a review of pull requests, or a scratch experiment. */
  kind?: "change" | "review" | "scratch";
  /** The issue it is for, when its workspace ties tasks to issues. */
  issue?: { tracker: string; id: string; url?: string | null } | null;
  /** Being removed now (in the background), and why the last removal failed. */
  removing?: boolean;
  removeError?: string | null;
  prs?: { repo: string; number: number; head?: string; title?: string; url?: string }[];
}

/** What a task follows: its PRs and issue (by themselves), Slack threads and channels and Notion pages (linked by hand). */
export interface TaskLink {
  taskId: string;
  key: string;
  /** An issue's key names its tracker: "linear:ENG-1", "github:acme/api#7". */
  kind: "github" | "issue" | "slack-thread" | "slack-channel" | "notion" | "doc";
  url: string | null;
  label: string;
  since: string | null;
  how: "manual" | "pr" | "issue";
  addedAt: string;
}
export interface TaskActivity {
  links: TaskLink[];
  items: FeedItem[];
}

/** One of jin's skills (a SKILL.md), tagged; tasks get the ones their kind asks for. */
export interface Skill {
  name: string;
  description: string;
  tags: string[];
  updatedAt: string;
}
export interface SkillsStatus {
  skills: Skill[];
  /** The tags each kind of task asks for. */
  taskTags: Record<string, string[]>;
  everyTask: string;
}

/** jin docs (on the home): specs, RFCs and notes you and jin work on. */
export interface DocAnchor {
  quote: string;
  prefix?: string | null;
  suffix?: string | null;
}
export interface DocSummary {
  id: string;
  title: string;
  tags: string[];
  excerpt: string;
  updatedAt: string;
  openThreads: number;
  openSuggestions: number;
}
export interface DocComment {
  id: string;
  by: string;
  text: string;
  at: string;
}
export interface DocThread {
  id: string;
  anchor: DocAnchor | null;
  by: string;
  resolved: boolean;
  createdAt: string;
  located: boolean;
  comments: DocComment[];
}
export interface DocSuggestion {
  id: string;
  anchor: DocAnchor;
  replacement: string;
  why: string | null;
  by: string;
  status: "open" | "accepted" | "rejected";
  createdAt: string;
  decidedAt: string | null;
  located: boolean;
}
export interface Doc {
  id: string;
  title: string;
  body: string;
  tags: string[];
  version: number;
  chatId: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}
export interface DocFull extends Doc {
  threads: DocThread[];
  suggestions: DocSuggestion[];
}
export interface DocVersion {
  version: number;
  title: string;
  by: string;
  at: string;
  size: number;
}

/** A skill (or custom command) Claude Code offers in a chat. */
export interface ChatSkill {
  name: string;
  description: string;
  argumentHint: string;
}

/** ~/.claude/settings.json on a machine, as its daemon reads it. */
export interface ClaudeSettingsFile {
  path: string;
  exists: boolean;
  text: string;
  /** null: the file does not parse (see error); fix it in the raw editor. */
  settings: Record<string, unknown> | null;
  hash: string;
  error: string | null;
}

export type SessionState = "running" | "waiting_approval" | "idle" | "failed" | "interrupted";

export type ChatKind = "jin" | "desk" | "slack" | "linear" | "notion" | "gmail" | "github" | "doc";
export type SessionKind = ChatKind | "task" | "room";

export interface Session {
  id: string;
  kind: SessionKind;
  taskId: string | null;
  workspace: string | null;
  title: string;
  harness: string;
  harnessSessionId: string | null;
  state: SessionState;
  /** The chat's model and effort; null: jin's default model, the model's default effort. */
  model: string | null;
  effort: Effort | null;
  createdAt: string;
  lastEventAt: string | null;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** What the composer offers: Claude models, effort levels, and the model a new chat runs with. */
export interface ModelChoices {
  models: { id: string; label: string }[];
  efforts: Effort[];
  default: { model: string };
}

/** A model and effort sent with a message (kept by the chat for its next messages). */
export interface RunChoice {
  model?: string;
  /** "default": the model's default effort. */
  effort?: Effort | "default";
}

/** The coding agents a terminal tab can run. */
export type AgentId = "claude" | "codex" | "pi";

/** A machine's agents: which are installed, and which one new tabs start. */
export interface MachineAgents {
  default: AgentId;
  agents: { id: AgentId; label: string; installed: boolean }[];
}

export type AgentStatus = "starting" | "working" | "waiting" | "idle" | "exited" | "interrupted";

export interface TerminalInfo {
  id: string;
  /** A shell, or a coding agent's tab (Claude Code, Codex: its `agent`). */
  kind: "shell" | "agent";
  agent: AgentId | null;
  taskId: string | null;
  cwd: string;
  title: string;
  status: AgentStatus;
  exitCode: number | null;
  agentSessionId: string | null;
  createdAt: string;
  clients: number;
  archived: boolean;
}

export interface Repo {
  name: string;
  path: string;
  branch: string;
  description: string;
}

export interface TaskJob {
  id: string;
  workspace: string;
  taskId: string;
  slug: string;
  repos: string[];
  setup: boolean;
  state: "running" | "done" | "failed";
  log: string[];
  error: string | null;
  terminalId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
}

export interface RepoDiff {
  repo: string;
  branch: string;
  diff: string;
  untracked: string[];
}

export interface SessionEvent {
  seq: number;
  kind: string;
  payload: Record<string, any>;
  at: string;
}

export interface Approval {
  id: string;
  sessionId: string;
  action: { tool: string; input: Record<string, unknown> };
  reason: string;
  state: "pending" | "approved" | "rejected" | "expired";
  createdAt: string;
}

/** Whether a desk's connection is there (gh, or one of Claude's connectors). */
export interface DeskStatus {
  kind: "github" | "gmail" | "slack" | "linear" | "notion";
  state: "connected" | "needs-auth" | "failed" | "missing";
  via: string | null;
}

export interface Status {
  mode: "local" | "vm";
  jobs: number;
  workspaces: string[];
}

export class DaemonUnavailable extends Error {}


const jinHome = () => process.env.JIN_HOME ?? join(homedir(), ".jin");

/** The always-on hub this jin uses as its home, if one is set: chats, desks, feed and approvals live there. */
export function homeMachine(): string {
  const dir = join(jinHome(), "machines");
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as { id: string; home?: boolean; token?: string | null };
      if (m.home && m.token) return m.id;
    }
  } catch {
    // no machines yet
  }
  return "local";
}

/** Every machine this jin can show: this one, then the remote ones it knows. */
export function knownMachines(): string[] {
  try {
    return ["local", ...readdirSync(join(jinHome(), "machines")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((id) => /^[a-z0-9-]+$/.test(id))];
  } catch {
    return ["local"];
  }
}

/**
 * The machine this request is about: the one in its URL (/m/<machine>/…, which the proxy turns
 * into a header, for the page and the server actions it posts), else this machine.
 */
export async function currentMachine(): Promise<string> {
  try {
    const id = (await headers()).get("x-jin-machine");
    if (id && /^[a-z0-9-]+$/.test(id) && existsSync(join(jinHome(), "machines", `${id}.json`))) return id;
  } catch {
    // outside a request
  }
  return "local";
}

/** What lives on the home (hub) rather than on the machine a task page shows. */
const HOME_PATH = /^\/api\/(sessions|chats|approvals|feed|collect|desks|presence|notifications|composio|event-hooks|skills|chat-skills|mentions|models|docs)(\/|\?|$)/;
function machineFor(path: string, init: { json?: unknown }): string | null {
  if (HOME_PATH.test(path)) return homeMachine();
  // A websocket ticket goes where its socket is: a chat's stream to the home.
  if (path === "/api/tickets" && typeof (init.json as { path?: string } | undefined)?.path === "string" && (init.json as { path: string }).path.startsWith("/api/sessions/")) return homeMachine();
  return null;
}

/** The daemon's websocket base, for the browser (which connects with one-time tickets, never the token); `home` for chats. */
export async function daemonWsBase(opts: { home?: boolean } = {}): Promise<string> {
  return connection(opts.home ? homeMachine() : await currentMachine()).url.replace(/^http/, "ws");
}

/**
 * This machine's daemon from $JIN_HOME/daemon.json; a remote machine's through its SSH tunnel,
 * from $JIN_HOME/machines/<id>.json (written by this machine's daemon when it onboarded it).
 */
function connection(machine: string): { url: string; token: string } {
  const home = jinHome();
  if (machine !== "local") {
    try {
      const m = JSON.parse(readFileSync(join(home, "machines", `${machine}.json`), "utf8")) as { label: string; localPort: number | null; token: string | null };
      if (m.localPort && m.token) return { url: `http://127.0.0.1:${m.localPort}`, token: m.token };
      throw new DaemonUnavailable(`${m.label} is not set up yet`);
    } catch (err) {
      if (err instanceof DaemonUnavailable) throw err;
      throw new DaemonUnavailable(`the machine ${machine} is not known here`);
    }
  }
  try {
    const info = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { host: string; port: number; token: string };
    return { url: `http://${info.host}:${info.port}`, token: info.token };
  } catch {
    throw new DaemonUnavailable(`the jin daemon is not running (no ${join(home, "daemon.json")}); start it with \`bun run --cwd apps/daemon start\``);
  }
}

/** A daemon call: to the machine the app is showing, or with `local`, always to this machine's own daemon. */
export async function daemon<T>(path: string, init: { method?: string; json?: unknown; local?: boolean; machine?: string; timeoutMs?: number } = {}): Promise<T> {
  const machine = init.machine ?? (init.local ? "local" : (machineFor(path, init) ?? (await currentMachine())));
  const { url, token } = connection(machine);
  let res: Response;
  try {
    res = await fetch(url + path, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      cache: "no-store",
      // Another machine (the home included) gets a limit: a tunnel that is open here while the far
      // end is not answering yet (after a restart, sleep or a network change) would hang the page.
      signal: init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : machine === "local" ? undefined : AbortSignal.timeout(15_000),
    });
  } catch {
    throw new DaemonUnavailable(machine === "local" ? `the jin daemon at ${url} is not answering` : `jin on ${machine} is not answering: its tunnel is down or the machine is off`);
  }
  if (!res.ok) {
    const detail = await res.text();
    let message = detail;
    try {
      message = (JSON.parse(detail) as { error?: string }).error ?? detail;
    } catch {}
    throw new Error(`${init.method ?? "GET"} ${path}: ${message}`);
  }
  return (await res.json()) as T;
}

/** One machine's tasks, for the sidebar: every connected machine is listed the same way. */
export interface MachineTasks {
  id: string;
  label: string;
  tasks: Task[];
  terminals: TerminalInfo[];
  jobs: TaskJob[];
  prs: TaskPR[];
  /** It has a workspace (else it can run no tasks yet). */
  hasWorkspace: boolean;
  /** It did not answer in time (shown, greyed, until it does). */
  down?: boolean;
}

export interface MachineStep {
  id: string;
  label: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  log: string[];
  error: string | null;
}

export interface MachineAuth {
  /** gh, claude, or a tool a workspace provider declares. */
  tool: string;
  label: string;
  why: string;
  optional: boolean;
  /** It can take a token instead of a sign-in (what the token looks like). */
  tokenHint: string | null;
  state: "unknown" | "signed-in" | "signed-out" | "missing" | "waiting" | "failed";
  account: string | null;
  url: string | null;
  code: string | null;
  needsCode: boolean;
  error: string | null;
}

/** A remote machine, as this machine's daemon sees it (never its token). */
export interface Machine {
  id: string;
  /** This jin's home (the always-on hub). */
  home?: boolean;
  /** On a hub: a machine that connected itself (a laptop), reached back over its own line. */
  attached?: boolean;
  host: string;
  label: string;
  remotePort: number;
  localPort: number | null;
  createdAt: string;
  version: string | null;
  workspace: string | null;
  system: string | null;
  connected: boolean;
  tunnel: "up" | "connecting" | "down" | "off";
  busy: boolean;
  outdated: boolean;
  steps: MachineStep[];
  workspaceStep: MachineStep | null;
  workspaceCandidates: DetectedWorkspace[] | null;
  providers: WorkspaceProviderView[];
  auth: MachineAuth[];
}

/** Something mentioned in a chat (@platform#133, @PLEN-1334), as jin resolved it. */
export interface Mention {
  label: string;
  kind: "pr" | "issue" | "task";
  key: string;
  title: string | null;
  url: string | null;
  state: string | null;
  detail: string | null;
  machine?: string;
  machineLabel?: string;
  /** An issue: what its tracker calls one ("Linear issue"). */
  noun?: string;
}

/** Something a chat talked about: a PR, ticket, task, Slack thread, Notion page, mail or link. */
export interface ChatRef {
  key: string;
  kind: "pr" | "issue" | "task" | "slack" | "notion" | "mail" | "link";
  label: string;
  title: string | null;
  url: string | null;
  state: string | null;
  detail: string | null;
  machineLabel?: string;
  by: "you" | "jin" | "both";
  count: number;
  lastSeq: number;
}

/** A kind of task a workspace runs (from its provider). */
export interface TaskKindSpec {
  id: "change" | "review" | "scratch";
  label: string;
  autoId: boolean;
  idHint?: string;
  /** Its id is its issue's, in the workspace's tracker (the form looks the issue up). */
  idIsIssue?: boolean;
  types?: string[];
  prs?: boolean;
  note?: string;
}

/** A workspace found on a machine, of one of the kinds jin knows. */
export interface DetectedWorkspace {
  provider: string;
  root: string;
  /** The one its own tooling points at. */
  preferred: boolean;
}

/** A kind of workspace jin can use (a workspace provider). */
export interface WorkspaceProviderView {
  id: string;
  label: string;
  description: string;
  installsTo: string | null;
  /** What it installs from, when it asks (a repo to clone). */
  source: { label: string; hint: string } | null;
}

/** First-run setup for this machine (always this machine's daemon). */
export interface SetupState {
  workspaces: { id: string; root: string; adapter: string }[];
  candidates: DetectedWorkspace[];
  providers: WorkspaceProviderView[];
  auth: MachineAuth[];
  install: MachineStep | null;
  ready: boolean;
}

/** Live events through Composio, on the home. */
export interface LiveStatus {
  installed: boolean;
  signedIn: boolean;
  email: string | null;
  org: string | null;
  login: { url: string | null; state: "idle" | "waiting" | "done" | "failed"; error: string | null };
  project: { id: string; name: string; orgId: string } | null;
  userId: string;
  accounts: { toolkit: string; id: string | null; status: string | null }[];
  events: { kind: string; label: string; toolkit: string; on: boolean; triggers: number; native?: boolean }[];
  github?: { watching: number; lastCheck: string | null; error: string | null } | null;
  linearTeams: string[];
  listener: { state: "off" | "starting" | "running" | "down"; since: string | null; error: string | null };
  recent: { id: string; at: string; toolkit: string; trigger: string; title: string; summary: string; url: string | null; actor: string | null; forYou: boolean }[];
}

export interface NotificationSettings {
  enabled: boolean;
  sound: boolean;
  sources?: Record<string, string[]>;
}

/** Per app, the kinds of live event that can notify, and whether each is chosen. */
export interface NotificationKinds {
  app: string;
  label: string;
  kinds: { id: string; label: string; on: boolean; chosen: boolean }[];
}

export interface TaskPR {
  taskId: string;
  url: string;
  repo: string;
  number: number;
  title: string | null;
  state: "OPEN" | "CLOSED" | "MERGED" | null;
  draft: boolean;
  review: string | null;
  checks: "passing" | "failing" | "pending" | null;
  head: string | null;
  attachedBy: string;
  attachedAt: string;
  updatedAt: string | null;
}

// ---------------------------------------------------------------- hooks

export type HookEventId = "pr.merged" | "task.merged" | "live.event";
export interface Hook {
  id: string;
  name: string;
  event: HookEventId;
  filter: Record<string, string>;
  instructions: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}
export interface HookRun {
  id: string;
  hookId: string;
  hookName: string;
  event: HookEventId;
  key: string;
  at: string;
  chatId: string | null;
  error: string | null;
}
export interface HooksStatus {
  hooks: Hook[];
  events: { id: HookEventId; label: string; description: string; fields: string[] }[];
  runs: HookRun[];
}

// ---------------------------------------------------------------- work journal

export interface JournalRef {
  type: "file" | "commit" | "test";
  text: string;
}
export interface JournalEntry {
  id: string;
  session: string | null;
  concern: string | null;
  kind: "decision" | "done" | "found" | "change";
  text: string;
  why: string | null;
  refs: JournalRef[];
  at: string;
}
export interface JournalView {
  concerns: { name: string; startedAt: string; lastAt: string; entries: JournalEntry[] }[];
  unjournaled: JournalEntry[];
}

// ---------------------------------------------------------------- a task's agent room

export type RoomAccess = "writer" | "read-only";
export type RoomAgentState = "new" | "queued" | SessionState;

/** An agent in a task's room: a profile (its role, whether it changes the code, its model) with a session of its own. */
export interface RoomAgent {
  id: string;
  taskId: string;
  /** What you type after @. */
  handle: string;
  name: string;
  brief: string;
  access: RoomAccess;
  model: string | null;
  effort: Effort | null;
  color: string;
  sessionId: string | null;
  state: RoomAgentState;
  /** Turns waiting behind the one running. */
  queued: number;
  /** While it works: the last thing it did. */
  activity: string | null;
  /** While it works: what it is writing now. */
  draft: string | null;
}

export interface RoomMessage {
  seq: number;
  /** "you", an agent's id, or "room" (a note). */
  author: string;
  authorName: string;
  authorHandle: string | null;
  kind: "message" | "note";
  text: string;
  mentions: string[];
  /** What the turn behind it made or changed: docs, and the files a writer touched per repo. */
  refs: ({ kind: "doc"; id: string; title: string; did: string[] } | { kind: "files"; repo: string; count: number; files: string[] })[];
  pinned: boolean;
  at: string;
}

export interface RoomApproval {
  id: string;
  agentId: string;
  action: { tool: string; input: Record<string, unknown> };
  reason: string;
  createdAt: string;
}

export interface RoomState {
  taskId: string;
  agents: RoomAgent[];
  /** Messages after the one asked from. */
  messages: RoomMessage[];
  pinned: RoomMessage[];
  lastSeq: number;
  approvals: RoomApproval[];
}

/** What you set on an agent's profile. */
export interface RoomProfile {
  handle: string;
  name: string;
  brief: string;
  access: RoomAccess;
  /** "": jin's default model. */
  model: string;
  /** "default": the model's default effort. */
  effort: string;
}

/** Something a daemon did in the background that failed. */
export interface Problem {
  scope: string;
  message: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

/** A workspace's issue tracker, as forms and labels show it. */
export interface TrackerView {
  id: string;
  label: string;
  /** "Linear issue". */
  noun: string;
  idHint: string;
}
