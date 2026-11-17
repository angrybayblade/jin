import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { now } from "./db";
import { githubThread, type FeedItem } from "./feed";
import { body, HttpError, json, type Router } from "./http";

/**
 * What a task follows, so events from GitHub, Linear, Slack and Notion land in its Activity:
 * exact thread keys, never guesses. A task's PRs and (for a Linear task) its issue link by
 * themselves; Slack threads, Slack channels and Notion pages are linked by hand (a URL).
 *
 *   github:owner/repo#12          a PR attached to the task          (how: pr)
 *   linear:PLEN-244               the task's own issue               (how: issue)
 *   slack:C123:1700000000.123456  a Slack thread                     (how: manual)
 *   slack-channel:C123            threads started in it after `since` (how: manual)
 *   notion:<32 hex>               comments on a Notion page          (how: manual)
 */

export type LinkKind = "github" | "linear" | "slack-thread" | "slack-channel" | "notion";

export interface TaskLink {
  taskId: string;
  key: string;
  kind: LinkKind;
  url: string | null;
  label: string;
  /** A channel link takes threads started from this time. */
  since: string | null;
  how: "manual" | "pr" | "issue";
  addedAt: string;
}

/** The same thread whatever way its key was written (Notion ids with or without dashes). */
export function normKey(key: string): string {
  if (key.startsWith("notion:")) return `notion:${key.slice(7).replace(/-/g, "").toLowerCase()}`;
  if (key.startsWith("github:")) return key.toLowerCase();
  return key;
}

