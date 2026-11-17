import { body, HttpError, json, type Router } from "./http";
import type { TaskJobs } from "./jobs";
import type { Tasks } from "./tasks";

/**
 * Reviewing pull requests as a task: a PR link (or <repo>#<n>) becomes a review task in the
 * workspace (its worktrees at the PR heads), with Claude Code started on it. A PR that already
 * has a review task opens that one instead.
 */

/** "https://github.com/ComposioHQ/platform/pull/12" -> { github: "ComposioHQ/platform", number: 12 }. */
export function parsePrRef(ref: string): { github?: string; repo?: string; number: number } | null {
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(ref);
  if (url) return { github: url[1]!, number: Number(url[2]) };
  const short = /^([\w.-]+)#(\d+)$/.exec(ref.trim());
  return short ? { repo: short[1]!, number: Number(short[2]) } : null;
}

export const REVIEW_PROMPT = "Review the pull requests in this task. TASK.md lists them; start there.";

/** A review task for these PRs, or the one already reviewing them. */
export async function startReview(deps: { tasks: Tasks; jobs: TaskJobs }, refs: string[], opts: { workspace?: string; prompt?: string; setup?: boolean } = {}): Promise<{ taskId: string; existing: boolean; job?: string }> {
  const workspace = opts.workspace ?? deps.jobs.defaultWorkspace;
  if (!workspace) throw new HttpError(400, "no workspace configured");
  if (!Array.isArray(refs) || !refs.length) throw new HttpError(400, "prs: one or more pull request links");
  const repos = await deps.tasks.adapter(workspace).repos();
  const prs = refs.map((ref) => {
    const p = parsePrRef(ref);
    if (!p) throw new HttpError(400, `not a pull request: ${ref}`);
    const repo = p.repo ? repos.find((r) => r.name === p.repo) : repos.find((r) => r.github?.toLowerCase() === p.github!.toLowerCase());
    if (!repo) throw new HttpError(400, `${p.github ?? p.repo} is not a repo of ${workspace}`);
    return { repo: repo.name, number: p.number };
  });
  // Already reviewing these? Open that task.
  const open = deps.tasks.list().filter((t) => t.kind === "review" && t.state === "ready" && !t.archived);
  const existing = open.find((t) => prs.every((p) => t.prs.some((q) => q.repo === p.repo && q.number === p.number)));
  if (existing) return { taskId: existing.id, existing: true };
  const job = await deps.jobs.start(
    workspace,
    { id: "", kind: "review", prs: prs.map((p) => `${p.repo}#${p.number}`), repos: prs.map((p) => p.repo), slug: "" },
    // No setup by default: the reviewer installs a repo (or brings the stack up) only if the review needs it.
    { prompt: opts.prompt?.trim() || REVIEW_PROMPT, setup: opts.setup === true },
  );
  return { taskId: job.taskId, existing: false, job: job.id };
}

export function reviewRoutes(router: Router, deps: { tasks: Tasks; jobs: TaskJobs }) {
  router.on("POST", "/api/reviews", async (req) => {
    const b = await body<{ workspace?: string; prs: string[]; prompt?: string; setup?: boolean }>(req);
    const r = await startReview(deps, b.prs, b);
    return json(r, r.existing ? 200 : 202);
  });
}
