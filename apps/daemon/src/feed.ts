import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { WorkspaceConfig } from "./config";
import { now } from "./db";
import { body, HttpError, json, type Router } from "./http";
import type { Tasks } from "./tasks";

/** What an item belongs to: a PR or issue, a Linear issue, a Slack thread or DM, a Notion page, a mail thread. */
export interface FeedThread {
  key: string;
  title: string;
  /** A short reference, like api#14988 or ENG-4548. */
  ref: string | null;
  url: string | null;
}

/** stale: jin judged its ask handled since (answered, resolved by someone else, overtaken); one click reopens it. */
export type FeedState = "new" | "snoozed" | "done" | "dismissed" | "promoted" | "stale";

/** jin's read of an item: how soon (now, today, later, ignore), how bad to miss, what it asks, whose it is. */
export interface ItemTriage {
  bucket: "now" | "today" | "later" | "ignore";
  severity: "high" | "medium" | "low";
  action: "reply" | "review" | "read" | "none";
  group: "work" | "personal";
  why: string;
  /** A jin task it seems to belong to, when no link says so (a suggestion for you to confirm). */
  taskHint: string | null;
}

export interface FeedItem {
  id: string;
  workspace: string;
  source: "github" | "linear" | "slack" | "gmail" | "notion" | "jin";
  kind: string;
  externalRef: string;
  title: string;
  summary: string;
  receivedAt: string;
  seenAt: string | null;
  snoozedUntil: string | null;
  priority: { score: number; why: string } | null;
  state: FeedState;
  taskId: string | null;
  thread: FeedThread | null;
  actor: string | null;
  /** Why it might concern you: authored, reviewer, team-review, requested, mentioned, dm, mention, person, assigned, comment… */
  tags: string[];
  triage: ItemTriage | null;
  /** Why jin marked it stale. */
  staleWhy: string | null;
  /** Source details for checks (Slack: channel, ts, threadTs). */
  meta: Record<string, string> | null;
  /** The jin task it belongs to (a task follows its thread, PR, issue or page), added when listed. */
  owner?: { taskId: string; machine: string; title: string } | null;
  /** The task jin's triage suggests it belongs to (no link says so yet), with its machine, added when listed. */
  hint?: { taskId: string; machine: string; title: string } | null;
}

export type NewItem = Pick<FeedItem, "workspace" | "source" | "kind" | "externalRef" | "title" | "summary" | "receivedAt"> & { thread?: FeedThread | null; actor?: string | null; tags?: string[]; meta?: Record<string, string> };

/** What a PR's thread holds that is over once the PR is (merged, closed, or no longer watched). */
const PR_KINDS = new Set(["github_pr_comment", "github_pr_review", "github_pr_commit", "review_requested", "ci_failed"]);

const toItem = (r: any): FeedItem => ({
  id: r.id,
  workspace: r.workspace,
  source: r.source,
  kind: r.kind,
  externalRef: r.external_ref,
  title: r.title,
  summary: r.summary,
  receivedAt: r.received_at,
  seenAt: r.seen_at,
  snoozedUntil: r.snoozed_until,
  priority: r.priority_score == null ? null : { score: r.priority_score, why: r.priority_why ?? "" },
  state: r.state,
  taskId: r.task_id,
  thread: r.thread_key ? { key: r.thread_key, title: r.thread_title ?? "", ref: r.thread_ref ?? null, url: r.thread_url ?? null } : null,
  actor: r.actor ?? null,
  tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
  triage: r.bucket ? { bucket: r.bucket, severity: r.severity ?? "low", action: r.action ?? "none", group: r.grp === "personal" ? "personal" : "work", why: r.priority_why ?? "", taskHint: r.task_hint ?? null } : null,
  staleWhy: r.stale_why ?? null,
  meta: r.meta ? (JSON.parse(r.meta) as Record<string, string>) : null,
});

const SCORE = { now: 3, today: 2, later: 1, ignore: 0 } as const;
const SEVERITY = { high: 0.3, medium: 0.2, low: 0.1 } as const;

export class Feed {
  constructor(private db: Database) {}

  list(): FeedItem[] {
    // A snooze that has run out: the item is back.
    // Back from snooze: not read at its source as far as jin knows (snoozing stamped seen_at).
    this.db.query("update feed_items set state = 'new', seen_at = null where state = 'snoozed' and snoozed_until <= ?").run(now());
    return this.db.query("select * from feed_items order by received_at desc, id").all().map(toItem);
  }

