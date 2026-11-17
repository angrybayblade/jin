import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parsePr } from "./bobby";
import { now } from "./db";
import { body, HttpError, json, type Router } from "./http";
import type { Tasks } from "./tasks";
import type { Terminals } from "./terminals";

/** A pull request attached to a task, with what GitHub last said about it. */
export interface TaskPR {
  taskId: string;
  url: string;
  repo: string; // owner/name
  number: number;
  title: string | null;
  state: "OPEN" | "CLOSED" | "MERGED" | null;
  draft: boolean;
  review: string | null; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED
  checks: "passing" | "failing" | "pending" | null;
  head: string | null;
  attachedBy: string; // "hook", "claude", "you", "branch" (found by the task's branch)
  attachedAt: string;
  updatedAt: string | null;
}

interface Row {
  task_id: string;
  url: string;
  repo: string;
  number: number;
  title: string | null;
  state: string | null;
  draft: number;
  review: string | null;
  checks: string | null;
  head: string | null;
  attached_by: string;
  attached_at: string;
  updated_at: string | null;
}

const toPR = (r: Row): TaskPR => ({
  taskId: r.task_id,
  url: r.url,
  repo: r.repo,
  number: r.number,
  title: r.title,
  state: r.state as TaskPR["state"],
  draft: Boolean(r.draft),
  review: r.review,
  checks: r.checks as TaskPR["checks"],
  head: r.head,
  attachedBy: r.attached_by,
  attachedAt: r.attached_at,
  updatedAt: r.updated_at,
});

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** Pull request links in some text (a command's output, a tool's response). */
export function prUrls(text: string): string[] {
  return [...new Set(text.match(PR_URL) ?? [])];
}

/** Did this tool call create a pull request? (`gh pr create`, or a GitHub tool that creates one.) */
export function createdPrs(tool: string, input: Record<string, unknown>, response: unknown): string[] {
  const out = typeof response === "string" ? response : JSON.stringify(response ?? "");
  if (tool === "Bash" && /\bgh\s+pr\s+create\b/.test(String(input.command ?? ""))) return prUrls(out);
  if (/create_pull_request|pull_request_create|createPullRequest/i.test(tool)) return prUrls(out);
  return [];
}

