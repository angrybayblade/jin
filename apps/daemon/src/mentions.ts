import type { IssueDetails, IssueTracker, Trackers } from "./trackers";
import type { FeedItem } from "./feed";
import { HttpError, json, type Router } from "./http";
import { normKey, parseLink } from "./links";

/**
 * Mentions in a chat: `@platform#133` (a pull request), `@PLEN-1334` (an issue in a workspace's tracker, a jin
 * task, or both: a cws change task's id is its issue's), `@REV-111701` (a jin task). Searching
 * offers what jin already knows (every machine's tasks and their PRs, the feed's PRs and
 * issues); resolving fills in the live state (gh for a PR, the issue's tracker) so the agent
 * starts from facts, and the chat shows each one as a chip.
 */

export type MentionKind = "pr" | "issue" | "task";

export interface Mention {
  /** What is written in the message, without the @: "platform#133", "PLEN-1334". */
  label: string;
  kind: MentionKind;
  /** One per thing: "github:composiohq/platform#133", "linear:PLEN-1334", "task:<machine>:<id>". */
  key: string;
  title: string | null;
  /** A PR's or issue's page; a task's page in jin (/t/<id>, /m/<machine>/t/<id>). */
  url: string | null;
  /** open, merged, In Progress, a task's Claude Code status… */
  state: string | null;
  /** One line more: checks and review, who it is assigned to, the task's PRs. */
  detail: string | null;
  /** A task's machine, as this jin names it ("local" for its own), and its name. */
  machine?: string;
  machineLabel?: string;
  /** An issue: what its tracker calls one ("Linear issue"). */
  noun?: string;
}

interface TaskLike {
  id: string;
  title: string | null;
  slug: string;
  state: string;
  archived?: boolean;
  issue?: { tracker: string; id: string; url?: string | null } | null;
  createdAt: string;
}
interface PrLike {
  taskId: string;
  url: string;
  repo: string;
  number: number;
  title: string | null;
  state: string | null;
  draft: boolean;
  review: string | null;
  checks: string | null;
}
interface TermLike {
  taskId: string | null;
  kind: string;
  status: string;
}

/** One machine's tasks, PRs and tabs (this jin's own, or one it reaches). */
export interface MachineSnapshot {
  machine: string;
  label: string;
  tasks: TaskLike[];
  prs: PrLike[];
  terminals: TermLike[];
}

export interface MentionDeps {
  /** Every reachable machine's tasks (this one's first). */
  machines: () => Promise<MachineSnapshot[]>;
  feed: () => FeedItem[];
  /** A PR's live state through gh, or null. */
  pr: (repo: string, number: number) => Promise<PrDetails | null>;
  /** Every issue tracker jin knows (to read issue links of any of them). */
  trackers: Trackers;
  /** The trackers jin's workspaces use, the first workspace's first: an id written in a message is looked for in these. */
  inUse: () => IssueTracker[];
}

export interface PrDetails {
  title: string;
  url: string;
  state: string;
  draft: boolean;
  review: string | null;
  checks: string | null;
  author: string | null;
}
export type { IssueDetails };

