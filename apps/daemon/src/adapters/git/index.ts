import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { WorkspaceConfig } from "../../config";
import { AdapterError, SCRATCH_RULE, type AgentBrief, type BriefTask, type PolicyRules, type ProviderTask, type Repo, type ReviewedPR, type TaskDirs, type TaskKind, type TaskSpec, type WorkspaceAdapter, type WorkspaceProvider } from "../types";

/**
 * A plain git workspace: one git clone, or a folder whose subfolders are git clones. A task
 * gets a git worktree per repo (a branch for a change, detached at the PR's head for a review)
 * and its record in task.json next to them. Tasks live outside the clones:
 *   a folder of clones  <root>/.jin-tasks/<id>/<repo>
 *   one clone           <root>/../.jin-tasks/<repo>/<id>/<repo>
 * No tooling of its own; one clone can be installed from a repo (gh or git clones it).
 */

const TASKS_DIR = ".jin-tasks";

interface Record_ {
  id: string;
  kind: TaskKind;
  type?: string | null;
  title: string;
  branch: string | null;
  repos: string[];
  prs?: ReviewedPR[];
  created: string;
}

function git(cwd: string, args: string[], onOutput?: (line: string) => void): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (onOutput) for (const l of out.split("\n").filter(Boolean)) onOutput(l);
  if (r.status !== 0) throw new AdapterError(`git ${args.join(" ")} (in ${cwd}) failed: ${out.slice(-1500)}`);
  return (r.stdout ?? "").trim();
}

const tryGit = (cwd: string, args: string[]) => {
  try {
    return git(cwd, args);
  } catch {
    return "";
  }
};

/** owner/name from a GitHub remote URL. */
const githubOf = (url: string) => url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];

/** `root` is itself a clone: a workspace of that one repo. */
const isClone = (root: string) => existsSync(join(root, ".git"));