/** Checks rollup from `gh pr view --json statusCheckRollup`. */
export function rollup(checks: { conclusion?: string | null; status?: string | null; state?: string | null }[] | undefined): TaskPR["checks"] {
  if (!checks?.length) return null;
  const states = checks.map((c) => (c.conclusion || c.state || c.status || "").toUpperCase());
  if (states.some((s) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(s))) return "failing";
  if (states.some((s) => ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", ""].includes(s))) return "pending";
  return "passing";
}

/** PRs attached to tasks: attached by Claude Code (its hook or jin-task), or by you; kept fresh from GitHub. */
export class TaskPRs {
  constructor(
    private db: Database,
    private gh: (args: string[]) => Promise<string> = runGh,
    private git: (cwd: string, args: string[]) => Promise<string> = runGit,
  ) {}

  list(taskId?: string): TaskPR[] {
    const rows = (
      taskId ? this.db.query("select * from task_prs where task_id = ? and detached = 0 order by attached_at").all(taskId) : this.db.query("select * from task_prs where detached = 0 order by attached_at").all()
    ) as Row[];
    return rows.map(toPR);
  }

  /** Attach a PR to a task (idempotent), then fetch its details. */
  async attach(taskId: string, url: string, by: string): Promise<TaskPR> {
    const pr = parsePr(url.trim());
    if (!pr) throw new HttpError(400, `not a GitHub pull request link: ${url}`);
    const canonical = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
    // Attaching on purpose undoes an earlier detach; finding it by branch does not.
    this.db
      .query(`insert into task_prs (task_id, url, repo, number, attached_by, attached_at) values (?, ?, ?, ?, ?, ?) on conflict(task_id, url) do ${by === "branch" ? "nothing" : "update set detached = 0"}`)
      .run(taskId, canonical, `${pr.owner}/${pr.repo}`, pr.number, by, now());
    await this.refreshOne(taskId, canonical).catch(() => {});
    return toPR(this.db.query("select * from task_prs where task_id = ? and url = ?").get(taskId, canonical) as Row);
  }

  /** Hide a PR from the task; it stays hidden even if its branch still matches. */
  detach(taskId: string, url: string) {
    this.db.query("update task_prs set detached = 1 where task_id = ? and url = ?").run(taskId, url);
  }

  /**
   * Find PRs opened from the task's branches (each repo's worktree, any state) and attach
   * them: catches PRs made before jin watched, or outside Claude Code.
   */
  async discover(task: { id: string; root: string; repos: string[] }) {
    for (const repo of task.repos) {
      const dir = join(task.root, repo);
      if (!existsSync(dir)) continue;
      const remote = (await this.git(dir, ["remote", "get-url", "origin"]).catch(() => "")).trim();
      const slug = remote.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];
      const branch = (await this.git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
      if (!slug || !branch || branch === "HEAD") continue;
      const found = JSON.parse((await this.gh(["pr", "list", "--repo", slug, "--head", branch, "--state", "all", "--json", "url", "--limit", "10"]).catch(() => "[]")) || "[]") as { url: string }[];
      const known = new Set((this.db.query("select url from task_prs where task_id = ?").all(task.id) as { url: string }[]).map((r) => r.url));
      for (const { url } of found) if (!known.has(url)) await this.attach(task.id, url, "branch").catch(() => {});
    }
  }

  removeTask(taskId: string) {
    this.db.query("delete from task_prs where task_id = ?").run(taskId);
  }

  private mergedHooks: ((taskId: string, pr: TaskPR) => void)[] = [];
  /** Run when a PR jin saw open is now merged (not for PRs attached already merged). */
  onMerged(fn: (taskId: string, pr: TaskPR) => void) {
    this.mergedHooks.push(fn);
  }

  async refreshOne(taskId: string, url: string) {
    const before = this.list(taskId).find((p) => p.url === url)?.state ?? null;
    const raw = await this.gh(["pr", "view", url, "--json", "number,title,state,isDraft,reviewDecision,statusCheckRollup,headRefName"]);
    const j = JSON.parse(raw) as { title?: string; state?: string; isDraft?: boolean; reviewDecision?: string; statusCheckRollup?: { conclusion?: string; status?: string; state?: string }[]; headRefName?: string };
    this.db
      .query("update task_prs set title = ?, state = ?, draft = ?, review = ?, checks = ?, head = ?, updated_at = ? where task_id = ? and url = ?")
      .run(j.title ?? null, j.state ?? null, j.isDraft ? 1 : 0, j.reviewDecision || null, rollup(j.statusCheckRollup), j.headRefName ?? null, now(), taskId, url);
    if (before === "OPEN" && j.state === "MERGED") {
      const pr = this.list(taskId).find((p) => p.url === url);
      if (pr) for (const fn of this.mergedHooks) fn(taskId, pr);
    }
  }

  /** Refresh open PRs (merged and closed ones do not change). */
  async refreshOpen() {
    for (const p of this.list().filter((x) => x.state !== "MERGED" && x.state !== "CLOSED")) await this.refreshOne(p.taskId, p.url).catch(() => {});
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out;
}

async function runGh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.trim() || `gh exited with ${code}`);
  return out;
}

export function prRoutes(router: Router, prs: TaskPRs, tasks: Tasks, terminals: Terminals) {
  const taskOfTerminal = (id: string) => {
    const t = terminals.get(id);
    if (!t.taskId) throw new HttpError(400, "this terminal does not belong to a task");
    return t.taskId;
  };
  router
    .on("GET", "/api/prs", () => json(prs.list()))
    .on("GET", "/api/tasks/:id/prs", (_req, p) => json(prs.list(tasks.get(p.id!).id)))
    .on("POST", "/api/tasks/:id/prs", async (req, p) => {
      const { url, by } = await body<{ url: string; by?: string }>(req);
      return json(await prs.attach(tasks.get(p.id!).id, url, by === "claude" ? "claude" : "you"), 201);
    })
    .on("DELETE", "/api/tasks/:id/prs", async (req, p) => {
      const { url } = await body<{ url: string }>(req);
      prs.detach(p.id!, url);
      return json({ detached: true });
    })
    .on("POST", "/api/tasks/:id/prs/refresh", async (_req, p) => {
      await prs.discover(tasks.get(p.id!)).catch(() => {});
      for (const pr of prs.list(p.id!)) await prs.refreshOne(pr.taskId, pr.url).catch(() => {});
      return json(prs.list(p.id!));
    })
    // `jin-task attach-pr <url>` from inside a task's Claude Code (or shell): the terminal names the task.
    .on("POST", "/api/terminals/:id/prs", async (req, p) => {
      const { url } = await body<{ url: string }>(req);
      return json(await prs.attach(taskOfTerminal(p.id!), url, "claude"), 201);
    })
    .on("GET", "/api/terminals/:id/prs", (_req, p) => json(prs.list(taskOfTerminal(p.id!))));
}
