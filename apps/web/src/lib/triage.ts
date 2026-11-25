import type { FeedItem } from "./daemon";
import { groupFeed, type FeedGroup } from "./feed-groups";

/**
 * The desk's triage: each thread goes to one lane by what it asks of you, by fixed rules (so
 * the order is predictable, and every place says why).
 *
 *   needs       someone is waiting on you: a DM, a mention, your review asked for, your PR
 *               reviewed or failing, an issue assigned to you, a comment on your page, mail
 *               from a person
 *   fyi         things you are part of moved: reviews and comments on PRs you review, …
 *   background  commits, bots, automated mail: never a row of their own in the other lanes
 *
 * Within needs: people first, then your PRs, then requests; the longest wait first.
 */

export type Lane = "needs" | "fyi" | "background";

export interface Triaged extends FeedGroup {
  lane: Lane;
  /** Why it is in its lane, in plain words: "sam messaged you", "Checks failing on your PR". */
  why: string;
  /** 1 people, 2 your PRs, 3 requests (needs only). */
  tier: number;
  /** When the oldest thing still waiting on you came in (needs), else the latest. */
  since: string;
  /** A source to show (GitHub, Slack…). */
  source: string;
  /** jin's read of the thread (its most pressing item): how soon, and how bad to miss; null until triaged (the rule lane stands in). */
  bucket: Bucket;
  severity: "high" | "medium" | "low" | null;
  /** Whose it is: a task's (it follows the thread), or work or personal (jin's read). */
  group: "task" | "work" | "personal";
  owner: { taskId: string; machine: string; title: string } | null;
  hint: { taskId: string; machine: string; title: string } | null;
  /** Read at the source (Slack), not yet handled. */
  seen: boolean;
  /** Why jin judged it handled since (Probably done). */
  staleWhy: string | null;
}

export type Bucket = "now" | "today" | "later" | "ignore";

const BOT = /(\[bot\]|-bot|bot)$|^(coderabbit|github-actions|vercel|linear|devin|copilot|dependabot|renovate|codecov|sonarcloud|cursor|graphite|netlify|changeset)/i;

interface Signal {
  lane: Lane;
  tier: number;
  why: string;
}

const verbOf = (i: FeedItem) => (i.title && i.title.length < 40 ? i.title : i.kind.includes("review") ? "reviewed" : "commented");

/** One item's ask of you. `yours` are threads known to be your PRs (failing checks say so). */
function signal(i: FeedItem, yours: Set<string>): Signal {
  const who = i.actor ?? "Someone";
  const tags = new Set(i.tags ?? []);
  const key = i.thread?.key?.toLowerCase() ?? "";
  if (i.kind === "ci_failed") return { lane: "needs", tier: 2, why: "Checks failing on your PR" };
  if (i.kind === "review_requested") return { lane: "needs", tier: 3, why: "Your review is requested" };
  if (i.kind === "mention") return { lane: "needs", tier: 1, why: "You were mentioned" };
  if (i.actor && BOT.test(i.actor)) return { lane: "background", tier: 9, why: "bots" };
  if (i.kind.includes("commit") || i.title === "pushed") return { lane: "background", tier: 9, why: "commits" };
  if (tags.has("dm") || i.kind.includes("direct_message")) return { lane: "needs", tier: 1, why: `${who} messaged you` };
  if (tags.has("mention") || tags.has("mentioned")) return { lane: "needs", tier: 1, why: `${who} mentioned you` };
  if (i.source === "github" && (tags.has("authored") || yours.has(key))) return { lane: "needs", tier: 2, why: `${who} ${verbOf(i)} on your PR` };
  if (tags.has("assigned")) return { lane: "needs", tier: 3, why: "Assigned to you" };
  if (i.source === "notion") return { lane: "needs", tier: 3, why: `${i.actor ? who : "New comment"}${i.actor ? " commented" : ""}` };
  if (i.source === "gmail") return tags.has("automated") ? { lane: "background", tier: 9, why: "automated mail" } : { lane: "needs", tier: 3, why: `Email from ${who}` };
  return { lane: "fyi", tier: 5, why: `${who} ${verbOf(i)}` };
}

const RANK: Record<Lane, number> = { needs: 0, fyi: 1, background: 2 };
const BUCKET_RANK: Record<Bucket, number> = { now: 0, today: 1, later: 2, ignore: 3 };
/** Before jin has read a thread, its rule lane says how soon. */
const LANE_BUCKET: Record<Lane, Bucket> = { needs: "today", fyi: "later", background: "ignore" };
const SEV_RANK = { high: 0, medium: 1, low: 2 } as const;

