import { body, HttpError, json, type Router } from "./http";
import type { TaskJobs } from "./jobs";
import type { TaskPRs } from "./prs";
import type { Tasks } from "./tasks";
import type { Terminals } from "./terminals";

/**
 * Sub-tasks: a task's Claude Code splits part of the work into its own task (`jin-task spawn`),
 * with its own branch, worktrees and pull request, and Claude Code started there with a prompt.
 * jin remembers the parent, nests it in the sidebar, and reports back (`jin-task subtasks`).
 */
export function subtaskRoutes(router: Router, deps: { terminals: Terminals; tasks: Tasks; jobs: TaskJobs; prs: TaskPRs }) {
  const { terminals, tasks, jobs, prs } = deps;
  const parentOf = (terminalId: string) => {
    const t = terminals.get(terminalId);
    if (!t.taskId) throw new HttpError(400, "this terminal does not belong to a task");
    return tasks.get(t.taskId);
  };

  router
    .on("POST", "/api/terminals/:id/subtasks", async (req, p) => {
      const parent = parentOf(p.id!);
      const b = await body<{ id?: string; repos?: string[]; slug?: string; type?: string; prompt?: string; setup?: boolean }>(req);
      if (!b.id || !b.slug || !b.repos?.length) throw new HttpError(400, "a sub-task needs an id, a slug and at least one repo");
      if (b.id === parent.id) throw new HttpError(400, "a sub-task needs its own id");
      const job = await jobs.start(parent.workspace, { id: b.id, repos: b.repos, slug: b.slug, type: b.type ?? parent.type ?? undefined }, { setup: b.setup, prompt: b.prompt });
      tasks.setParent(b.id, parent.id);
      return json({ taskId: job.taskId, parent: parent.id, state: job.state, open: `/t/${job.taskId}` }, 202);
    })
    .on("GET", "/api/terminals/:id/subtasks", (_req, p) => {
      const parent = parentOf(p.id!);
      return json(
        tasks.childIds(parent.id).map((id) => {
          const job = jobs.forTask(id);
          const task = tasks.list().find((t) => t.id === id);
          const cli = terminals.list({ taskId: id }).filter((t) => t.kind === "claude").at(-1);
          return {
            id,
            title: task ? (task.title ?? task.slug) : (job?.slug ?? null),
            state: task ? task.state : job ? (job.state === "running" ? "setting up" : job.state === "failed" ? "setup failed" : "done") : "unknown",
            error: job?.state === "failed" ? job.error : null,
            claude: cli ? cli.status : null,
            pullRequests: prs.list(id).map((pr) => ({ url: pr.url, state: pr.draft && pr.state === "OPEN" ? "DRAFT" : pr.state, review: pr.review, checks: pr.checks })),
          };
        }),
      );
    });
}
