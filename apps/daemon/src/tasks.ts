import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { AdapterError, provider, type ProviderTask, type ReviewedPR, type TaskIssue, type TaskKind, type TaskSpec, type WorkspaceAdapter } from "./adapters";
import { now } from "./db";
import { trackerView, type IssueTracker } from "./trackers";
import { body, HttpError, json, type Router } from "./http";

export interface Task {
  id: string;
  workspace: string;
  type: string | null;
  slug: string;
  branch: string | null;
  repos: string[];
  root: string;
  dirs: Record<string, string>;
  state: "ready" | "removed";
  sourceItem: string | null;
  createdAt: string;
  /** Jin's display title, when renamed in jin (the workspace's own title stays the slug). */
  title: string | null;
  archived: boolean;
  /** The task this one was spawned from (jin-task spawn), if any. */
  parent: string | null;
  /** A change to make, or a review of pull requests. */
  kind: TaskKind;
  /** A review task's pull requests. */
  prs: ReviewedPR[];
  /** The issue it is for, when its workspace ties tasks to issues. */
  issue: TaskIssue | null;
  /** Being removed now (in the background: removing worktrees can take minutes). */
  removing?: boolean;
  /** Why the last removal failed, until the next try. */
  removeError?: string | null;
}

interface Meta {
  title: string | null;
  archived_at: string | null;
  parent_id: string | null;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const toTask = (r: any): Task => {
  const dirs = JSON.parse(r.dirs);
  return {
    id: r.id,
    workspace: r.workspace,
    type: r.type,
    slug: r.slug,
    branch: null,
    repos: JSON.parse(r.repos),
    root: dirs.root,
    dirs: dirs.repos,
    state: r.state,
    sourceItem: r.source_item,
    createdAt: r.created_at,
    title: null,
    archived: false,
    parent: null,
    kind: r.type === "review" ? "review" : r.type === "scratch" ? "scratch" : "change",
    prs: [],
    issue: null,
  };
};

const fromProvider = (workspace: string, t: ProviderTask, sourceItem: string | null): Task => ({
  id: t.id,
  workspace,
  type: t.type,
  slug: t.slug,
  branch: t.branch,
  repos: t.repos,
  root: t.root,
  dirs: t.dirs,
  state: "ready",
  sourceItem,
  createdAt: t.createdAt,
  title: null,
  archived: false,
  parent: null,
  kind: t.kind ?? (t.type === "review" ? "review" : t.type === "scratch" ? "scratch" : "change"),
  prs: t.prs ?? [],
  issue: t.issue ?? null,
});

export class Tasks {
  constructor(
    private db: Database,
    private adapters: Map<string, WorkspaceAdapter>,
    /** The issue a workspace's task is for, by its tracker (when the adapter did not say). */
    private issueOf: (workspace: string, task: ProviderTask) => TaskIssue | null = () => null,
  ) {}

  adapter(workspace: string): WorkspaceAdapter {
    const a = this.adapters.get(workspace);
    if (!a) throw new HttpError(404, `unknown workspace ${workspace}`);
    return a;
  }

  private meta(): Map<string, Meta> {
    return new Map((this.db.query("select task_id, title, archived_at, parent_id from task_meta").all() as (Meta & { task_id: string })[]).map((r) => [r.task_id, r]));
  }

  private withMeta(t: Task, meta: Map<string, Meta>): Task {
    const m = meta.get(t.id);
    const r = this.removals.get(t.id);
    const removal = r && t.state !== "removed" ? { removing: r.running, removeError: r.error } : {};
    return m ? { ...t, title: m.title, archived: Boolean(m.archived_at), parent: m.parent_id, ...removal } : { ...t, parent: null, ...removal };
  }

  private removals = new Map<string, { running: boolean; error: string | null }>();

  /** Remove a task in the background (the app shows it as removing); a failure is kept on the task. */
  startRemoval(id: string, opts: { discard?: boolean } = {}): Task {
    const task = this.get(id);
    if (opts.discard && task.kind !== "scratch") throw new HttpError(400, `only scratch tasks are discarded; ${id} is a ${task.kind} task`);
    if (task.state === "removed" || this.removals.get(id)?.running) return task;
    this.removals.set(id, { running: true, error: null });
    void this.remove(id, opts)
      .then(() => this.removals.delete(id))
      .catch((err) => this.removals.set(id, { running: false, error: err instanceof Error ? err.message : String(err) }));
    return this.get(id);
  }