/** Items as threads, each with its lane (by rule) and jin's read where it has one. */
function threads(items: FeedItem[], state: FeedItem["state"]): Triaged[] {
  const open = items.filter((i) => i.state === state);
  const yours = new Set(open.filter((i) => i.kind === "ci_failed" && i.thread).map((i) => i.thread!.key.toLowerCase()));
  const byId = new Map(open.map((i) => [i.id, i]));
  return groupFeed(open).map((g) => {
    const its = g.ids.map((id) => byId.get(id)!).filter(Boolean);
    const sigs = its.map((i) => ({ i, s: signal(i, yours) }));
    const best = sigs.reduce((a, b) => (RANK[b.s.lane] < RANK[a.s.lane] || (b.s.lane === a.s.lane && b.s.tier < a.s.tier) ? b : a));
    const waiting = sigs.filter((x) => x.s.lane === best.s.lane).map((x) => x.i.receivedAt).sort();
    // jin's read: the thread's most pressing item.
    const read = its.filter((i) => i.triage).sort((a, b) => BUCKET_RANK[a.triage!.bucket] - BUCKET_RANK[b.triage!.bucket] || SEV_RANK[a.triage!.severity] - SEV_RANK[b.triage!.severity])[0];
    const owner = its.find((i) => i.owner)?.owner ?? null;
    return {
      ...g,
      lane: best.s.lane,
      why: read?.triage?.why || best.s.why,
      tier: best.s.tier,
      since: best.s.lane === "needs" ? waiting[0]! : g.latest,
      source: its[0]?.source ?? g.source,
      bucket: read?.triage?.bucket ?? LANE_BUCKET[best.s.lane],
      severity: read?.triage?.severity ?? null,
      group: owner ? "task" : (read?.triage?.group ?? "work"),
      owner,
      hint: owner ? null : (its.find((i) => i.hint)?.hint ?? null),
      seen: its.every((i) => i.seenAt),
      staleWhy: its.find((i) => i.staleWhy)?.staleWhy ?? null,
    };
  });
}

/** Most pressing first: how soon, then how bad, then the longest wait. */
const byPriority = (a: Triaged, b: Triaged) => BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket] || (SEV_RANK[a.severity ?? "medium"] - SEV_RANK[b.severity ?? "medium"]) || Number(a.seen) - Number(b.seen) || a.since.localeCompare(b.since);

export interface DeskSection {
  /** today's (and now's, in their own group) threads, most pressing first. */
  open: Triaged[];
  /** later and ignore: folded. */
  low: Triaged[];
  /** jin judged these handled since: folded, each with why. */
  done: Triaged[];
}
export interface Desk {
  /** Needs you now, from every group. */
  now: Triaged[];
  tasks: (DeskSection & { taskId: string; machine: string; title: string })[];
  work: DeskSection;
  personal: DeskSection;
}

/** The desk: what needs you now, then each task's threads, then work and personal; low priority and probably-done folded in each. */
export function desk(items: FeedItem[]): Desk {
  const open = threads(items, "new").sort(byPriority);
  const stale = threads(items, "stale");
  const section = (pick: (t: Triaged) => boolean): DeskSection => ({
    open: open.filter((t) => pick(t) && (t.bucket === "today" || t.bucket === "now")),
    low: open.filter((t) => pick(t) && (t.bucket === "later" || t.bucket === "ignore")),
    done: stale.filter(pick),
  });
  const taskIds = [...new Map([...open, ...stale].filter((t) => t.owner).map((t) => [`${t.owner!.machine}:${t.owner!.taskId}`, t.owner!])).values()];
  return {
    now: open.filter((t) => t.bucket === "now"),
    tasks: taskIds.map((o) => ({ ...o, ...section((t) => t.owner?.taskId === o.taskId && t.owner.machine === o.machine && t.bucket !== "now") })),
    work: section((t) => t.group === "work" && t.bucket !== "now"),
    personal: section((t) => t.group === "personal" && t.bucket !== "now"),
  };
}

/** Open items as threads, each in its lane with why; lanes in their order. */
export function triage(items: FeedItem[]): Record<Lane, Triaged[]> {
  const out: Record<Lane, Triaged[]> = { needs: [], fyi: [], background: [] };
  for (const t of threads(items, "new")) out[t.lane].push(t);
  out.needs.sort((a, b) => a.tier - b.tier || a.since.localeCompare(b.since));
  return out;
}

/** "2d", "3h", "5m": how long something has waited. */
export function waited(iso: string, at = Date.now()): string {
  const s = Math.max(0, (at - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
