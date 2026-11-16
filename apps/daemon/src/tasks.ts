import type { Database } from "bun:sqlite";
import { AdapterError, type TaskSpec, type WorkspaceAdapter } from "./adapters";
import { now } from "./db";
import { body, HttpError, json, type Router } from "./http";

export interface Task {
  id: string;
  workspace: string;
  type: string | null;
  slug: string;
  repos: string[];
  root: string;
  dirs: Record<string, string>;
  state: "ready" | "removed";
  sourceItem: string | null;
  createdAt: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const toTask = (r: any): Task => {
  const dirs = JSON.parse(r.dirs);
  return {
    id: r.id,
    workspace: r.workspace,
    type: r.type,
    slug: r.slug,
    repos: JSON.parse(r.repos),
    root: dirs.root,
    dirs: dirs.repos,
    state: r.state,
    sourceItem: r.source_item,
    createdAt: r.created_at,
  };
};

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

  get(id: string): Task {
    const row = this.db.query("select * from tasks where id = ?").get(id);
    if (!row) throw new HttpError(404, `unknown task ${id}`);
    return toTask(row);
  }

  list(): Task[] {
    return this.db.query("select * from tasks order by created_at desc").all().map(toTask);
  }

  async start(workspace: string, spec: TaskSpec, sourceItem?: string): Promise<Task> {
    const adapter = this.adapter(workspace);
    if (!ID.test(spec.id ?? "")) throw new HttpError(400, "task id must be letters, digits, '.', '_' or '-'");
    if (!spec.slug?.trim()) throw new HttpError(400, "slug is required");
    if (!Array.isArray(spec.repos) || !spec.repos.length) throw new HttpError(400, "repos is required");
    const known = new Set((await adapter.repos()).map((r) => r.name));
    const unknown = spec.repos.filter((r) => !known.has(r));
    if (unknown.length) throw new HttpError(400, `unknown repos in ${workspace}: ${unknown.join(", ")}`);
    const existing = this.db.query("select state from tasks where id = ?").get(spec.id) as { state: string } | null;
    if (existing && existing.state !== "removed") throw new HttpError(409, `task ${spec.id} already exists`);

    let dirs;
    try {
      dirs = await adapter.startTask(spec);
    } catch (err) {
      if (err instanceof AdapterError) throw new HttpError(502, err.message);
      throw err;
    }
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
    this.db.query("update tasks set state = 'removed' where id = ?").run(id);
    return this.get(id);
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
    .on("DELETE", "/api/tasks/:id", async (_req, p) => json(await tasks.remove(p.id!)));
}