  /** Rename (a display title in jin) or archive (hidden from the sidebar's list) a task. */
  update(id: string, patch: { title?: string | null; archived?: boolean }): Task {
    this.get(id);
    this.db.query("insert into task_meta (task_id) values (?) on conflict (task_id) do nothing").run(id);
    if (patch.title !== undefined) this.db.query("update task_meta set title = ? where task_id = ?").run(patch.title?.trim().slice(0, 120) || null, id);
    if (patch.archived !== undefined) this.db.query("update task_meta set archived_at = ? where task_id = ?").run(patch.archived ? now() : null, id);
    return this.get(id);
  }

  /** Record that `id` was spawned from `parent` (before the task exists: its setup runs in the background). */
  setParent(id: string, parent: string) {
    this.db.query("insert into task_meta (task_id, parent_id) values (?, ?) on conflict (task_id) do update set parent_id = excluded.parent_id").run(id, parent);
  }

  /** Ids of the tasks spawned from `parent`, including ones still being set up. */
  childIds(parent: string): string[] {
    return (this.db.query("select task_id from task_meta where parent_id = ? order by task_id").all(parent) as { task_id: string }[]).map((r) => r.task_id);
  }

  private removedHooks: ((id: string) => void)[] = [];
  /** Run when a task is removed (its terminals close). */
  onRemoved(fn: (id: string) => void) {
    this.removedHooks.push(fn);
  }

  /** The workspace's own tasks, with jin's metadata (e.g. the feed item a task came from) on top. */
  private provided(): Task[] {
    const meta = new Map((this.db.query("select id, source_item from tasks").all() as { id: string; source_item: string | null }[]).map((r) => [r.id, r.source_item]));
    const out: Task[] = [];
    for (const [workspace, adapter] of this.adapters) {
      for (const t of adapter.listTasks()) out.push(fromProvider(workspace, { ...t, issue: t.issue ?? this.issueOf(workspace, t) }, meta.get(t.id) ?? null));
    }
    return out;
  }

  get(id: string): Task {
    const meta = this.meta();
    const provided = this.provided().find((t) => t.id === id);
    if (provided) return this.withMeta(provided, meta);
    const row = this.db.query("select * from tasks where id = ?").get(id);
    if (!row) throw new HttpError(404, `unknown task ${id}`);
    return this.withMeta(toTask(row), meta);
  }

