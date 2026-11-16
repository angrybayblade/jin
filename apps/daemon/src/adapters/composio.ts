import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceConfig } from "../config";
import { AdapterError, type PolicyRules, type Repo, type TaskDirs, type TaskSpec, type WorkspaceAdapter } from "./types";

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

  private async run(args: string[]): Promise<string> {
    const proc = Bun.spawn([this.cws(), ...args], { cwd: this.root, env: process.env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new AdapterError(`cws ${args.join(" ")} failed (${code}): ${(err || out).trim().slice(-2000)}`);
    return out;
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
      };
    });
  }

  async startTask(spec: TaskSpec): Promise<TaskDirs> {
    const args = ["task", "new", spec.id];
    if (spec.type) args.push("--type", spec.type);
    args.push("--repos", spec.repos.join(","), "--slug", spec.slug, "--setup");
    await this.run(args);
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
