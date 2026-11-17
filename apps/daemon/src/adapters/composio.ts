import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceConfig } from "../config";
import { AdapterError, type PolicyRules, type ProviderTask, type Repo, type ReviewedPR, type TaskDirs, type TaskKind, type TaskSpec, type WorkspaceAdapter } from "./types";

/** Parse .gitmodules into submodule name -> keys (path, url, branch). */
export function parseGitmodules(text: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  let current: Record<string, string> | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const head = line.match(/^\[submodule "(.+)"\]$/);
    if (head) out.set(head[1]!, (current = {}));
    else if (current && line.includes("=")) {
      const [k, ...v] = line.split("=");
      current[k!.trim()] = v.join("=").trim();
    }
  }
  return out;
}

/**
 * composio-workspace: repos come from workspace.yaml (descriptions) and .gitmodules
 * (paths, branches); tasks are created and removed by the workspace's own `cws`.
 */
export class ComposioAdapter implements WorkspaceAdapter {
  constructor(readonly config: WorkspaceConfig) {}

  private get root() {
    return this.config.root;
  }

  private cws(): string {
    const local = join(this.root, "bin", "cws");
    return existsSync(local) ? local : "cws";
  }

  /** Run the workspace's cws, passing its output on line by line (stdout and stderr, colours stripped). */
  private async run(args: string[], onOutput?: (line: string) => void): Promise<string> {
    const proc = Bun.spawn([this.cws(), ...args], { cwd: this.root, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    const tail: string[] = [];
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n|\r/);
        buffer = lines.pop() ?? "";
        for (const raw of lines) emit(raw);
      }
      if (buffer) emit(buffer);
    };
    const emit = (raw: string) => {
      const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd();
      if (!line) return;
      tail.push(line);
      if (tail.length > 200) tail.shift();
      onOutput?.(line);
    };
    const [, , code] = await Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]);
    if (code !== 0) throw new AdapterError(`cws ${args.join(" ")} failed (${code}): ${tail.slice(-20).join("\n").slice(-2000)}`);
    return tail.join("\n");
  }

  async repos(): Promise<Repo[]> {
    const yamlFile = join(this.root, "workspace.yaml");
    if (!existsSync(yamlFile)) throw new AdapterError(`${yamlFile} not found; is ${this.root} a composio workspace?`);
    const ws = (Bun.YAML.parse(readFileSync(yamlFile, "utf8")) as { repos?: Record<string, { description?: string }> }) ?? {};
    const gm = existsSync(join(this.root, ".gitmodules")) ? parseGitmodules(readFileSync(join(this.root, ".gitmodules"), "utf8")) : new Map();
    return Object.entries(ws.repos ?? {}).map(([name, entry]) => {
      const mod = [...gm.values()].find((m) => m.path === `repos/${name}`);
      return {
        name,
        path: join(this.root, mod?.path ?? `repos/${name}`),
        branch: mod?.branch ?? "main",
        description: entry?.description ?? "",
        github: mod?.url?.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1],
      };
    });
  }

  /** Tasks as `cws task list` sees them: every tasks/<id>/task.json (composio-workspace cli/src/tasks.ts). */
  listTasks(): ProviderTask[] {
    const dir = join(this.root, "tasks");
    if (!existsSync(dir)) return [];
    const out: ProviderTask[] = [];
    for (const id of readdirSync(dir)) {
      const file = join(dir, id, "task.json");
      if (!existsSync(file)) continue;
      try {
        const t = JSON.parse(readFileSync(file, "utf8")) as { id?: string; kind?: string; type?: string; branch?: string; repos?: string[]; prs?: ReviewedPR[]; title?: string; created?: string };
        const root = join(dir, id);
        const repos = Array.isArray(t.repos) ? t.repos.map(String) : [];
        out.push({
          id: t.id ?? id,
          type: t.type ?? null,
          slug: t.title?.trim() || slugFromBranch(t.branch, t.id ?? id),
          kind: t.kind === "review" ? "review" : "linear",
          ...(Array.isArray(t.prs) ? { prs: t.prs } : {}),
          branch: t.branch || null,
          repos,
          root,
          dirs: Object.fromEntries(repos.map((r) => [r, join(root, r)])),
          createdAt: t.created ?? new Date(0).toISOString(),
        });
      } catch {
        // an unreadable task.json is not a task, as for cws
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** cws 0.2 put the task's kind first (`task new linear|review`); older ones take `task new <ID> --type`. */
  private kinds: boolean | null = null;
  private async hasKinds(): Promise<boolean> {
    if (this.kinds === null) {
      const v = await this.run(["--version"]).catch(() => "");
      const m = /cws (\d+)\.(\d+)/.exec(v);
      this.kinds = Boolean(m && (Number(m[1]) > 0 || Number(m[2]) >= 2));
    }
    return this.kinds;
  }

  async nextTaskId(kind: TaskKind): Promise<string> {
    if (kind !== "review") throw new AdapterError("only review tasks are numbered by the workspace");
    if (!(await this.hasKinds())) throw new AdapterError("this workspace's cws has no review tasks; update it (cws update)");
    return (await this.run(["task", "next-id", "review"])).trim().split("\n").pop()!.trim();
  }

  async startTask(spec: TaskSpec, opts: { setup?: boolean; onOutput?: (line: string) => void } = {}): Promise<TaskDirs> {
    const kinds = await this.hasKinds();
    const args = ["task", "new"];
    if (spec.kind === "review") {
      if (!kinds) throw new AdapterError("this workspace's cws has no review tasks; update it (cws update)");
      args.push("review", "--id", spec.id, ...(spec.prs ?? []).flatMap((p) => ["--pr", p]));
      if (spec.slug) args.push("--slug", spec.slug);
    } else {
      if (kinds) args.push("linear", "--id", spec.id, "--change", spec.type || "feature");
      else args.push(spec.id, ...(spec.type ? ["--type", spec.type] : []));
      args.push("--repos", spec.repos.join(","), "--slug", spec.slug);
    }
    if (opts.setup !== false) args.push("--setup");
    await this.run(args, opts.onOutput);
    const root = join(this.root, "tasks", spec.id);
    return { root, dirs: Object.fromEntries(spec.repos.map((r) => [r, join(root, r)])) };
  }

  async removeTask(id: string): Promise<void> {
    await this.run(["task", "rm", id]);
  }

  policy(): PolicyRules {
    // composio-workspace's own rules: CLAUDE.md lists the outward actions to ask about,
    // and cws refuses deploys. Jin's base policy already covers both; nothing extra yet.
    return { deny: [], ask: [] };
  }
}

/** "fix/PLEN-4560-show-apollo-429s-correctly" -> "show apollo 429s correctly" (cws puts the slug only in the branch). */
export function slugFromBranch(branch: string | undefined, id: string): string {
  if (!branch) return id;
  const tail = branch.slice(branch.indexOf("/") + 1);
  const rest = tail.startsWith(id) ? tail.slice(id.length).replace(/^-/, "") : tail;
  return rest.replace(/-/g, " ").trim() || id;
}
