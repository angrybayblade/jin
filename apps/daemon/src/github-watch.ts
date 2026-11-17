import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveEvent } from "./composio";
import { githubThread } from "./feed";
import { oneLine as line } from "./text";

/**
 * GitHub activity on the PRs you review or wrote, watched with gh on this machine: one GraphQL
 * call every couple of minutes. (Composio's GitHub triggers poll too, one trigger per PR per
 * kind; gh does the same job in one call, with your login.) What is new since the last look
 * becomes a live event; the first look only remembers what is there, so nothing floods in.
 */

const QUERY = `query($q1: String!, $q2: String!) {
  viewer { login }
  reviewing: search(query: $q1, type: ISSUE, first: 40) { nodes { ...pr } }
  mine: search(query: $q2, type: ISSUE, first: 30) { nodes { ...pr } }
}
fragment pr on PullRequest {
  number title url repository { nameWithOwner }
  comments(last: 10) { nodes { id url body createdAt author { login } } }
  reviews(last: 10) { nodes { id url body state submittedAt author { login } comments(first: 5) { nodes { id url body author { login } } } } }
  commits(last: 5) { nodes { commit { oid url messageHeadline committedDate author { user { login } } } } }
}`;

interface Author {
  login: string;
}
interface PR {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
  comments: { nodes: { id: string; url: string; body: string; createdAt: string; author: Author | null }[] };
  reviews: { nodes: { id: string; url: string; body: string; state: string; submittedAt: string; author: Author | null; comments: { nodes: { id: string; url: string; body: string; author: Author | null }[] } }[] };
  commits: { nodes: { commit: { oid: string; url: string; messageHeadline: string; committedDate: string; author: { user: Author | null } | null } }[] };
}
export interface WatchData {
  viewer: { login: string };
  reviewing: { nodes: (PR | Record<string, never>)[] };
  mine: { nodes: (PR | Record<string, never>)[] };
}

/** Everything on the watched PRs as events (newest information first is not needed: ids decide what is new). */
export function prEvents(data: WatchData): LiveEvent[] {
  const me = data.viewer.login.toLowerCase();
  const out: LiveEvent[] = [];
  const seen = new Set<string>();
  const add = (pr: PR, _role: "reviewing" | "yours", e: Omit<LiveEvent, "toolkit" | "forYou" | "title" | "thread"> & { what: string }) => {
    if (seen.has(e.id) || (e.actor && e.actor.toLowerCase() === me)) return;
    seen.add(e.id);
    const thread = githubThread(pr.repository.nameWithOwner, pr.number, pr.title, pr.url);
    out.push({ id: e.id, at: e.at, toolkit: "github", trigger: e.trigger, url: e.url, actor: e.actor, summary: e.summary, forYou: true, title: e.what, thread });
  };
  for (const [role, list] of [
    ["reviewing", data.reviewing.nodes],
    ["yours", data.mine.nodes],
  ] as const) {
    for (const n of list) {
      if (!("number" in n)) continue;
      const pr = n as PR;
      for (const c of pr.comments.nodes) add(pr, role, { id: `c:${c.id}`, at: c.createdAt, trigger: "GITHUB_PR_COMMENT", url: c.url, actor: c.author?.login ?? null, summary: line(c.body), what: "commented" });
      for (const r of pr.reviews.nodes) {
        if (r.state === "PENDING") continue;
        const verb = r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "requested changes" : "reviewed";
        add(pr, role, { id: `r:${r.id}`, at: r.submittedAt, trigger: "GITHUB_PR_REVIEW", url: r.url, actor: r.author?.login ?? null, summary: line(r.body || r.comments.nodes[0]?.body || ""), what: verb });
      }
      // New commits matter when someone else pushes to a PR you review (time to look again).
      if (role === "reviewing") {
        for (const { commit } of pr.commits.nodes) {
          add(pr, role, { id: `k:${commit.oid}`, at: commit.committedDate, trigger: "GITHUB_PR_COMMIT", url: commit.url, actor: commit.author?.user?.login ?? null, summary: line(commit.messageHeadline), what: "pushed" });
        }
      }
    }
  }
  return out;
}

export class GithubWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen: Set<string> | null = null;
  private file: string;
  state: { watching: number; lastCheck: string | null; error: string | null } = { watching: 0, lastCheck: null, error: null };

  constructor(
    home: string,
    private deliver: (e: LiveEvent) => void,
    private gh: (args: string[]) => Promise<string> = runGh,
  ) {
    this.file = join(home, "github-watch.json");
  }

  private load(): Set<string> | null {
    try {
      return existsSync(this.file) ? new Set(JSON.parse(readFileSync(this.file, "utf8")) as string[]) : null;
    } catch {
      return null;
    }
  }

  /** One look: new activity is delivered; the first look only remembers. */
  async check(): Promise<number> {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const raw = await this.gh(["api", "graphql", "-f", `query=${QUERY}`, "-f", "q1=is:pr is:open review-requested:@me", "-f", `q2=is:pr is:open author:@me updated:>=${since}`]);
    const data = (JSON.parse(raw) as { data: WatchData }).data;
    const events = prEvents(data);
    this.seen ??= this.load();
    const first = this.seen === null;
    const seen = this.seen ?? new Set<string>();
    let fresh = 0;
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (!first) {
        this.deliver(e);
        fresh++;
      }
    }
    this.seen = seen;
    // Remember only what is still on the watched PRs, so the file stays small.
    const current = new Set(events.map((e) => e.id));
    writeFileSync(this.file, JSON.stringify([...seen].filter((id) => current.has(id))));
    this.state = { watching: data.reviewing.nodes.length + data.mine.nodes.length, lastCheck: new Date().toISOString(), error: null };
    return fresh;
  }

  start(everyMs = 120_000) {
    if (this.timer) return;
    const tick = () => void this.check().catch((err) => (this.state = { ...this.state, error: err instanceof Error ? err.message : String(err) }));
    tick();
    this.timer = setInterval(tick, everyMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running() {
    return this.timer !== null;
  }
}

async function runGh(args: string[]): Promise<string> {
  const p = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(err.trim() || `gh exited with ${code}`);
  return out;
}
