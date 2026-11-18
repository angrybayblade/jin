import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceConfig } from "../../config";
import { AdapterError, type AgentBrief, type BriefTask, type PolicyRules, type ProviderTask, type Repo, type ReviewedPR, type TaskDirs, type TaskKind, type TaskSpec, type ToolSpec, type WorkspaceAdapter, type WorkspaceProvider } from "../types";

const LINEAR_ID = /^[A-Z][A-Z0-9]*-\d+$/;

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
 * composio-workspace (cws): repos come from workspace.yaml (descriptions) and .gitmodules
 * (paths, branches); tasks are created and removed by the workspace's own `cws`.
 */
export class CwsAdapter implements WorkspaceAdapter {
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
          kind: t.kind === "review" ? "review" : "change",
          // A cws change is `task new linear --id <issue>`: its id is the Linear issue's.
          issue: t.kind !== "review" && LINEAR_ID.test(t.id ?? id) ? { tracker: "linear", id: t.id ?? id } : null,
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

  /**
   * Newer cws puts the task's kind first (`task new linear|review`); older ones take
   * `task new <ID> --type`. Read from its help, not its version number.
   */
  private kinds: boolean | null = null;
  private async hasKinds(): Promise<boolean> {
    if (this.kinds === null) this.kinds = (await this.run(["--help"]).catch(() => "")).includes("task new linear");
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

  /**
   * `cws task rm` removes the worktrees, skipping (with a warning, and success) any with
   * uncommitted changes, and leaves tasks/<id>/ behind (task.json, TASK.md), so the task would
   * still be listed. A worktree left in place is an error here; the rest of the folder goes.
   */
  async removeTask(id: string): Promise<void> {
    const before = this.listTasks().find((t) => t.id === id);
    await this.run(["task", "rm", id]);
    if (!before) return;
    const left = before.repos.filter((r) => existsSync(join(before.root, r)));
    if (left.length) throw new AdapterError(`kept ${left.join(", ")}: uncommitted changes there (commit or discard them, then remove the task again)`);
    rmSync(before.root, { recursive: true, force: true });
  }

  agentBrief(task: BriefTask): AgentBrief {
    const ws = this.root;
    if (task.kind === "review") {
      return {
        notes: "TASK.md",
        start: task.root ? `You start in the task's folder, ${task.root}: one worktree per repo, each detached at its PR's head, plus TASK.md (read it first; write your findings there).` : "",
        readable: `The whole workspace, ${ws}, is readable: its docs/map/README.md and map/ (how services fit together) and the other repos, to judge what a change affects.`,
        setup: `If running a repo's tests, typecheck or lint would settle something, install that repo: \`cws install <repo> --task ${task.id}\` (then \`cws check <repo>\` in its worktree). If the change can only be judged running (a flow across services, the dashboard), bring the local stack up: \`cws up --task ${task.id}\`, and \`cws down\` when done. Say in TASK.md what you set up and why. Nothing is ever deployed; cws refuses deploys.`,
      };
    }
    return {
      notes: "TASK.md",
      start: task.root ? `You start in the task's folder, ${task.root}: one worktree per repo, plus TASK.md (the task's notes: read it first, and keep it up to date).` : "",
      readable: `The whole workspace, ${ws}, is readable: its CLAUDE.md, docs/map/README.md and map/ (how services fit together), skills, and the other repos for reference. Make changes only in this task's worktrees; never edit ${ws}/repos/<repo>, which stays at its pin.`,
    };
  }

  checkCommands(): RegExp[] {
    return [/\bcws check\b/];
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

/** The usual places a composio workspace lives, under a home folder (its installer defaults to ~/composio-workspace). */
export const WORKSPACE_PLACES = ["composio-workspace", "Workspace/composio-workspace", "workspace/composio-workspace", "code/composio-workspace", "src/composio-workspace", "dev/composio-workspace"];

/** GitHub owners of a workspace's repos, from its .gitmodules. */
function ownersOf(root: string): string[] {
  try {
    const gm = parseGitmodules(readFileSync(join(root, ".gitmodules"), "utf8"));
    return [...new Set([...gm.values()].map((m) => m.url?.match(/github\.com[:/]([\w.-]+)\//)?.[1]).filter((o): o is string => !!o))];
  } catch {
    return [];
  }
}

const DOPPLER: ToolSpec = {
  id: "doppler",
  label: "Doppler",
  why: "Optional: only cws up (the local stack) needs it.",
  optional: true,
  install: 'have doppler || [ -z "$SUDO" ] || { echo "installing Doppler (optional)"; curl -Ls --tlsv1.2 --proto "=https" https://cli.doppler.com/install.sh | $SUDO sh >/dev/null 2>&1 || echo "doppler: not installed (only cws up needs it)"; }',
  status: `if command -v doppler >/dev/null; then if doppler me --json >/dev/null 2>&1; then echo "doppler yes $(doppler me --json 2>/dev/null | sed -n 's/.*"workplace":{[^}]*"name":"\\([^"]*\\)".*/\\1/p' | head -1)"; else echo "doppler no"; fi; else echo "doppler missing"; fi`,
  signIn: {
    command: "doppler login",
    url: /https:\/\/dashboard\.doppler\.com\S+/,
    code: /Your auth code is:\s*([a-z0-9_-]+)/i,
    answers: [{ when: /Open the authorization page in your browser\?/, keys: "n\r", prompt: "open" }],
    done: /Welcome|logged in|Authenticated/i,
  },
  token: { pattern: /^dp\.[a-z]+\.[\w-]{20,}$/i, hint: "Doppler service token: dp.st.dev.…", set: 'doppler configure set token "$t" --scope / >/dev/null' },
};

/** composio-workspace: a git repo of submodules (repos/<name>), with its `cws` tool in bin/. */
export const cwsProvider: WorkspaceProvider = {
  id: "cws",
  label: "composio-workspace",
  description: "the composio workspace: every platform repo and its cws tooling",
  taskKinds: [
    // A change is cws's `task new linear`: its id is the Linear issue's.
    { id: "change", label: "Linear change", autoId: false, idHint: "PLEN-123", types: ["bug", "feature", "enhancement", "refactor", "patch"] },
    { id: "review", label: "Review PRs", autoId: true, prs: true, note: "The task is numbered REV-<month><day><n>, each repo checked out at its PR's head." },
  ],
  detectScript: () => `
real() { readlink -f "$1" 2>/dev/null || python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$1" 2>/dev/null; }
if C=$(command -v cws 2>/dev/null); then
  R=$(real "$C"); W="\${R%/bin/cws}"
  if [ -n "$R" ] && [ "$W" != "$R" ] && [ -f "$W/workspace.yaml" ]; then echo "PREFERRED $(cd "$W" && pwd -P)"; fi
fi
for d in ${WORKSPACE_PLACES.join(" ")}; do
  p="$HOME/$d"
  if [ -f "$p/workspace.yaml" ] && [ -e "$p/bin/cws" ]; then echo "FOUND $(cd "$p" && pwd -P)"; fi
done
`,
  check: '[ -f "$ROOT/workspace.yaml" ] && [ -e "$ROOT/bin/cws" ]',
  install: {
    defaultRoot: "composio-workspace",
    script: `
if [ -d "$ROOT/.git" ]; then
  echo "updating the workspace at $ROOT"
  cd "$ROOT" && git pull --ff-only -q || true
  ./setup.sh --yes
else
  gh auth status >/dev/null 2>&1 || { echo "sign in to GitHub (gh) first: the workspace's repos are private"; exit 1; }
  echo "installing the composio workspace into $ROOT"
  gh api repos/ComposioHQ/workspace/contents/install.sh -H 'Accept: application/vnd.github.raw' | bash -s -- --yes --dir "$ROOT"
fi
`,
  },
  defaultId: "composio",
  owners: ownersOf,
  tools: () => [DOPPLER],
  create: (config) => new CwsAdapter(config),
};
