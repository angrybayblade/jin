import { randomUUID } from "node:crypto";
import { taskKindOf, type TaskSpec } from "./adapters";
import type { Feed } from "./feed";
import { body, HttpError, json, type Router } from "./http";
import type { Tasks } from "./tasks";
import { openTerminal, type TerminalDeps } from "./terminals";

/** A task being created in the background: the workspace's setup can take minutes. */
export interface TaskJob {
  id: string;
  workspace: string;
  taskId: string;
  slug: string;
  repos: string[];
  setup: boolean;
  state: "running" | "done" | "failed";
  /** The workspace tooling's output, newest last (bounded). */
  log: string[];
  error: string | null;
  /** The Claude Code tab opened once the task is ready, if a prompt was given. */
  terminalId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const LOG_LINES = 400;

/**
 * Creates tasks in the background so neither the UI nor jin's chat waits on the workspace's
 * tooling (creating checkouts, installing). Progress is the tooling's own output. Jobs live in memory: a daemon restart ends
 * a running one (the workspace may be left with a partly set-up task, as after a ctrl-c).
 */
export class TaskJobs {
  private jobs = new Map<string, TaskJob>();

  private finished: ((job: TaskJob) => void)[] = [];

  constructor(private deps: TerminalDeps & { feed: Feed }) {}

  /** A setup finished (done or failed). */
  onFinish(fn: (job: TaskJob) => void) {
    this.finished.push(fn);
  }

  get defaultWorkspace(): string | undefined {
    return this.deps.workspaces[0]?.id;
  }

  private get tasks(): Tasks {
    return this.deps.tasks;
  }

  list(): TaskJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): TaskJob {
    const j = this.jobs.get(id);
    if (!j) throw new HttpError(404, `unknown job ${id}`);
    return j;
  }

  /** The newest job for a task id (its page shows progress until the task exists). */
  forTask(taskId: string): TaskJob | undefined {
    return this.list().find((j) => j.taskId === taskId);
  }

  /** Before Claude Code starts in a task: its skills (jin's, by the task's tags). */
  prepare: ((taskId: string) => Promise<void>) | null = null;
  /** Once a task exists: the links given with it (Slack threads and channels, Notion pages). */
  addLinks: ((taskId: string, urls: string[]) => string[]) | null = null;

  async start(workspace: string, spec: TaskSpec, opts: { setup?: boolean; prompt?: string; feedItemId?: string; links?: string[] } = {}): Promise<TaskJob> {
    // A review task is numbered by the workspace (REV-<month><day><n>), unless an id is given.
    if (spec.kind === "review" && !spec.id) {
      const adapter = this.tasks.adapter(workspace);
      if (!adapter.nextTaskId) throw new HttpError(400, "this workspace has no review tasks");
      spec = { ...spec, id: await adapter.nextTaskId("review") };
    }
    if (this.list().some((j) => j.taskId === spec.id && j.state === "running")) throw new HttpError(409, `task ${spec.id} is already being set up`);
    await this.tasks.validate(workspace, spec);
    const job: TaskJob = {
      id: randomUUID(),
      workspace,
      taskId: spec.id,
      slug: spec.slug,
      repos: spec.repos,
      setup: opts.setup !== false,
      state: "running",
      log: [],
      error: null,
      terminalId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    const say = (line: string) => {
      job.log.push(line);
      if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
    };
    void (async () => {
      try {
        await this.tasks.start(workspace, spec, opts.feedItemId, { setup: job.setup, onOutput: say });
        if (opts.links?.length && this.addLinks) for (const problem of this.addLinks(spec.id, opts.links)) say(`link: ${problem}`);
        if (opts.feedItemId) this.deps.feed.setState(opts.feedItemId, "promoted", { taskId: spec.id });
        if (opts.prompt?.trim()) {
          await this.prepare?.(spec.id).catch((err) => say(`skills: ${err instanceof Error ? err.message : err}`));
          job.terminalId = openTerminal(this.deps, { taskId: spec.id, kind: "claude", prompt: opts.prompt }).id;
          say("Claude Code started with your prompt.");
        }
        job.state = "done";
      } catch (err) {
        job.state = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        say(`failed: ${job.error}`);
      } finally {
        job.finishedAt = new Date().toISOString();
        for (const fn of this.finished) {
          try {
            fn(job);
          } catch {
            // notifications never fail a setup
          }
        }
      }
    })();
    return job;
  }
}

export function jobRoutes(router: Router, jobs: TaskJobs) {
  router
    .on("GET", "/api/task-jobs", () => json(jobs.list()))
    .on("GET", "/api/task-jobs/:id", (_req, p) => json(jobs.get(p.id!)))
    .on("POST", "/api/task-jobs", async (req) => {
      const b = await body<{ workspace?: string; id?: string; kind?: string; type?: string; repos?: string[]; prs?: string[]; slug?: string; setup?: boolean; prompt?: string; feedItemId?: string; links?: string[] }>(req);
      const workspace = b.workspace ?? jobs.defaultWorkspace;
      if (!workspace) throw new HttpError(400, "no workspace configured");
      const review = taskKindOf(b.kind) === "review";
      const spec: TaskSpec = review
        ? { id: b.id ?? "", kind: "review", prs: b.prs ?? [], repos: (b.prs ?? []).map((p) => p.split("#")[0]!), slug: b.slug ?? "" }
        : { id: b.id ?? "", kind: "change", type: b.type, repos: b.repos ?? [], slug: b.slug ?? "" };
      return json(await jobs.start(workspace, spec, { setup: review ? b.setup === true : b.setup, prompt: b.prompt, feedItemId: b.feedItemId, links: b.links }), 202);
    });
}
