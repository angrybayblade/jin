import type { FeedItem } from "./feed";
import { HttpError, json, type Router } from "./http";

/**
 * Mentions in a chat: `@platform#133` (a pull request), `@PLEN-1334` (a Linear issue, a jin
 * task, or both: a cws change task's id is its issue's), `@REV-111701` (a jin task). Searching
 * offers what jin already knows (every machine's tasks and their PRs, the GitHub and Linear
 * feed); resolving fills in the live state (gh for a PR, Linear through Composio) so the agent
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
  /** A Linear issue's live state (through Composio), or null. */
  issue: (id: string) => Promise<IssueDetails | null>;
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
export interface IssueDetails {
  title: string;
  url?: string | null;
  state: string | null;
  assignee: string | null;
  team: string | null;
}

/** `@` then a PR (owner/repo#n, repo#n) or an id (PLEN-1334, REV-111701, VIRAJ-CTX). */
export const MENTION = /(^|[\s(])@((?:[\w.-]+\/)?[\w.-]+#\d+|[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+)(?=$|[\s),.;:!?])/g;
const PR_REF = /^(?:([\w.-]+)\/)?([\w.-]+)#(\d+)$/;
const ISSUE_ID = /^[A-Z][A-Z0-9]*-\d+$/;

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
  private async known(): Promise<{ items: Mention[]; repos: Map<string, string>; linearOrg: string | null }> {
    const items = new Map<string, Mention>();
    const repos = new Map<string, string>(); // "platform" -> "ComposioHQ/platform"
    let linearOrg: string | null = null;
    const notePr = (repo: string) => repos.set(lower(repo.split("/")[1] ?? repo), repo);

    for (const snap of await this.deps.machines()) {
      for (const t of snap.tasks) {
        if (t.state !== "ready") continue;
        const cli = snap.terminals.filter((x) => x.taskId === t.id && x.kind === "claude").at(-1);
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
        if (t.issue?.tracker === "linear" && !items.has(`linear:${t.issue.id}`)) {
          items.set(`linear:${t.issue.id}`, { label: t.issue.id, kind: "issue", key: `linear:${t.issue.id}`, title: t.title ?? t.slug, url: t.issue.url ?? null, state: null, detail: null });
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
      const li = /linear\.app\/([\w-]+)\/issue\/([A-Z][A-Z0-9]*-\d+)/.exec(th.url);
      if (li) {
        linearOrg ??= li[1]!;
        const key = `linear:${li[2]}`;
        const known = items.get(key);
        if (!known) items.set(key, { label: li[2]!, kind: "issue", key, title: th.title.replace(new RegExp(`^${li[2]}\\s*`), "") || th.title, url: `https://linear.app/${li[1]}/issue/${li[2]}`, state: null, detail: null });
        else if (!known.url) known.url = `https://linear.app/${li[1]}/issue/${li[2]}`;
      }
    }
    return { items: [...items.values()], repos, linearOrg };
  }

  /** Candidates for what is typed after @ (what jin knows; an exact PR or issue it does not, looked up). */
  async search(q: string, limit = 8): Promise<Mention[]> {
    const { items, repos, linearOrg } = await this.known();
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
      const found = await this.lookup(q.trim(), repos, linearOrg).catch(() => []);
      out.unshift(...found);
    }
    return out.slice(0, limit);
  }

  /** The mentions in a message, with live details (the agent is told about them; the chat shows chips). */
  async resolve(text: string): Promise<Mention[]> {
    const labels = mentionLabels(text);
    if (!labels.length) return [];
    const { items, repos, linearOrg } = await this.known();
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
      // An id: the jin task(s) with it, and the Linear issue with it.
      const tasks = items.filter((m) => m.kind === "task" && m.label === label);
      out.push(...tasks);
      if (ISSUE_ID.test(label)) {
        const known = items.find((m) => m.key === `linear:${label}`);
        const live = await this.lookupIssue(label, linearOrg, known);
        if (live) out.push(live);
        else if (known) out.push(known);
      }
    }
    return out;
  }

  private async lookup(q: string, repos: Map<string, string>, linearOrg: string | null): Promise<Mention[]> {
    const pr = PR_REF.exec(q);
    if (pr) {
      const repo = pr[1] ? `${pr[1]}/${pr[2]}` : repos.get(lower(pr[2]!));
      const m = repo ? await this.lookupPr(repo, Number(pr[3]), q) : null;
      return m ? [m] : [];
    }
    if (ISSUE_ID.test(q.toUpperCase())) {
      const m = await this.lookupIssue(q.toUpperCase(), linearOrg);
      return m ? [m] : [];
    }
    return [];
  }

  private async lookupPr(repo: string, number: number, label: string): Promise<Mention | null> {
    const p = await this.deps.pr(repo, number).catch(() => null);
    if (!p) return null;
    return { label, kind: "pr", key: `github:${lower(repo)}#${number}`, title: p.title, url: p.url, state: prState(p), detail: prDetail(p) };
  }

  private async lookupIssue(id: string, org: string | null, known?: Mention): Promise<Mention | null> {
    const i = await this.deps.issue(id).catch(() => null);
    if (!i) return null;
    const detail = [i.assignee ? `assigned to ${i.assignee}` : "unassigned", i.team].filter(Boolean).join(" · ");
    return { label: id, kind: "issue", key: `linear:${id}`, title: i.title, url: i.url ?? known?.url ?? (org ? `https://linear.app/${org}/issue/${id}` : null), state: i.state, detail };
  }
}

/** What the agent is told about a message's mentions (appended to the prompt it gets; the chat shows only the message). */
export function mentionContext(mentions: Mention[]): string {
  if (!mentions.length) return "";
  const line = (m: Mention) => {
    const what = m.kind === "pr" ? "pull request" : m.kind === "issue" ? "Linear issue" : `jin task on ${m.machineLabel ?? m.machine ?? "this machine"}`;
    const bits = [m.title ? `"${m.title}"` : null, m.state, m.detail].filter(Boolean).join(" — ");
    return `- @${m.label}: ${what}${bits ? ` ${bits}` : ""}${m.url ? ` (${m.url})` : ""}`;
  };
  return [
    "",
    "<mentions>",
    "The user mentioned these (resolved by jin just now). Read more with gh, the Linear tools, or jin's task tools when you need it:",
    ...mentions.map(line),
    "</mentions>",
  ].join("\n");
}

export function mentionRoutes(router: Router, mentions: Mentions) {
  router
    .on("GET", "/api/mentions", async (_req, _p, url) => json(await mentions.search(url.searchParams.get("q") ?? "")))
    .on("POST", "/api/mentions/resolve", async (req) => {
      const { text } = (await req.json().catch(() => ({}))) as { text?: string };
      if (typeof text !== "string") throw new HttpError(400, "text is required");
      return json(await mentions.resolve(text));
    });
}