/** The workspace's repos by name: the clone itself, or the subfolders of `root` that are git repos. */
function repoDirs(root: string): string[] {
  if (isClone(root)) return [basename(root)];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(join(root, d.name, ".git")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

export class GitAdapter implements WorkspaceAdapter {
  constructor(readonly config: WorkspaceConfig) {}

  private get root() {
    return this.config.root;
  }
  private get single() {
    return isClone(this.root);
  }
  /** A repo's clone. */
  private src(repo: string) {
    return this.single && repo === basename(this.root) ? this.root : join(this.root, repo);
  }
  /** Where tasks live: never inside a clone. */
  private get tasksDir() {
    return this.single ? join(dirname(this.root), TASKS_DIR, basename(this.root)) : join(this.root, TASKS_DIR);
  }
  private taskDir(id: string) {
    return join(this.tasksDir, id);
  }

  /** The branch a repo's tasks start from: origin's default, else what is checked out. */
  private base(dir: string): string {
    const head = tryGit(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (head) return head;
    return tryGit(dir, ["symbolic-ref", "--short", "HEAD"]) || "HEAD";
  }

  async repos(): Promise<Repo[]> {
    return repoDirs(this.root).map((name) => {
      const dir = this.src(name);
      return { name, path: dir, branch: this.base(dir).replace(/^origin\//, ""), description: "", github: githubOf(tryGit(dir, ["remote", "get-url", "origin"])) };
    });
  }

  listTasks(): ProviderTask[] {
    const dir = this.tasksDir;
    if (!existsSync(dir)) return [];
    const out: ProviderTask[] = [];
    for (const id of readdirSync(dir)) {
      try {
        const t = JSON.parse(readFileSync(join(dir, id, "task.json"), "utf8")) as Record_;
        const root = join(dir, id);
        out.push({
          id: t.id,
          kind: t.kind === "review" ? "review" : t.kind === "scratch" ? "scratch" : "change",
          type: t.kind === "review" ? "review" : t.kind === "scratch" ? "scratch" : (t.type ?? null),
          slug: t.title || t.id,
          branch: t.branch,
          repos: t.repos,
          root,
          dirs: Object.fromEntries(t.repos.map((r) => [r, join(root, r)])),
          createdAt: t.created,
          ...(t.prs ? { prs: t.prs } : {}),
          issue: null,
        });
      } catch {
        // not a task
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async nextTaskId(kind: TaskKind): Promise<string> {
    if (kind === "change") throw new AdapterError("only review and scratch tasks are numbered by the workspace");
    const d = new Date();
    const prefix = `${kind === "scratch" ? "EXP" : "REV"}-${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const taken = new Set(this.listTasks().map((t) => t.id));
    for (let n = 1; n < 100; n++) {
      const id = `${prefix}${String(n).padStart(2, "0")}`;
      if (!taken.has(id) && !existsSync(this.taskDir(id))) return id;
    }
    throw new AdapterError(`too many ${kind} tasks today`);
  }

  async startTask(spec: TaskSpec, opts: { setup?: boolean; onOutput?: (line: string) => void } = {}): Promise<TaskDirs> {
    const say = opts.onOutput ?? (() => {});
    const root = this.taskDir(spec.id);
    if (existsSync(root)) throw new AdapterError(`task ${spec.id} already exists`);
    mkdirSync(root, { recursive: true });
    const dirs: Record<string, string> = {};
    const prs: ReviewedPR[] = [];
    let branch: string | null = null;
    try {
      if (spec.kind === "review") {
        for (const ref of spec.prs ?? []) {
          const [repo, num] = ref.split("#");
          const src = this.src(repo!);
          if (!repoDirs(this.root).includes(repo!)) throw new AdapterError(`${repo} is not a repo of this workspace`);
          say(`fetching ${repo} pull request ${num}`);
          git(src, ["fetch", "-q", "origin", `pull/${num}/head`]);
          const head = git(src, ["rev-parse", "FETCH_HEAD"]);
          dirs[repo!] = join(root, repo!);
          git(src, ["worktree", "add", "-q", "--detach", dirs[repo!]!, head], say);
          const gh = githubOf(tryGit(src, ["remote", "get-url", "origin"]));
          prs.push({ repo: repo!, number: Number(num), head, ...(gh ? { url: `https://github.com/${gh}/pull/${num}` } : {}) });
        }
      } else {
        branch = `${spec.kind === "scratch" ? "scratch" : spec.type || "change"}/${spec.id}${spec.slug ? `-${slugify(spec.slug)}` : ""}`;
        for (const repo of spec.repos) {
          const src = this.src(repo);
          if (!repoDirs(this.root).includes(repo)) throw new AdapterError(`${repo} is not a repo of this workspace`);
          if (tryGit(src, ["remote"])) {
            say(`fetching ${repo}`);
            tryGit(src, ["fetch", "-q", "origin"]);
          }
          dirs[repo] = join(root, repo);
          git(src, ["worktree", "add", "-q", "-b", branch, dirs[repo]!, this.base(src)], say);
        }
      }
    } catch (err) {
      this.cleanup(spec.id, Object.keys(dirs));
      throw err;
    }
    const record: Record_ = { id: spec.id, kind: spec.kind === "review" ? "review" : spec.kind === "scratch" ? "scratch" : "change", type: spec.kind === "scratch" ? "scratch" : (spec.type ?? null), title: spec.slug || spec.id, branch, repos: Object.keys(dirs), created: new Date().toISOString(), ...(prs.length ? { prs } : {}) };
    writeFileSync(join(root, "task.json"), `${JSON.stringify(record, null, 2)}\n`);
    say(`task ${spec.id} ready at ${root}`);
    return { root, dirs };
  }

  private cleanup(id: string, repos: string[]) {
    for (const r of repos) tryGit(this.src(r), ["worktree", "remove", "--force", join(this.taskDir(id), r)]);
    rmSync(this.taskDir(id), { recursive: true, force: true });
  }

  /**
   * Remove the task's worktrees (jin has already checked nothing unsaved is lost) and its folder;
   * its branches stay, except a discarded scratch task's.
   */
  async removeTask(id: string, opts: { discard?: boolean } = {}): Promise<void> {
    const t = this.listTasks().find((x) => x.id === id);
    if (!t) throw new AdapterError(`no task ${id}`);
    if (opts.discard && t.kind !== "scratch") throw new AdapterError(`only scratch tasks are discarded; ${id} is a ${t.kind} task`);
    for (const r of t.repos) {
      const src = this.src(r);
      if (existsSync(join(t.root, r))) git(src, ["worktree", "remove", "--force", join(t.root, r)]);
      tryGit(src, ["worktree", "prune"]);
      if (opts.discard && t.branch?.startsWith("scratch/")) tryGit(src, ["branch", "-D", t.branch]);
    }
    rmSync(t.root, { recursive: true, force: true });
  }

  agentBrief(task: BriefTask): AgentBrief {
    const where = task.root ? `You start in the task's folder, ${task.root}: a git worktree per repo (${task.repos.join(", ")})` : "";
    return task.kind === "review"
      ? { start: where ? `${where}, each detached at its pull request's head.` : "" }
      : task.kind === "scratch"
      ? { start: where ? `${where}, on the task's scratch branch.` : "", rules: [SCRATCH_RULE] }
      : { start: where ? `${where}, on the task's own branch.` : "", readable: this.single ? `The clone at ${this.root} is readable for reference; make changes only in this task's worktrees.` : `The other clones in ${this.root} are readable for reference; make changes only in this task's worktrees.` };
  }

  policy(): PolicyRules {
    return { deny: [], ask: [] };
  }
}

/**
 * A repo to clone, as typed: owner/repo or a GitHub page or remote (gh clones it, with your
 * sign-in), or any other git URL (git clones it). Plain characters only: it goes into a script.
 */
export function parseRepo(text: string): { source: string; root: string; id: string } | null {
  const t = text.trim().replace(/\/+$/, "");
  if (!/^[\w.@:/+~-]+$/.test(t) || t.startsWith("-")) return null;
  const gh = /^(?:(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[:/])?([\w-][\w.-]*)\/([\w.-]+?)(?:\.git)?$/.exec(t);
  const url = /^(?:https?|ssh|git|file):\/\/[\w.@:/+~-]+$|^[\w.-]+@[\w.-]+:[\w./+~-]+$/.test(t);
  const name = (gh ? gh[2]! : url ? (t.split(/[/:]/).pop() ?? "").replace(/\.git$/, "") : "").replace(/^\.+/, "");
  if (!name || (!gh && !url)) return null;
  const id = slugify(name) || "repo";
  return { source: gh ? `${gh[1]}/${gh[2]}` : t, root: `repos/${name}`, id };
}

/** One git clone, or a folder of them. */
export const gitProvider: WorkspaceProvider = {
  id: "git",
  label: "Git repo",
  description: "a git clone, or a folder whose subfolders are git clones; each task gets a git worktree per repo",
  taskKinds: [
    { id: "change", label: "Change", autoId: false, idHint: "ENG-123" },
    { id: "review", label: "Review PRs", autoId: true, prs: true, note: "The task is numbered REV-<month><day><n>, each repo checked out at its PR's head." },
    { id: "scratch", label: "Scratch", autoId: true, note: "An experiment on a scratch/ branch, numbered EXP-<month><day><n>. Discard it when done: everything goes." },
  ],
  // Nothing to find on its own: any clone or folder of clones could be one, so it is given by path.
  detectScript: () => "true",
  check: '[ -e "$ROOT/.git" ] && exit 0; for d in "$ROOT"/*/; do [ -e "$d.git" ] && exit 0; done; exit 1',
  install: {
    defaultRoot: "repos",
    source: { label: "Repo", hint: "owner/repo or a git URL", parse: parseRepo },
    script: `
if [ -e "$ROOT/.git" ]; then
  echo "using the clone already at $ROOT"
  git -C "$ROOT" fetch -q origin || true
elif [ -e "$ROOT" ]; then
  echo "$ROOT exists and is not a git clone"; exit 1
else
  mkdir -p "$(dirname "$ROOT")"
  case "$SOURCE" in
    *:*) echo "cloning $SOURCE into $ROOT"; git clone -q -- "$SOURCE" "$ROOT" ;;
    *) gh auth status >/dev/null 2>&1 || { echo "sign in to GitHub (gh) first"; exit 1; }
       echo "cloning $SOURCE into $ROOT"; gh repo clone "$SOURCE" "$ROOT" -- -q ;;
  esac
fi
`,
  },
  defaultId: "repos",
  idFor: (root) => (isClone(root) ? slugify(basename(root)) || null : null),
  owners: (root) => [...new Set(repoDirs(root).map((r) => githubOf(tryGit(isClone(root) ? root : join(root, r), ["remote", "get-url", "origin"]))?.split("/")[0]).filter((o): o is string => !!o))],
  tools: () => [],
  create: (config) => new GitAdapter(config),
};
