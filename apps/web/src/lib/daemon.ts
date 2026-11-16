// Server-only access to the jin daemon. The token is read from $JIN_HOME/daemon.json
// on the server; the browser never sees it and never talks to the daemon directly.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cookies } from "next/headers";
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
}

export type SessionState = "running" | "waiting_approval" | "idle" | "failed" | "interrupted";

export type ChatKind = "jin" | "slack" | "linear" | "notion" | "gmail" | "github";
export type SessionKind = ChatKind | "task";

export interface Session {
  id: string;
  kind: SessionKind;
  taskId: string | null;
  workspace: string | null;
  title: string;
  harness: string;
  harnessSessionId: string | null;
  state: SessionState;
  createdAt: string;
  lastEventAt: string | null;
}

export type AgentStatus = "starting" | "working" | "waiting" | "idle" | "exited" | "interrupted";

export interface TerminalInfo {
  id: string;
  kind: "shell" | "claude";
  taskId: string | null;
  cwd: string;
  title: string;
  status: AgentStatus;
  exitCode: number | null;
  claudeSessionId: string | null;
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

/** Which machine the app is showing: "local", or a remote machine's id (a cookie, set by the machine switcher). */
export const MACHINE_COOKIE = "jin-machine";

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

export async function currentMachine(): Promise<string> {
  try {
    const id = (await cookies()).get(MACHINE_COOKIE)?.value;
    if (id === "local") return "local";
    if (id && /^[a-z0-9-]+$/.test(id) && existsSync(join(jinHome(), "machines", `${id}.json`))) return id;
  } catch {
    // outside a request
  }
  return homeMachine(); // the home, when there is one; else this machine
}

/** What lives on the home (hub) rather than on the machine a task page shows. */
const HOME_PATH = /^\/api\/(sessions|chats|approvals|feed|collect|desks|presence|notifications|composio)(\/|\?|$)/;
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
      signal: init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined,
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

/** Another machine's tasks, for the sidebar (the one the app shows has the full set). */
export interface Elsewhere {
  id: string;
  label: string;
  tasks: Task[];
  terminals: TerminalInfo[];
  prs: TaskPR[];
}

export interface MachineStep {
  id: string;
  label: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  log: string[];
  error: string | null;
}

export interface MachineAuth {
  tool: "gh" | "claude" | "doppler";
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
  workspaceCandidates: string[] | null;
  workspaceCws: string | null;
  auth: MachineAuth[];
}

/** First-run setup for this machine (always this machine's daemon). */
export interface SetupState {
  workspaces: { id: string; root: string }[];
  candidates: string[];
  cws: string | null;
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
