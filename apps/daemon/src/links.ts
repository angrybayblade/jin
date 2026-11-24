import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { now } from "./db";
import { githubThread, type FeedItem } from "./feed";
import { body, HttpError, json, type Router } from "./http";
import type { Trackers } from "./trackers";

/**
 * What a task follows, so events from GitHub, an issue tracker, Slack and Notion land in its
 * Activity: exact thread keys, never guesses. A task's PRs and its issue (when its workspace ties
 * tasks to issues) link by themselves; the rest are linked by hand (a URL).
 *
 *   github:owner/repo#12          a PR attached to the task          (how: pr)
 *   <tracker>:<id>                an issue: the task's, or linked     (how: issue, or manual) e.g. linear:ENG-244
 *   slack:C123:1700000000.123456  a Slack thread                     (how: manual)
 *   slack-channel:C123            threads started in it after `since` (how: manual)
 *   notion:<32 hex>               comments on a Notion page          (how: manual)
 */

export type LinkKind = "github" | "issue" | "slack-thread" | "slack-channel" | "notion" | "doc";

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

/** A link from what you paste: a Slack thread or channel, a Notion page, an issue (any tracker jin knows), a jin doc. */
export function parseLink(raw: string, at = new Date(), trackers?: Trackers): Pick<TaskLink, "key" | "kind" | "label" | "since" | "url"> | null {
  const url = raw.trim();
  // A jin doc: doc:<id>, or its page in jin (…/docs/<id>, on any of jin's addresses).
  const doc = /^doc:(d[0-9a-f]{10})$/.exec(url)?.[1] ?? /^(?:https?:\/\/[^/]+)?\/docs\/(d[0-9a-f]{10})(?:[/?#]|$)/.exec(url)?.[1];
  if (doc) return { key: `doc:${doc}`, kind: "doc", label: "jin doc", since: null, url: `/docs/${doc}` };
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
  if (/(^|\.)notion\.(so|site|com)$/.test(u.hostname)) {
    const id = /([0-9a-f]{32})(?:[^0-9a-f]|$)/i.exec(u.searchParams.get("p") ?? u.pathname)?.[1] ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(u.pathname)?.[1];
    if (!id) return null;
    const words = decodeURIComponent(u.pathname.split("/").pop() ?? "").replace(new RegExp(`-?${id}$`, "i"), "").replace(/-/g, " ").trim();
    return { key: normKey(`notion:${id}`), kind: "notion", label: words || "Notion page", since: null, url };
  }
  const issue = trackers?.fromUrl(url);
  if (issue) {
    trackers!.learn(url);
    return { key: `${issue.tracker.id}:${issue.id}`, kind: "issue", label: issue.id, since: null, url };
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
  constructor(
    private db: Database,
    private trackers?: Trackers,
  ) {}

  /** Links added by hand (the PR and issue links come with the task). */
  list(taskId?: string): TaskLink[] {
    const rows = taskId ? this.db.query("select * from task_links where task_id = ? order by added_at, rowid").all(taskId) : this.db.query("select * from task_links order by added_at, rowid").all();
    return (rows as any[]).map(toLink);
  }

  add(taskId: string, raw: string): TaskLink {
    const l = parseLink(raw, new Date(), this.trackers);
    const issues = this.trackers?.list().map((t) => t.noun).join(", ") ?? "";
    if (!l) throw new HttpError(400, `not a Slack thread or channel, Notion page, ${issues ? `${issues} ` : ""}or jin doc link: ${raw}`);
    this.db
      .query("insert into task_links (task_id, key, kind, url, label, since, added_at) values (?, ?, ?, ?, ?, ?, ?) on conflict (task_id, key) do update set url = excluded.url, label = excluded.label")
      .run(taskId, l.key, l.kind, l.url, l.label, l.since, now());
    return this.list(taskId).find((x) => x.key === l.key)!;
  }

  /** A better name for a link, once found (a Notion page's title). */
  setLabel(taskId: string, key: string, label: string) {
    this.db.query("update task_links set label = ? where task_id = ? and key = ?").run(label, taskId, key);
  }

  remove(taskId: string, key: string) {
    this.db.query("delete from task_links where task_id = ? and key = ?").run(taskId, key);
  }

  removeTask(taskId: string) {
    this.db.query("delete from task_links where task_id = ?").run(taskId);
  }
}

/** The links that come with a task: its PRs, and the issue it is for (as its workspace says). */
export function ownLinks(task: { id: string; createdAt: string; issue?: { tracker: string; id: string; url?: string | null } | null }, prs: { repo: string; number: number; url: string; title: string | null }[]): TaskLink[] {
  const out: TaskLink[] = prs.map((p) => ({ taskId: task.id, key: githubThread(p.repo, p.number, "", p.url).key, kind: "github", url: p.url, label: `${p.repo.split("/")[1] ?? p.repo}#${p.number}${p.title ? ` ${p.title}` : ""}`, since: null, how: "pr", addedAt: task.createdAt }));
  const issue = task.issue;
  if (issue) out.unshift({ taskId: task.id, key: `${issue.tracker}:${issue.id}`, kind: "issue", url: issue.url ?? null, label: issue.id, since: null, how: "issue", addedAt: task.createdAt });
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
  deps: {
    links: TaskLinks;
    linksOf: (taskId: string) => TaskLink[];
    feedItems: () => Promise<FeedItem[]>;
    changed: () => void;
    /** A link's real name where its address has none (a Notion page's title), or null. */
    title?: (l: TaskLink) => Promise<string | null>;
    /** How an agent reads an issue link (its tracker says). */
    trackers?: Trackers;
    /** For a terminal's Claude Code: its task, and the task's PRs with their state. */
    context?: { taskOf: (terminalId: string) => string | null; task: (id: string) => { id: string; kind: string; title: string | null; slug: string }; prs: (taskId: string) => { url: string; title: string | null; state: string | null; draft: boolean; checks: string | null; review: string | null }[]; journal?: (taskId: string) => string | Promise<string> };
  },
) {
  router
    // What Claude Code in a task asks for: jin-task context, or the task_context tool.
    .on("GET", "/api/terminals/:id/context", async (_req, p) => {
      const c = deps.context;
      const taskId = c?.taskOf(p.id!);
      if (!c || !taskId) throw new HttpError(404, "this terminal is not in a task");
      // With the task's journal: what every agent in it (other tabs, the room) decided, did and found.
      const text = [renderContext(c.task(taskId), deps.linksOf(taskId), c.prs(taskId), await deps.feedItems(), { trackers: deps.trackers }), await c.journal?.(taskId)].filter(Boolean).join("\n\n");
      return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
    })
    .on("GET", "/api/tasks/:id/links", (_req, p) => json(deps.linksOf(p.id!)))
    .on("POST", "/api/tasks/:id/links", async (req, p) => {
      const { url } = await body<{ url: string }>(req);
      deps.linksOf(p.id!); // the task exists
      const l = deps.links.add(p.id!, String(url ?? ""));
      const title = deps.title ? await deps.title(l).catch(() => null) : null;
      if (title) {
        deps.links.setLabel(p.id!, l.key, title);
        l.label = title;
      }
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

/** How Claude Code reads a link in full (with the tools it has). */
export function howToRead(l: Pick<TaskLink, "kind" | "key" | "url" | "since">, trackers?: Trackers): string {
  switch (l.kind) {
    case "github":
      return `gh pr view ${l.url ?? ""} --comments (and gh pr diff, gh pr checks)`.replace("  ", " ");
    case "issue": {
      const of = trackers?.ofKey(l.key);
      return of ? of.tracker.howToRead(of.id) : `the issue tracker's tools: ${l.key} and its comments${l.url ? ` (${l.url})` : ""}`;
    }
    case "slack-thread": {
      const [, channel, ts] = l.key.split(":");
      return `the Slack tools: read the thread (channel ${channel}, thread ts ${ts})`;
    }
    case "slack-channel":
      return `the Slack tools: read channel ${l.key.slice("slack-channel:".length)} (threads since ${l.since?.slice(0, 10) ?? "it was linked"})`;
    case "notion":
      return "the Notion tools: fetch the page, and its comments";
    case "doc":
      return `the read_doc tool (docId ${l.key.slice(4)}), or \`jin-task doc ${l.key.slice(4)}\``;
  }
}

const ago = (iso: string, at = Date.now()) => {
  const s = Math.max(0, (at - Date.parse(iso)) / 1000);
  return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

/**
 * A task's context as Claude Code asks for it (jin-task context, the task_context tool): what
 * it follows, each with how to read it in full, and the latest on each, one line per event.
 * Short on purpose: the full thread, issue or page is read only when the work needs it.
 */
export function renderContext(
  task: { id: string; kind: string; title: string | null; slug: string },
  links: TaskLink[],
  prs: { url: string; title: string | null; state: string | null; draft: boolean; checks: string | null; review: string | null }[],
  items: FeedItem[],
  opts: { perThread?: number; at?: number; trackers?: Trackers } = {},
): string {
  const per = opts.perThread ?? 5;
  const out: string[] = [`Task ${task.id} (${task.kind}): ${task.title ?? task.slug}`];
  if (prs.length) {
    out.push("", "Pull requests:");
    for (const p of prs) out.push(`- ${p.url}  ${p.draft ? "draft" : (p.state ?? "?").toLowerCase()}${p.checks ? `, checks ${p.checks}` : ""}${p.review ? `, ${p.review.toLowerCase().replace(/_/g, " ")}` : ""}  ${p.title ?? ""}`.trimEnd());
  }
  const rest = links.filter((l) => l.kind !== "github");
  if (rest.length) {
    out.push("", "Follows:");
    for (const l of rest) out.push(`- ${l.label}${l.url ? `  ${l.url}` : ""}\n  read: ${howToRead(l, opts.trackers)}`);
  }
  const mine = activity(links, items);
  out.push("", mine.length ? "Latest (newest first, one line each):" : "Nothing has happened on these yet (since jin started following them).");
  const threads = new Map<string, FeedItem[]>();
  for (const i of mine) {
    const k = normKey(i.thread!.key);
    threads.set(k, [...(threads.get(k) ?? []), i]);
  }
  for (const [, rows] of threads) {
    const t = rows[0]!.thread!;
    out.push(`${[t.ref, t.title].filter(Boolean).join(" ") || t.key}${t.url ? `  ${t.url}` : ""}`);
    for (const r of rows.slice(0, per)) {
      const what = [r.actor, r.title].filter(Boolean).join(" ") || r.kind;
      out.push(`  ${ago(r.receivedAt, opts.at)}  ${what}${r.summary ? `: ${r.summary.slice(0, 160)}` : ""}`);
    }
    if (rows.length > per) out.push(`  … ${rows.length - per} earlier`);
  }
  return out.join("\n");
}