/** `@` then a PR (owner/repo#n, repo#n) or an id (PLEN-1334, REV-111701, VIRAJ-CTX). */
export const MENTION = /(^|[\s(])@((?:[\w.-]+\/)?[\w.-]+#\d+|[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+)(?=$|[\s),.;:!?])/g;
const PR_REF = /^(?:([\w.-]+)\/)?([\w.-]+)#(\d+)$/;

/** The mentions written in a message (each label once, in order). */
export function mentionLabels(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) if (!out.includes(m[2]!)) out.push(m[2]!);
  return out;
}

const taskPath = (machine: string, id: string) => `${machine === "local" ? "" : `/m/${machine}`}/t/${encodeURIComponent(id)}`;
const lower = (s: string) => s.toLowerCase();

function prState(p: { state: string | null; draft: boolean }): string | null {
  if (!p.state) return null;
  return p.draft && p.state === "OPEN" ? "draft" : p.state.toLowerCase();
}
function prDetail(p: { checks: string | null; review: string | null; author?: string | null }): string | null {
  const bits = [
    p.checks ? `checks ${p.checks}` : null,
    p.review ? p.review.toLowerCase().replace(/_/g, " ") : null,
    p.author ? `by ${p.author}` : null,
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : null;
}

export class Mentions {
  constructor(private deps: MentionDeps) {}

  /** What jin knows, as mentionable things (PRs, issues, tasks), newest first within each kind. */
  private async known(): Promise<{ items: Mention[]; repos: Map<string, string> }> {
    const items = new Map<string, Mention>();
    const repos = new Map<string, string>(); // "platform" -> "ComposioHQ/platform"
    const { trackers } = this.deps;
    const notePr = (repo: string) => repos.set(lower(repo.split("/")[1] ?? repo), repo);

    for (const snap of await this.deps.machines()) {
      for (const t of snap.tasks) {
        if (t.state !== "ready") continue;
        const cli = snap.terminals.filter((x) => x.taskId === t.id && x.kind === "agent").at(-1);
        const open = snap.prs.filter((p) => p.taskId === t.id);
        items.set(`task:${snap.machine}:${t.id}`, {
          label: t.id,
          kind: "task",
          key: `task:${snap.machine}:${t.id}`,
          title: t.title ?? t.slug,
          url: taskPath(snap.machine, t.id),
          state: cli ? `Claude Code ${cli.status}` : t.archived ? "archived" : "ready",
          detail: open.length ? `PRs: ${open.map((p) => `${p.repo.split("/")[1] ?? p.repo}#${p.number} (${prState(p) ?? "?"})`).join(", ")}` : null,
          machine: snap.machine,
          machineLabel: snap.label,
        });
        const key = t.issue ? `${t.issue.tracker}:${t.issue.id}` : null;
        if (t.issue && key && !items.has(key)) {
          const tracker = trackers.get(t.issue.tracker);
          items.set(key, { label: t.issue.id, kind: "issue", key, title: t.title ?? t.slug, url: t.issue.url ?? tracker?.urlOf(t.issue.id) ?? null, state: null, detail: null, noun: tracker?.noun });
        }
      }
      for (const p of snap.prs) {
        notePr(p.repo);
        const label = `${p.repo.split("/")[1] ?? p.repo}#${p.number}`;
        items.set(`github:${lower(p.repo)}#${p.number}`, { label, kind: "pr", key: `github:${lower(p.repo)}#${p.number}`, title: p.title, url: p.url, state: prState(p), detail: prDetail(p) });
      }
    }
    for (const f of this.deps.feed()) {
      const th = f.thread;
      if (!th?.url) continue;
      const gh = /github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)/.exec(th.url);
      if (gh && gh[2] === "pull") {
        notePr(gh[1]!);
        const key = `github:${lower(gh[1]!)}#${gh[3]}`;
        if (!items.has(key)) items.set(key, { label: `${gh[1]!.split("/")[1]}#${gh[3]}`, kind: "pr", key, title: th.title, url: th.url, state: null, detail: null });
        continue;
      }
      // An issue in a tracker jin knows (the link also teaches the tracker: Linear, its workspace).
      trackers.learn(th.url);
      const issue = trackers.fromUrl(th.url);
      if (issue) {
        const key = `${issue.tracker.id}:${issue.id}`;
        const known = items.get(key);
        if (!known) items.set(key, { label: issue.id, kind: "issue", key, title: th.title.replace(new RegExp(`^${issue.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "") || th.title, url: th.url, state: null, detail: null, noun: issue.tracker.noun });
        else known.url ??= th.url;
      }
    }
    // Task issues seen before their tracker learned how to link them.
    for (const m of items.values()) if (m.kind === "issue" && !m.url) m.url = trackers.ofKey(m.key)?.tracker.urlOf(m.label) ?? null;
    return { items: [...items.values()], repos };
  }

  /** Candidates for what is typed after @ (what jin knows; an exact PR or issue it does not, looked up). */
  async search(q: string, limit = 8): Promise<Mention[]> {
    const { items, repos } = await this.known();
    const query = lower(q.trim());
    const score = (m: Mention) => {
      const label = lower(m.label);
      if (!query) return 1;
      if (label === query) return 5;
      if (label.startsWith(query)) return 4;
      if (label.includes(query)) return 3;
      if (lower(m.title ?? "").includes(query)) return 2;
      return 0;
    };
    const order: Record<MentionKind, number> = { task: 0, pr: 1, issue: 2 };
    const hits = items
      .map((m) => ({ m, s: score(m) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || order[a.m.kind] - order[b.m.kind]);
    const out = hits.slice(0, limit).map((x) => x.m);
    // Typed in full, and nothing jin knows starts with it: look it up (a partial id is not looked up).
    if (query && !items.some((m) => lower(m.label).startsWith(query))) {
      const found = await this.lookup(q.trim(), repos).catch(() => []);
      out.unshift(...found);
    }
    return out.slice(0, limit);
  }

  /** The mentions in a message, with live details (the agent is told about them; the chat shows chips). */
  async resolve(text: string): Promise<Mention[]> {
    const labels = mentionLabels(text);
    if (!labels.length) return [];
    const { items, repos } = await this.known();
    const out: Mention[] = [];
    for (const label of labels) {
      const pr = PR_REF.exec(label);
      if (pr) {
        const repo = pr[1] ? `${pr[1]}/${pr[2]}` : repos.get(lower(pr[2]!));
        const live = repo ? await this.lookupPr(repo, Number(pr[3]), label) : null;
        const known = repo ? items.find((m) => m.key === `github:${lower(repo)}#${pr[3]}`) : undefined;
        if (live) out.push(live);
        else if (known) out.push({ ...known, label });
        continue;
      }
      // An id: the jin task(s) with it, and the issue with it in a tracker jin's workspaces use.
      const tasks = items.filter((m) => m.kind === "task" && m.label === label);
      out.push(...tasks);
      const issue = this.issueFor(label);
      if (issue) {
        const known = items.find((m) => m.key === `${issue.tracker.id}:${issue.id}`);
        const live = await this.lookupIssue(issue.tracker, issue.id, known);
        if (live) out.push(live);
        else if (known) out.push(known);
      }
    }
    return out;
  }

  /**
   * What a chat mentioned, newest first: links in its messages (PRs, issues,
   * Slack, Notion, mail, other pages), the @mentions jin resolved, and ids written plainly
   * (platform#133, PLEN-1334) that jin knows. Nothing is looked up: this is read after each turn.
   */
  async inChat(lines: ChatLine[]): Promise<ChatRef[]> {
    if (!lines.length) return [];
    const { items, repos } = await this.known();
    const byKey = new Map(items.map((m) => [m.key, m]));
    const threads = new Map<string, string>();
    for (const f of this.deps.feed()) if (f.thread?.key && f.thread.title) threads.set(normKey(f.thread.key), f.thread.title);
    const out = new Map<string, ChatRef>();
    const add = (seq: number, by: ChatLine["by"], r: Omit<ChatRef, "by" | "count" | "lastSeq">, seen: Set<string>) => {
      const key = normKey(r.key);
      if (seen.has(key)) return;
      seen.add(key);
      const had = out.get(key);
      if (!had) {
        out.set(key, { ...r, key, by, count: 1, lastSeq: seq });
        return;
      }
      had.count++;
      had.lastSeq = Math.max(had.lastSeq, seq);
      if (had.by !== by) had.by = "both";
      for (const f of ["title", "url", "state", "detail"] as const) had[f] ??= r[f];
    };
    const fromMention = (m: Mention): Omit<ChatRef, "by" | "count" | "lastSeq"> => ({ key: m.key, kind: m.kind, label: m.label, title: m.title, url: m.url, state: m.state, detail: m.detail, machineLabel: m.machineLabel });
    for (const line of lines) {
      const seen = new Set<string>();
      for (const m of line.mentions ?? []) add(line.seq, line.by, fromMention(m), seen);
      for (const m of line.text.matchAll(LINK)) {
        const r = refFromUrl(m[2] ?? m[3]!, m[1], this.deps.trackers);
        if (!r) continue;
        const known = byKey.get(r.key);
        add(line.seq, line.by, known ? { ...fromMention(known), url: known.url ?? r.url } : { ...r, title: r.title ?? threads.get(normKey(r.key)) ?? null, state: null, detail: null }, seen);
      }
      // Written plainly: only what jin knows (an id-looking word is not always a ticket).
      for (const m of line.text.matchAll(BARE_PR)) {
        const pr = PR_REF.exec(m[1]!);
        const repo = pr && (pr[1] ? `${pr[1]}/${pr[2]}` : repos.get(lower(pr[2]!)));
        const known = repo ? byKey.get(`github:${lower(repo)}#${pr![3]}`) : undefined;
        if (known) add(line.seq, line.by, fromMention(known), seen);
      }
      for (const m of line.text.matchAll(BARE_ID)) {
        for (const known of items.filter((x) => x.label === m[1] && x.kind !== "pr")) add(line.seq, line.by, fromMention(known), seen);
      }
    }
    return [...out.values()].sort((a, b) => b.lastSeq - a.lastSeq);
  }

  /**
   * A title for a new task given none: its issue's (when the id is one in a tracker jin's workspaces use), else
   * the first pull request's among `refs` (PR links or repo#123).
   */
  async titleFor(id: string, refs: string[] = []): Promise<{ title: string; from: "issue" | "pr" } | null> {
    const { items, repos } = await this.known();
    const issue = this.issueFor(id);
    if (issue) {
      const known = items.find((m) => m.key === `${issue.tracker.id}:${issue.id}`);
      const live = await this.lookupIssue(issue.tracker, issue.id, known);
      const title = (live?.title ?? known?.title ?? "").replace(new RegExp(`^${issue.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[:\\s-]*`, "i"), "").trim();
      if (title) return { title, from: "issue" };
    }
    for (const ref of refs) {
      const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(ref.trim());
      const short = PR_REF.exec(ref.trim());
      const repo = url ? url[1]! : short ? (short[1] ? `${short[1]}/${short[2]}` : repos.get(lower(short[2]!))) : undefined;
      const number = Number(url ? url[2] : short?.[3]);
      if (!repo || !number) continue;
      const pr = await this.lookupPr(repo, number, `${repo}#${number}`);
      const known = items.find((m) => m.key === `github:${lower(repo)}#${number}`);
      const title = pr?.title ?? known?.title;
      if (title) return { title, from: "pr" };
    }
    return null;
  }

  /** The issue an id names, in the first tracker in use it fits. */
  private issueFor(text: string): { tracker: IssueTracker; id: string } | null {
    for (const tracker of this.deps.inUse()) {
      const id = tracker.parseId(text);
      if (id) return { tracker, id };
    }
    return null;
  }

  private async lookup(q: string, repos: Map<string, string>): Promise<Mention[]> {
    const pr = PR_REF.exec(q);
    if (pr) {
      const repo = pr[1] ? `${pr[1]}/${pr[2]}` : repos.get(lower(pr[2]!));
      const m = repo ? await this.lookupPr(repo, Number(pr[3]), q) : null;
      return m ? [m] : [];
    }
    const issue = this.issueFor(q);
    if (issue) {
      const m = await this.lookupIssue(issue.tracker, issue.id);
      return m ? [m] : [];
    }
    return [];
  }

  private async lookupPr(repo: string, number: number, label: string): Promise<Mention | null> {
    const p = await this.deps.pr(repo, number).catch(() => null);
    if (!p) return null;
    return { label, kind: "pr", key: `github:${lower(repo)}#${number}`, title: p.title, url: p.url, state: prState(p), detail: prDetail(p) };
  }

  private async lookupIssue(tracker: IssueTracker, id: string, known?: Mention): Promise<Mention | null> {
    const i = tracker.lookup ? await tracker.lookup(id).catch(() => null) : null;
    if (!i) return null;
    const detail = [i.assignee ? `assigned to ${i.assignee}` : "unassigned", i.team].filter(Boolean).join(" · ");
    return { label: id, kind: "issue", key: `${tracker.id}:${id}`, title: i.title, url: i.url ?? known?.url ?? tracker.urlOf(id), state: i.state, detail, noun: tracker.noun };
  }
}

/** What a chat talked about: PRs, tickets, tasks, Slack threads, Notion pages, mail and other links. */
export type RefKind = MentionKind | "slack" | "notion" | "mail" | "link";

export interface ChatRef {
  key: string;
  kind: RefKind;
  label: string;
  title: string | null;
  url: string | null;
  state: string | null;
  detail: string | null;
  machineLabel?: string;
  /** Who brought it up: you, jin, or both. */
  by: "you" | "jin" | "both";
  /** How many messages mention it, and the last one that did (its seq). */
  count: number;
  lastSeq: number;
}

/** One message of a chat, for what it mentions. */
export interface ChatLine {
  seq: number;
  by: "you" | "jin";
  text: string;
  /** What jin resolved of the message's @mentions (live state). */
  mentions?: Mention[];
}

const LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()\[\]`"']+)/g;
const BARE_PR = /(?:^|[\s(@`])((?:[\w.-]+\/)?[A-Za-z][\w.-]*#\d+)(?=$|[\s),.;:!?`])/g;
const BARE_ID = /(?:^|[\s(@`\[])([A-Z][A-Z0-9]{1,9}-\d+)(?=$|[\s),.;:!?`\]])/g;

/** A URL as a chat ref (without who or when): what kind of thing it is, and its key. */
export function refFromUrl(raw: string, text?: string, trackers?: Trackers): Pick<ChatRef, "key" | "kind" | "label" | "title" | "url"> | null {
  const url = raw.replace(/[.,;:!?]+$/, "");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (["localhost", "127.0.0.1", "0.0.0.0"].includes(u.hostname)) return null;
  const named = text && text !== url ? text.replace(/`/g, "") : null;
  const gh = u.hostname === "github.com" ? /^\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/.exec(u.pathname) : null;
  if (gh) {
    const repo = `${gh[1]}/${gh[2]}`;
    const label = `${gh[2]}#${gh[4]}`;
    const pr = gh[3] === "pull";
    return { key: `${pr ? "github" : "github-issue"}:${lower(repo)}#${gh[4]}`, kind: pr ? "pr" : "issue", label, title: named && named !== label ? named : null, url: `https://github.com/${repo}/${gh[3]}/${gh[4]}` };
  }
  const l = parseLink(url, new Date(), trackers);
  if (l?.kind === "issue") return { key: l.key, kind: "issue", label: l.label, title: named && named !== l.label ? named : null, url };
  if (l?.kind === "slack-thread" || l?.kind === "slack-channel") return { key: l.key, kind: "slack", label: named ?? (l.kind === "slack-thread" ? "Slack thread" : "Slack channel"), title: null, url };
  if (l?.kind === "notion") return { key: l.key, kind: "notion", label: named ?? l.label, title: null, url };
  u.hash = "";
  if (u.hostname === "mail.google.com") return { key: `mail:${url}`, kind: "mail", label: named ?? "Email", title: null, url };
  const short = `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 80);
  return { key: `link:${u.toString()}`, kind: "link", label: named ?? short, title: null, url };
}

/** What the agent is told about a message's mentions (appended to the prompt it gets; the chat shows only the message). */
export function mentionContext(mentions: Mention[]): string {
  if (!mentions.length) return "";
  const line = (m: Mention) => {
    const what = m.kind === "pr" ? "pull request" : m.kind === "issue" ? (m.noun ?? "issue") : `jin task on ${m.machineLabel ?? m.machine ?? "this machine"}`;
    const bits = [m.title ? `"${m.title}"` : null, m.state, m.detail].filter(Boolean).join(" — ");
    return `- @${m.label}: ${what}${bits ? ` ${bits}` : ""}${m.url ? ` (${m.url})` : ""}`;
  };
  return [
    "",
    "<mentions>",
    "The user mentioned these (resolved by jin just now). Read more with gh, the issue tracker's tools, or jin's task tools when you need it:",
    ...mentions.map(line),
    "</mentions>",
  ].join("\n");
}

/** A chat's messages as lines to read mentions from (its prompts, their resolved @mentions, jin's replies). */
export function chatLines(events: { seq: number; kind: string; payload: Record<string, any> }[]): ChatLine[] {
  const lines: ChatLine[] = [];
  for (const e of events) {
    if (e.kind === "prompt" && typeof e.payload.text === "string") lines.push({ seq: e.seq, by: "you", text: e.payload.text });
    else if (e.kind === "message" && typeof e.payload.text === "string") lines.push({ seq: e.seq, by: "jin", text: e.payload.text });
    else if (e.kind === "prompt.mentions") {
      const u = lines.findLast((l) => l.by === "you");
      if (u) u.mentions = e.payload.mentions;
    }
  }
  return lines;
}

export function mentionRoutes(router: Router, mentions: Mentions, events?: (sessionId: string) => { seq: number; kind: string; payload: Record<string, any> }[]) {
  router
    .on("GET", "/api/sessions/:id/refs", async (_req, p) => json(events ? await mentions.inChat(chatLines(events(p.id!))) : []))
    .on("GET", "/api/mentions", async (_req, _p, url) => json(await mentions.search(url.searchParams.get("q") ?? "")))
    .on("GET", "/api/mentions/title", async (_req, _p, url) => json(await mentions.titleFor(url.searchParams.get("id") ?? "", url.searchParams.getAll("ref"))))
    .on("POST", "/api/mentions/resolve", async (req) => {
      const { text } = (await req.json().catch(() => ({}))) as { text?: string };
      if (typeof text !== "string") throw new HttpError(400, "text is required");
      return json(await mentions.resolve(text));
    });
}
