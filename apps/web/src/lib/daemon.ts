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
}

export type SessionState = "running" | "waiting_approval" | "idle" | "failed" | "interrupted";

export interface Session {
  id: string;
  taskId: string;
  harness: string;
  harnessSessionId: string | null;
  state: SessionState;
  createdAt: string;
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
