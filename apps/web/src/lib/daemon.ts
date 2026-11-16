// Server-only access to the jin daemon. The token is read from $JIN_HOME/daemon.json
// on the server; the browser never sees it and never talks to the daemon directly.
import { readFileSync } from "node:fs";
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

export interface Status {
  mode: "local" | "vm";
  jobs: number;
  workspaces: string[];
}

export class DaemonUnavailable extends Error {}

/** The daemon's websocket base, for the browser (which connects with one-time tickets, never the token). */
export function daemonWsBase(): string {
  return connection().url.replace(/^http/, "ws");
}

function connection(): { url: string; token: string } {
  const home = process.env.JIN_HOME ?? join(homedir(), ".jin");
  try {
    const info = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { host: string; port: number; token: string };
    return { url: `http://${info.host}:${info.port}`, token: info.token };
  } catch {
    throw new DaemonUnavailable(`the jin daemon is not running (no ${join(home, "daemon.json")}); start it with \`bun run --cwd apps/daemon start\``);
  }
}

export async function daemon<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const { url, token } = connection();
  let res: Response;
  try {
    res = await fetch(url + path, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new DaemonUnavailable(`the jin daemon at ${url} is not answering`);
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

export interface NotificationSettings {
  enabled: boolean;
  sound: boolean;
}