  /** Every task the workspaces report, plus jin's records of tasks they do not (e.g. removed ones). */
  list(): Task[] {
    const provided = this.provided();
    const known = new Set(provided.map((t) => t.id));
    const recorded = (this.db.query("select * from tasks").all() as any[]).map(toTask).filter((t) => !known.has(t.id));
    const meta = this.meta();
    return [...provided, ...recorded].map((t) => this.withMeta(t, meta)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async start(workspace: string, spec: TaskSpec, sourceItem?: string, opts: { setup?: boolean; onOutput?: (line: string) => void } = {}): Promise<Task> {
    await this.validate(workspace, spec);
    let dirs;
    try {
      dirs = await this.adapter(workspace).startTask(spec, opts);
    } catch (err) {
      if (err instanceof AdapterError) throw new HttpError(502, err.message);
      throw err;
    }
    return this.record(workspace, spec, dirs, sourceItem);
  }

  /** Checks a new task before anything runs: id, slug, repos known to the workspace, not taken. */
  async validate(workspace: string, spec: TaskSpec): Promise<void> {
    const adapter = this.adapter(workspace);
    if (!ID.test(spec.id ?? "")) throw new HttpError(400, "task id must be letters, digits, '.', '_' or '-'");
    if (spec.kind === "review") {
      if (!spec.prs?.length) throw new HttpError(400, "a review task needs pull requests, e.g. platform#123");
      const bad = spec.prs.find((p) => !/^[\w.-]+#\d+$/.test(p));
      if (bad) throw new HttpError(400, `"${bad}" is not <repo>#<number>`);
    } else if (spec.kind !== "scratch" && !spec.slug?.trim()) throw new HttpError(400, "slug is required");
    if (!Array.isArray(spec.repos) || !spec.repos.length) throw new HttpError(400, "repos is required");
    const known = new Set((await adapter.repos()).map((r) => r.name));
    const unknown = spec.repos.filter((r) => !known.has(r));
    if (unknown.length) throw new HttpError(400, `unknown repos in ${workspace}: ${unknown.join(", ")}`);
    const existing = this.db.query("select state from tasks where id = ?").get(spec.id) as { state: string } | null;
    if ((existing && existing.state !== "removed") || adapter.listTasks().some((t) => t.id === spec.id)) throw new HttpError(409, `task ${spec.id} already exists`);
  }

  private record(workspace: string, spec: TaskSpec, dirs: { root: string; dirs: Record<string, string> }, sourceItem?: string): Task {
    this.db
      .query(
        `insert into tasks (id, workspace, type, slug, repos, dirs, state, source_item, created_at)
         values (?, ?, ?, ?, ?, ?, 'ready', ?, ?)
         on conflict (id) do update set workspace = excluded.workspace, type = excluded.type, slug = excluded.slug,
           repos = excluded.repos, dirs = excluded.dirs, state = 'ready', source_item = excluded.source_item, created_at = excluded.created_at`,
      )
      .run(spec.id, workspace, spec.kind === "review" ? "review" : spec.kind === "scratch" ? "scratch" : (spec.type ?? null), spec.slug ?? "", JSON.stringify(spec.repos), JSON.stringify({ root: dirs.root, repos: dirs.dirs }), sourceItem ?? null, now());
    return this.get(spec.id);
  }

  /**
   * What removing a task would lose: per repo, uncommitted changes and commits that are on no
   * remote. Empty means its worktrees can go without losing work.
   */
  unsaved(id: string): { repo: string; dir: string; problem: string }[] {
    const task = this.get(id);
    const out: { repo: string; dir: string; problem: string }[] = [];
    const git = (dir: string, args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
      return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
    };
    for (const [repo, dir] of Object.entries(task.dirs)) {
      if (!existsSync(dir)) continue;
      const status = git(dir, ["status", "--porcelain"]);
      if (!status.ok) {
        out.push({ repo, dir, problem: `git status failed: ${status.err || "unknown"}` });
        continue;
      }
      const changed = status.out ? status.out.split("\n").length : 0;
      if (changed) out.push({ repo, dir, problem: `${changed} uncommitted change${changed === 1 ? "" : "s"}` });
      // A review's worktree sits on the PR's head, which is on GitHub but not a remote branch here.
      const prHead = task.prs.find((p) => p.repo === repo)?.head;
      const local = git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes", ...(prHead && /^[0-9a-f]{7,40}$/.test(prHead) ? [prHead] : [])]);
      const n = local.ok ? Number(local.out) : NaN;
      if (!local.ok) out.push({ repo, dir, problem: `could not compare with the remote: ${local.err || "unknown"}` });
      else if (n > 0) out.push({ repo, dir, problem: `${n} commit${n === 1 ? "" : "s"} on no remote` });
    }
    return out;
  }

  /** Work the task still has outside its pull requests (see workOutsidePRs); `covered`: the repos that have one. */
  unfinished(id: string, covered: string[]): { repo: string; problem: string }[] {
    return workOutsidePRs(this.get(id).dirs, covered);
  }

  /** Remove a task only when nothing would be lost (see unsaved). */
  async removeIfClean(id: string): Promise<Task> {
    const problems = this.unsaved(id);
    if (problems.length) throw new HttpError(409, `${id} has unsaved work: ${problems.map((p) => `${p.repo}: ${p.problem}`).join("; ")}`);
    return this.remove(id);
  }

  async remove(id: string, opts: { discard?: boolean } = {}): Promise<Task> {
    const task = this.get(id);
    if (task.state === "removed") return task;
    try {
      await this.adapter(task.workspace).removeTask(id, opts.discard ? { discard: true } : undefined);
    } catch (err) {
      if (err instanceof AdapterError) throw new HttpError(502, err.message);
      throw err;
    }
    // Keep a record so the task still resolves (as removed) after the workspace forgets it.
    this.db
      .query(
        `insert into tasks (id, workspace, type, slug, repos, dirs, state, created_at) values (?, ?, ?, ?, ?, ?, 'removed', ?)
         on conflict (id) do update set state = 'removed'`,
      )
      .run(id, task.workspace, task.type, task.slug, JSON.stringify(task.repos), JSON.stringify({ root: task.root, repos: task.dirs }), task.createdAt);
    for (const fn of this.removedHooks) fn(id);
    return { ...task, state: "removed" };
  }
}

export function taskRoutes(router: Router, tasks: Tasks, adapters: Map<string, WorkspaceAdapter>, trackerOf: (workspace: string) => IssueTracker | null = () => null) {
  router
    .on("GET", "/api/workspaces", () =>
      // With the kinds of task each one runs (from its provider) and its tracker, for the new-task form.
      json(
        [...adapters.values()].map((a) => {
          const tracker = trackerOf(a.config.id);
          return {
            id: a.config.id,
            adapter: a.config.adapter,
            root: a.config.root,
            tracker: tracker ? trackerView(tracker) : null,
            // A kind named after its issue takes the tracker's id hint ("ENG-123"); with no tracker it is a plain id.
            taskKinds: provider(a.config.adapter).taskKinds.map((k) => (k.idIsIssue ? { ...k, idIsIssue: Boolean(tracker), idHint: tracker?.idHint ?? k.idHint ?? "TASK-1" } : k)),
          };
        }),
      ),
    )
    .on("GET", "/api/workspaces/:id/repos", async (_req, p) => json(await tasks.adapter(p.id!).repos()))
    .on("POST", "/api/workspaces/:id/tasks", async (req, p) => json(await tasks.start(p.id!, await body<TaskSpec>(req)), 201))
    .on("GET", "/api/tasks", () => json(tasks.list()))
    .on("GET", "/api/tasks/:id", (_req, p) => json(tasks.get(p.id!)))
    .on("PATCH", "/api/tasks/:id", async (req, p) => {
      const b = await body<{ title?: string | null; archived?: boolean }>(req);
      return json(tasks.update(p.id!, { title: b.title, archived: b.archived }));
    })
    .on("POST", "/api/tasks/:id/reveal", (_req, p) => {
      // Show the task's folder in Finder (or the desktop's file manager): this machine only.
      const root = tasks.get(p.id!).root;
      Bun.spawn(process.platform === "darwin" ? ["open", root] : ["xdg-open", root], { stdout: "ignore", stderr: "ignore" });
      return json({ revealed: root });
    })
    // Removing worktrees can take minutes: it runs in the background, and the task shows as removing.
    // ?discard=1 (scratch tasks): throw it away whole, unsaved work and its branch included.
    .on("DELETE", "/api/tasks/:id", (req, p) => json(tasks.startRemoval(p.id!, { discard: new URL(req.url).searchParams.get("discard") === "1" }), 202))
    .on("GET", "/api/tasks/:id/unsaved", (_req, p) => json(tasks.unsaved(p.id!)))
    .on("POST", "/api/tasks/:id/remove-if-clean", async (_req, p) => json(await tasks.removeIfClean(p.id!)));
}

/**
 * Per repo of a task that has no pull request (by name, case-insensitive): uncommitted changes,
 * and commits that are not on its remote's default branch. Such a repo's work is not done when
 * the other repos' PRs merge, so the task is not either.
 */
export function workOutsidePRs(dirs: Record<string, string>, covered: string[]): { repo: string; problem: string }[] {
  const git = (dir: string, args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  };
  const prs = new Set(covered.map((c) => c.toLowerCase()));
  const out: { repo: string; problem: string }[] = [];
  for (const [repo, dir] of Object.entries(dirs)) {
    if (prs.has(repo.toLowerCase()) || !existsSync(dir)) continue;
    const status = git(dir, ["status", "--porcelain"]);
    const changed = status ? status.split("\n").length : 0;
    if (changed) out.push({ repo, problem: `${changed} uncommitted change${changed === 1 ? "" : "s"}` });
    const base = ["origin/HEAD", "origin/main", "origin/master"].find((ref) => git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null);
    if (!base) continue;
    const ahead = Number(git(dir, ["rev-list", "--count", "HEAD", "--not", base]) ?? 0);
    // origin/HEAD names the default branch it points at (origin/main).
    const branch = (base === "origin/HEAD" ? (git(dir, ["rev-parse", "--abbrev-ref", base]) ?? base) : base).replace(/^origin\//, "");
    if (ahead > 0) out.push({ repo, problem: `${ahead} commit${ahead === 1 ? "" : "s"} not on ${branch}` });
  }
  return out;
}
