import type { FeedItem } from "./daemon";

/** A feed thread with its items, newest first: a PR or issue, a Linear issue, a Slack thread or DM, a Notion page, a mail thread. */
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

/** One line in a group: an item, or several in a row by the same person doing the same thing. */
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
  const gh = GH.exec(i.externalRef);
  const legacy = LEGACY.exec(i.title);
  if (gh) {
    const [, repo, num] = gh as unknown as [string, string, string];
    const url = `https://github.com/${repo}/pull/${num}`;
    const ref = `${repo.split("/")[1]}#${num}`;
    if (legacy) {
      const m = /^(.*) by (\S+)$/.exec(legacy[1]!);
      return { key: `github:${repo.toLowerCase()}#${num}`, title: legacy[4]!.replace(/…$/, ""), ref, url, what: (m?.[1] ?? legacy[1]!).toLowerCase(), actor: m?.[2] ?? null };
    }
    return { key: `github:${repo.toLowerCase()}#${num}`, title: i.title, ref, url };
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

/** Open items grouped by thread; groups and rows newest first; repeats in a row fold together. */
export function groupFeed(items: FeedItem[]): FeedGroup[] {
  const groups = new Map<string, FeedGroup>();
  const sorted = [...items].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  for (const i of sorted) {
    const t = threadOf(i);
    let g = groups.get(t.key);
    if (!g) {
      g = { key: t.key, source: i.source, title: t.title, ref: t.ref, url: t.url, latest: i.receivedAt, rows: [], ids: [] };
      groups.set(t.key, g);
    }
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
    const prev = g.rows.at(-1);
    if (prev && prev.actor === row.actor && prev.what === row.what && row.actor) {
      prev.ids.push(i.id);
      prev.count++;
    } else g.rows.push(row);
  }
  return [...groups.values()];
}

/** "pushed 5 commits", "commented ×3". */
export function rowWhat(r: FeedRow): string {
  if (r.count === 1) return r.what;
  if (r.what === "pushed") return `pushed ${r.count} commits`;
  return `${r.what} ×${r.count}`;
}
