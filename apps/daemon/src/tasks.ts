import type { Database } from "bun:sqlite";
import { AdapterError, type ProviderTask, type TaskSpec, type WorkspaceAdapter } from "./adapters";
import { now } from "./db";
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
}

interface Meta {
  title: string | null;
  archived_at: string | null;
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
});

export class Tasks {
  constructor(
    private db: Database,
    private adapters: Map<string, WorkspaceAdapter>,
  ) {}

  adapter(workspace: string): WorkspaceAdapter {
    const a = this.adapters.get(workspace);
    if (!a) throw new HttpError(404, `unknown workspace ${workspace}`);
    return a;
  }

  private meta(): Map<string, Meta> {
    return new Map((this.db.query("select task_id, title, archived_at from task_meta").all() as (Meta & { task_id: string })[]).map((r) => [r.task_id, r]));
  }

  private withMeta(t: Task, meta: Map<string, Meta>): Task {
    const m = meta.get(t.id);
    return m ? { ...t, title: m.title, archived: Boolean(m.archived_at) } : t;
  }

  /** Rename (a display title in jin) or archive (hidden from the sidebar's list) a task. */
  update(id: string, patch: { title?: string | null; archived?: boolean }): Task {
    this.get(id);
    this.db.query("insert into task_meta (task_id) values (?) on conflict (task_id) do nothing").run(id);
    if (patch.title !== undefined) this.db.query("update task_meta set title = ? where task_id = ?").run(patch.title?.trim().slice(0, 120) || null, id);
    if (patch.archived !== undefined) this.db.query("update task_meta set archived_at = ? where task_id = ?").run(patch.archived ? now() : null, id);
    return this.get(id);
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
      for (const t of adapter.listTasks()) out.push(fromProvider(workspace, t, meta.get(t.id) ?? null));
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
    if (!spec.slug?.trim()) throw new HttpError(400, "slug is required");
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
      .run(spec.id, workspace, spec.type ?? null, spec.slug, JSON.stringify(spec.repos), JSON.stringify({ root: dirs.root, repos: dirs.dirs }), sourceItem ?? null, now());
    return this.get(spec.id);
  }

  async remove(id: string): Promise<Task> {
    const task = this.get(id);
    if (task.state === "removed") return task;
    try {
      await this.adapter(task.workspace).removeTask(id);
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

export function taskRoutes(router: Router, tasks: Tasks, adapters: Map<string, WorkspaceAdapter>) {
  router
    .on("GET", "/api/workspaces", () =>
      json([...adapters.values()].map((a) => ({ id: a.config.id, adapter: a.config.adapter, root: a.config.root }))),
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
    .on("DELETE", "/api/tasks/:id", async (_req, p) => json(await tasks.remove(p.id!)));
}
