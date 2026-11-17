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
  /** A short reference, like platform#14988 or PLEN-4548. */
  ref: string | null;
  url: string | null;
}

export type FeedState = "new" | "snoozed" | "done" | "dismissed" | "promoted";

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
}

export type NewItem = Pick<FeedItem, "workspace" | "source" | "kind" | "externalRef" | "title" | "summary" | "receivedAt"> & { thread?: FeedThread | null; actor?: string | null };

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
});

export class Feed {
  constructor(private db: Database) {}

  list(): FeedItem[] {
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
      `insert into feed_items (id, workspace, source, kind, external_ref, title, summary, received_at, thread_key, thread_title, thread_ref, thread_url, actor)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (workspace, source, kind, external_ref) do nothing`,
    );
    let added = 0;
    this.db.transaction(() => {
      for (const i of items) {
        const t = i.thread ?? null;
        added += insert.run(randomUUID(), i.workspace, i.source, i.kind, i.externalRef, i.title, i.summary, i.receivedAt, t?.key ?? null, t?.title ?? null, t?.ref ?? null, t?.url ?? null, i.actor ?? null).changes;
      }
    })();
    return added;
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
  reviewRequested: search(query: "is:pr is:open archived:false review-requested:@me", type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
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
      out.push({ workspace: w.id, source: "github", kind, externalRef: node.url, title: node.title, summary: `${repo}#${node.number} · ${label}`, receivedAt: node.updatedAt, thread });
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

export function feedRoutes(router: Router, feed: Feed, tasks: Tasks, workspaces: WorkspaceConfig[]) {
  router
    .on("GET", "/api/feed", () => json(feed.list()))
    .on("POST", "/api/collect/github", async () => {
      const added = feed.add(await collectGithub(workspaces));
      return json({ added, total: feed.list().length });
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
