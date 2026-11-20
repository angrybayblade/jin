import type { FeedItem } from "./daemon";

/** A feed thread with its items, newest first: a PR or issue, a Slack thread or DM, a Notion page, a mail thread. */
export interface FeedGroup {
  key: string;
  source: string;
  title: string;
  ref: string | null;
  url: string | null;
  latest: string;
  rows: FeedRow[];
  ids: string[];
}

/** One line in a group: an item, or every item in the thread by the same person doing the same thing. */
export interface FeedRow {
  id: string;
  ids: string[];
  actor: string | null;
  what: string;
  /** The item's kind, for the collector's own rows (review requested, checks failing, mention). */
  kind: string | null;
  snippet: string;
  url: string;
  at: string;
  count: number;
}

const COLLECTOR_KINDS: Record<string, string> = { review_requested: "Review requested", ci_failed: "Checks failing", mention: "You were mentioned" };
const GH = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/;
// Before threads, live items read "Comment by alex on Org/repo#12 Title (reviewing)".
const LEGACY = /^(.*?) on ([\w.-]+\/[\w.-]+)#(\d+) (.*?)(?: \(reviewing\))?$/;

function threadOf(i: FeedItem): Pick<FeedGroup, "key" | "title" | "ref" | "url"> & { what?: string; actor?: string | null } {
  if (i.thread) return i.thread;
  // Older live items: the PR is in the title ("New commit by x on Org/repo#12 Title"), even when the link is a commit.
  const legacy = LEGACY.exec(i.title);
  const gh = GH.exec(i.externalRef);
  const repo = legacy?.[2] ?? gh?.[1];
  const num = legacy?.[3] ?? gh?.[2];
  if (repo && num) {
    const base = { key: `github:${repo.toLowerCase()}#${num}`, ref: `${repo.split("/")[1]}#${num}`, url: `https://github.com/${repo}/pull/${num}` };
    if (legacy) {
      const m = /^(.*) by (\S+)$/.exec(legacy[1]!);
      const verb = (m?.[1] ?? legacy[1]!).toLowerCase();
      const what = verb === "new commit" ? "pushed" : verb === "comment" ? "commented" : verb === "review" ? "reviewed" : verb === "approved" ? "approved" : verb === "changes requested" ? "requested changes" : verb;
      return { ...base, title: legacy[4]!, what, actor: m?.[2] ?? null };
    }
    return { ...base, title: i.title };
  }
  return { key: i.id, title: i.title, ref: null, url: i.externalRef.startsWith("http") ? i.externalRef : null };
}

/** Older items kept raw markup from bots; the daemon cleans new ones. */
const tidy = (s: string) =>
  s
    .replace(/<!--[\s\S]*?(-->|$)/g, " ")
    .replace(/<[^>]*>?/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Open items grouped by thread; groups and rows newest first; repeats (same person, same action) fold together. */
export function groupFeed(items: FeedItem[]): FeedGroup[] {
  const groups = new Map<string, FeedGroup>();
  const sorted = [...items].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  for (const i of sorted) {
    const t = threadOf(i);
    let g = groups.get(t.key);
    if (!g) {
      g = { key: t.key, source: i.source, title: t.title, ref: t.ref, url: t.url, latest: i.receivedAt, rows: [], ids: [] };
      groups.set(t.key, g);
    } else if (g.title.endsWith("…") && !t.title.endsWith("…")) g.title = t.title; // older items cut titles short
    g.ids.push(i.id);
    const collector = COLLECTOR_KINDS[i.kind];
    const row: FeedRow = {
      id: i.id,
      ids: [i.id],
      actor: i.actor ?? t.actor ?? null,
      what: collector ?? t.what ?? i.title,
      kind: collector ? i.kind : null,
      snippet: collector ? "" : tidy(i.summary),
      url: i.externalRef.startsWith("http") ? i.externalRef : (t.url ?? ""),
      at: i.receivedAt,
      count: 1,
    };
    const prev = row.actor ? g.rows.find((r) => r.actor === row.actor && r.what === row.what) : undefined;
    if (prev) {
      prev.ids.push(i.id);
      prev.count++;
    } else g.rows.push(row);
  }
  return [...groups.values()];
}

/** "pushed 5 commits", "commented ×3". */
export function rowWhat(r: FeedRow): string {
  if (r.count === 1) return r.what;
  if (!r.what) return `${r.count} messages`;
  if (r.what === "pushed") return `pushed ${r.count} commits`;
  return `${r.what} ×${r.count}`;
}