  get(id: string): FeedItem {
    const row = this.db.query("select * from feed_items where id = ?").get(id);
    if (!row) throw new HttpError(404, `unknown feed item ${id}`);
    return toItem(row);
  }

  /** Adds items not seen before (same workspace, source, kind and external ref); returns how many were new. */
  add(items: NewItem[]): number {
    const insert = this.db.query(
      `insert into feed_items (id, workspace, source, kind, external_ref, title, summary, received_at, thread_key, thread_title, thread_ref, thread_url, actor, tags, meta)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (workspace, source, kind, external_ref) do nothing`,
    );
    let added = 0;
    this.db.transaction(() => {
      for (const i of items) {
        const t = i.thread ?? null;
        added += insert.run(randomUUID(), i.workspace, i.source, i.kind, i.externalRef, i.title, i.summary, i.receivedAt, t?.key ?? null, t?.title ?? null, t?.ref ?? null, t?.url ?? null, i.actor ?? null, i.tags?.length ? JSON.stringify(i.tags) : null, i.meta ? JSON.stringify(i.meta) : null).changes;
      }
    })();
    return added;
  }

  // ---------------------------------------------------------------- triage and life cycle

  /** Open items jin has not read yet, oldest first. */
  untriaged(limit = 10): FeedItem[] {
    return (this.db.query("select * from feed_items where state = 'new' and triaged_at is null order by received_at limit ?").all(limit) as any[]).map(toItem);
  }

  /** jin's read of an item: its priority (now 3 … ignore 0, severity breaking ties) and why. */
  setTriage(id: string, t: ItemTriage) {
    this.db
      .query("update feed_items set bucket = ?, severity = ?, action = ?, grp = ?, task_hint = ?, priority_score = ?, priority_why = ?, triaged_at = ? where id = ?")
      .run(t.bucket, t.severity, t.action, t.group, t.taskHint, SCORE[t.bucket] + SEVERITY[t.severity], t.why.slice(0, 200), now(), id);
  }

  /** Read at the source (Slack's read marker passed it). Returns how many were newly seen. */
  markSeen(ids: string[]): number {
    const q = this.db.query("update feed_items set seen_at = ? where id = ? and seen_at is null");
    let n = 0;
    this.db.transaction(() => ids.forEach((id) => (n += q.run(now(), id).changes)))();
    return n;
  }

  /** Its ask was handled since (jin's judgment, with why): out of the way, one click to reopen. */
  markStale(id: string, why: string) {
    this.db.query("update feed_items set state = 'stale', stale_why = ?, checked_at = ? where id = ? and state = 'new'").run(why.slice(0, 200), now(), id);
  }

  /** Not handled after all: back to open (and not judged again for a while). */
  reopen(id: string): FeedItem {
    this.db.query("update feed_items set state = 'new', stale_why = null, seen_at = null, checked_at = ? where id = ? and state in ('stale', 'done', 'dismissed')").run(now(), id);
    return this.get(id);
  }

  /** Open items whose ask may have been handled: seen at the source and not checked since, or older than `olderThan` and not checked in that long. */
  toCheck(olderThan: string, limit = 8): FeedItem[] {
    return (
      this.db
        .query("select * from feed_items where state = 'new' and ((seen_at is not null and (checked_at is null or checked_at < seen_at)) or (received_at < ? and (checked_at is null or checked_at < ?))) order by received_at limit ?")
        .all(olderThan, olderThan, limit) as any[]
    ).map(toItem);
  }

  checked(id: string) {
    this.db.query("update feed_items set checked_at = ? where id = ?").run(now(), id);
  }

  /** What came later in an item's thread (other items), oldest first. */
  laterInThread(item: FeedItem): FeedItem[] {
    if (!item.thread) return [];
    return (this.db.query("select * from feed_items where thread_key = ? and received_at > ? and id != ? order by received_at limit 20").all(item.thread.key, item.receivedAt, item.id) as any[]).map(toItem);
  }

  /** A name learned for an id (a Slack user or channel): past items of that source show it too. */
  rename(source: FeedItem["source"], id: string, name: string) {
    if (!id || !name || id === name) return;
    const sub = (col: string) => `${col} = replace(${col}, ?, ?)`;
    this.db
      .query(`update feed_items set actor = case when actor = ? then ? else actor end, ${sub("thread_title")}, ${sub("summary")}, ${sub("title")} where source = ? and (actor = ? or thread_title like ? or summary like ? or title like ?)`)
      .run(id, name, id, name, id, name, id, name, source, id, `%${id}%`, `%${id}%`, `%${id}%`);
  }