/** A link from what you paste: a Slack thread or channel, a Notion page, a Linear issue. */
export function parseLink(raw: string, at = new Date()): Pick<TaskLink, "key" | "kind" | "label" | "since" | "url"> | null {
  const url = raw.trim();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname.endsWith("slack.com")) {
    const m = /\/archives\/([CGD][A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?/.exec(u.pathname);
    if (!m) return null;
    const channel = m[1]!;
    // A reply's link names its thread in thread_ts; a root message's ts is the thread's.
    const ts = u.searchParams.get("thread_ts") ?? (m[2] ? `${m[2]}.${m[3]}` : null);
    if (ts) return { key: `slack:${channel}:${ts}`, kind: "slack-thread", label: `Slack thread in ${channel}`, since: null, url };
    return { key: `slack-channel:${channel}`, kind: "slack-channel", label: `Slack channel ${channel}`, since: at.toISOString(), url };
  }
  if (u.hostname.endsWith("notion.so") || u.hostname.endsWith("notion.site")) {
    const id = /([0-9a-f]{32})(?:[^0-9a-f]|$)/i.exec(u.searchParams.get("p") ?? u.pathname)?.[1] ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(u.pathname)?.[1];
    if (!id) return null;
    const words = decodeURIComponent(u.pathname.split("/").pop() ?? "").replace(new RegExp(`-?${id}$`, "i"), "").replace(/-/g, " ").trim();
    return { key: normKey(`notion:${id}`), kind: "notion", label: words || "Notion page", since: null, url };
  }
  if (u.hostname === "linear.app") {
    const m = /\/issue\/([A-Z][A-Z0-9]*-\d+)/.exec(u.pathname);
    return m ? { key: `linear:${m[1]}`, kind: "linear", label: m[1]!, since: null, url } : null;
  }
  return null;
}

/** Whether a feed item belongs to a link. */
export function belongs(item: Pick<FeedItem, "thread">, link: Pick<TaskLink, "key" | "kind" | "since">): boolean {
  const key = item.thread?.key ? normKey(item.thread.key) : null;
  if (!key) return false;
  if (link.kind === "slack-channel") {
    const channel = link.key.slice("slack-channel:".length);
    const m = new RegExp(`^slack:${channel}:(\\d+(?:\\.\\d+)?)$`).exec(key);
    return Boolean(m && (!link.since || Number(m[1]) * 1000 >= Date.parse(link.since)));
  }
  return key === normKey(link.key);
}

const toLink = (r: any): TaskLink => ({ taskId: r.task_id, key: r.key, kind: r.kind, url: r.url, label: r.label, since: r.since, how: "manual", addedAt: r.added_at });

export class TaskLinks {
  constructor(private db: Database) {}

  /** Links added by hand (the PR and issue links come with the task). */
  list(taskId?: string): TaskLink[] {
    const rows = taskId ? this.db.query("select * from task_links where task_id = ? order by added_at, rowid").all(taskId) : this.db.query("select * from task_links order by added_at, rowid").all();
    return (rows as any[]).map(toLink);
  }

  add(taskId: string, raw: string): TaskLink {
    const l = parseLink(raw);
    if (!l) throw new HttpError(400, `not a Slack thread or channel, Notion page or Linear issue link: ${raw}`);
    this.db
      .query("insert into task_links (task_id, key, kind, url, label, since, added_at) values (?, ?, ?, ?, ?, ?, ?) on conflict (task_id, key) do update set url = excluded.url, label = excluded.label")
      .run(taskId, l.key, l.kind, l.url, l.label, l.since, now());
    return this.list(taskId).find((x) => x.key === l.key)!;
  }

  remove(taskId: string, key: string) {
    this.db.query("delete from task_links where task_id = ? and key = ?").run(taskId, key);
  }

  removeTask(taskId: string) {
    this.db.query("delete from task_links where task_id = ?").run(taskId);
  }
}

/** The links that come with a task: its PRs, and a Linear task's own issue. */
export function ownLinks(task: { id: string; kind: string; createdAt: string }, prs: { repo: string; number: number; url: string; title: string | null }[]): TaskLink[] {
  const out: TaskLink[] = prs.map((p) => ({ taskId: task.id, key: githubThread(p.repo, p.number, "", p.url).key, kind: "github", url: p.url, label: `${p.repo.split("/")[1] ?? p.repo}#${p.number}${p.title ? ` ${p.title}` : ""}`, since: null, how: "pr", addedAt: task.createdAt }));
  if (task.kind !== "review" && /^[A-Z][A-Z0-9]*-\d+$/.test(task.id)) out.unshift({ taskId: task.id, key: `linear:${task.id}`, kind: "linear", url: null, label: task.id, since: null, how: "issue", addedAt: task.createdAt });
  return out;
}

/**
 * On the home (where events are read): the Slack threads and channels tasks follow, per
 * machine. Slack messages there that neither DM nor mention you are kept when they are in one
 * (for the task's Activity), without notifying.
 */
export class Watches {
  private file: string;
  private byMachine: Record<string, string[]>;
  constructor(home: string) {
    this.file = join(home, "watched-threads.json");
    try {
      this.byMachine = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
    } catch {
      this.byMachine = {};
    }
  }
  set(machine: string, keys: string[]) {
    this.byMachine[machine] = [...new Set(keys)].filter((k) => k.startsWith("slack:") || k.startsWith("slack-channel:"));
    writeFileSync(this.file, JSON.stringify(this.byMachine, null, 1));
  }
  all(): string[] {
    return [...new Set(Object.values(this.byMachine).flat())];
  }
  /** Is a Slack thread (its key, in this channel) followed by a task? */
  watched(threadKey: string, channel: string): boolean {
    const keys = this.all();
    return keys.includes(threadKey) || keys.includes(`slack-channel:${channel}`);
  }
}

export function watchRoutes(router: Router, watches: Watches) {
  router
    .on("GET", "/api/feed/watches", () => json({ keys: watches.all() }))
    .on("PUT", "/api/feed/watches", async (req) => {
      const b = await body<{ machine?: string; keys: string[] }>(req);
      if (!Array.isArray(b.keys)) throw new HttpError(400, "keys: thread keys");
      watches.set(b.machine || "local", b.keys.map(String));
      return json({ keys: watches.all() });
    });
}

/** A task's links and what arrived on them (feed items, newest first). */
export function activity(links: TaskLink[], items: FeedItem[]): FeedItem[] {
  return items.filter((i) => links.some((l) => belongs(i, l))).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export function linkRoutes(
  router: Router,
  deps: { links: TaskLinks; linksOf: (taskId: string) => TaskLink[]; feedItems: () => Promise<FeedItem[]>; changed: () => void },
) {
  router
    .on("GET", "/api/tasks/:id/links", (_req, p) => json(deps.linksOf(p.id!)))
    .on("POST", "/api/tasks/:id/links", async (req, p) => {
      const { url } = await body<{ url: string }>(req);
      deps.linksOf(p.id!); // the task exists
      const l = deps.links.add(p.id!, String(url ?? ""));
      deps.changed();
      return json(l, 201);
    })
    .on("DELETE", "/api/tasks/:id/links", (_req, p, url) => {
      deps.links.remove(p.id!, url.searchParams.get("key") ?? "");
      deps.changed();
      return json({ removed: true });
    })
    .on("GET", "/api/tasks/:id/activity", async (_req, p) => {
      const links = deps.linksOf(p.id!);
      return json({ links, items: activity(links, await deps.feedItems()) });
    });
}