  /** Re-read an item: where it belongs, who did it and what it says (e.g. once names are looked up). */
  reread(id: string, e: { thread: FeedThread | null; actor: string | null; summary: string; externalRef?: string }) {
    this.db
      .query("update feed_items set thread_key = ?, thread_title = ?, thread_ref = ?, thread_url = ?, actor = ?, summary = ?, external_ref = coalesce(?, external_ref) where id = ?")
      .run(e.thread?.key ?? null, e.thread?.title ?? null, e.thread?.ref ?? null, e.thread?.url ?? null, e.actor, e.summary, e.externalRef ?? null, id);
  }

  /** You acted on a thread (replied, reviewed): what came in on it before then is done. */
  clearThread(key: string, before: string = now()): number {
    return this.db.query("update feed_items set state = 'done', seen_at = coalesce(seen_at, ?) where thread_key = ? and state in ('new', 'snoozed') and received_at <= ?").run(now(), key, before).changes;
  }

  /** PRs still open and watched: open PR items on any other PR are over (merged, closed, gone quiet). */
  settlePrs(open: Set<string>): number {
    const stale = this.db
      .query("select id, kind, thread_key from feed_items where state in ('new', 'snoozed') and source = 'github' and thread_key like 'github:%'")
      .all()
      .filter((r: any) => PR_KINDS.has(r.kind) && !open.has(String(r.thread_key).toLowerCase())) as { id: string }[];
    const done = this.db.query("update feed_items set state = 'done', seen_at = coalesce(seen_at, ?) where id = ?");
    this.db.transaction(() => stale.forEach((r) => done.run(now(), r.id)))();
    return stale.length;
  }

  /** What the collector says no longer holds (a review given, checks green again): done. */
  settleCollected(kinds: string[], still: Set<string>): number {
    const open = this.db.query(`select id, thread_key from feed_items where state in ('new', 'snoozed') and kind in (${kinds.map(() => "?").join(",")})`).all(...kinds) as { id: string; thread_key: string | null }[];
    const gone = open.filter((r) => r.thread_key && !still.has(r.thread_key.toLowerCase()));
    const done = this.db.query("update feed_items set state = 'done', seen_at = coalesce(seen_at, ?) where id = ?");
    this.db.transaction(() => gone.forEach((r) => done.run(now(), r.id)))();
    return gone.length;
  }

  /** A fresh start: everything still open that came in before `before` is done (kept, not deleted). */
  sweep(before: string): number {
    return this.db.query("update feed_items set state = 'done', seen_at = coalesce(seen_at, ?) where state in ('new', 'snoozed') and received_at < ?").run(now(), before).changes;
  }

  setState(id: string, state: FeedState, extra: { snoozedUntil?: string; taskId?: string } = {}): FeedItem {
    this.get(id);
    this.db
      .query("update feed_items set state = ?, snoozed_until = coalesce(?, snoozed_until), task_id = coalesce(?, task_id), seen_at = coalesce(seen_at, ?) where id = ?")
      .run(state, extra.snoozedUntil ?? null, extra.taskId ?? null, now(), id);
    return this.get(id);
  }
}

// ---------------------------------------------------------------- GitHub

const PR_FIELDS = "__typename number title url updatedAt repository { nameWithOwner } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";
export const GITHUB_QUERY = `query {
  reviewRequested: search(query: "is:pr is:open archived:false user-review-requested:@me", type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
  authored: search(query: "is:pr is:open archived:false author:@me", type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
  mentions: search(query: "is:open archived:false mentions:@me", type: ISSUE, first: 50) { nodes {
    ... on Issue { __typename number title url updatedAt repository { nameWithOwner } }
    ... on PullRequest { __typename number title url updatedAt repository { nameWithOwner } }
  } }
}`;

interface GhNode {
  __typename?: string;
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  repository: { nameWithOwner: string };
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

/** A PR or issue as a feed thread (the same key whether it came from the collector or the watch). */
export function githubThread(repo: string, number: number, title: string, url: string): FeedThread {
  return { key: `github:${repo.toLowerCase()}#${number}`, title, ref: `${repo.split("/")[1] ?? repo}#${number}`, url: url.replace(/#.*$/, "") };
}

const FAILING = new Set(["FAILURE", "ERROR"]);
const COLLECTED_TAGS: Record<string, string[]> = { review_requested: ["reviewer", "requested"], ci_failed: ["authored"], mention: ["mentioned"] };

/** Normalise one GraphQL response into feed items for the workspaces whose GitHub owners match. */
export function githubItems(data: Record<string, { nodes: GhNode[] } | undefined>, workspaces: WorkspaceConfig[]): NewItem[] {
  const out: NewItem[] = [];
  const add = (node: GhNode, kind: string, label: string) => {
    if (!node?.url) return;
    const repo = node.repository.nameWithOwner;
    const owner = repo.split("/")[0]!.toLowerCase();
    for (const w of workspaces) {
      const owners = w.github.owners.map((o) => o.toLowerCase());
      if (owners.length && !owners.includes(owner)) continue;
      const thread = githubThread(repo, node.number, node.title, node.url);
      out.push({ workspace: w.id, source: "github", kind, externalRef: node.url, title: node.title, summary: `${repo}#${node.number} · ${label}`, receivedAt: node.updatedAt, thread, tags: COLLECTED_TAGS[kind] });
    }
  };
  for (const n of data.reviewRequested?.nodes ?? []) add(n, "review_requested", "review requested");
  for (const n of data.authored?.nodes ?? []) {
    const state = n.commits?.nodes[0]?.commit.statusCheckRollup?.state;
    if (state && FAILING.has(state)) add(n, "ci_failed", "checks failing on your PR");
  }
  for (const n of data.mentions?.nodes ?? []) add(n, "mention", "you were mentioned");
  return out;
}

export async function collectGithub(workspaces: WorkspaceConfig[]): Promise<NewItem[]> {
  const proc = Bun.spawn(["gh", "api", "graphql", "-f", `query=${GITHUB_QUERY}`], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new HttpError(502, `gh api graphql failed (${code}): ${err.trim().slice(-1000)}`);
  const parsed = JSON.parse(out) as { data?: Record<string, { nodes: GhNode[] }>; errors?: { message: string }[] };
  if (!parsed.data) throw new HttpError(502, `gh api graphql: ${parsed.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
  return githubItems(parsed.data, workspaces);
}

// ---------------------------------------------------------------- routes

export function feedRoutes(router: Router, feed: Feed, tasks: Tasks, workspaces: WorkspaceConfig[], annotate?: (item: FeedItem) => Pick<FeedItem, "owner" | "hint">) {
  router
    // Each item with the task it belongs to (as tasks follow things now), and the one triage suggests.
    .on("GET", "/api/feed", () => json(annotate ? feed.list().map((i) => ({ ...i, ...annotate(i) })) : feed.list()))
    .on("POST", "/api/feed/:id/reopen", (_req, p) => json(feed.reopen(p.id!)))
    .on("POST", "/api/collect/github", async () => {
      const items = await collectGithub(workspaces);
      const added = feed.add(items);
      // A review you gave, checks green again: the collector no longer lists it, so it is done.
      const still = new Set(items.filter((i) => i.thread).map((i) => i.thread!.key.toLowerCase()));
      feed.settleCollected(["review_requested", "ci_failed"], still);
      return json({ added, total: feed.list().length });
    })
    .on("POST", "/api/feed/sweep", async (req) => {
      const { before } = await body<{ before?: string }>(req);
      if (!before || Number.isNaN(Date.parse(before))) throw new HttpError(400, "before must be an ISO date");
      return json({ cleared: feed.sweep(new Date(before).toISOString()) });
    })
    .on("POST", "/api/feed/:id/snooze", async (req, p) => {
      const { until } = await body<{ until?: string }>(req);
      if (!until || Number.isNaN(Date.parse(until))) throw new HttpError(400, "until must be an ISO date");
      return json(feed.setState(p.id!, "snoozed", { snoozedUntil: new Date(until).toISOString() }));
    })
    .on("POST", "/api/feed/:id/dismiss", (_req, p) => json(feed.setState(p.id!, "dismissed")))
    .on("POST", "/api/feed/:id/done", (_req, p) => json(feed.setState(p.id!, "done")))
    .on("POST", "/api/feed/:id/promote", async (req, p) => {
      const item = feed.get(p.id!);
      if (item.state === "promoted") throw new HttpError(409, `already promoted to ${item.taskId}`);
      const spec = await body<{ taskId: string; type?: string; repos: string[]; slug?: string }>(req);
      const task = await tasks.start(item.workspace, { id: spec.taskId, type: spec.type, repos: spec.repos, slug: spec.slug ?? item.title }, item.id);
      feed.setState(item.id, "promoted", { taskId: task.id });
      return json(task, 201);
    });
}
