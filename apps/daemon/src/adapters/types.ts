import type { WorkspaceConfig } from "../config";

export interface Repo {
  name: string;
  path: string;
  branch: string;
  description: string;
  /** owner/name on GitHub, when known (to find the repo of a pull request). */
  github?: string;
}

/** A change to make (the default), or a review of pull requests. */
export type TaskKind = "change" | "review";

/** Older names for a kind (jin used to call a change "linear"). */
export const taskKindOf = (k: unknown): TaskKind => (k === "review" ? "review" : "change");

export interface TaskSpec {
  id: string;
  kind?: TaskKind;
  /** The change kind (feature, bug, ...); a review task has none. */
  type?: string;
  repos: string[];
  slug: string;
  /** A review task's pull requests, as <repo>#<number>. */
  prs?: string[];
}

/** A pull request a review task checks out. */
export interface ReviewedPR {
  repo: string;
  number: number;
  head?: string;
  title?: string;
  url?: string;
}

export interface TaskDirs {
  /** The task's root directory, where agent sessions start. */
  root: string;
  /** One checkout per repo. */
  dirs: Record<string, string>;
}

/** A task as the workspace knows it: the workspace is the source of truth for its tasks. */
export interface ProviderTask {
  id: string;
  type: string | null;
  /** Short title. */
  slug: string;
  branch: string | null;
  repos: string[];
  root: string;
  dirs: Record<string, string>;
  createdAt: string;
  kind?: TaskKind;
  prs?: ReviewedPR[];
}

/** Deny and approval rules a workspace contributes on top of jin's own. */
export interface PolicyRules {
  deny: { pattern: RegExp; why: string }[];
  ask: { pattern: RegExp; why: string }[];
}

/**
 * The workspace contract: what jin needs from a workspace to run tasks in it. jin's core
 * knows nothing about any particular workspace; each provider (cws, plain git, …) implements
 * this, and jin works with any workspace that does.
 *
 * Two halves: a WorkspaceProvider (finding, installing and configuring workspaces of its
 * kind, before one exists in jin), and a WorkspaceAdapter (one configured workspace: its
 * repos and tasks, and what an agent working in it should know).
 */
export interface WorkspaceAdapter {
  readonly config: WorkspaceConfig;
  repos(): Promise<Repo[]>;
  /**
   * The workspace's tasks, including ones created outside jin (with the workspace's own
   * tooling, in a terminal). The workspace is the source of truth; jin adds its metadata on
   * top. Synchronous because it reads local files; a remote provider would serve a snapshot.
   */
  listTasks(): ProviderTask[];
  /** Create a task; `onOutput` receives the workspace tooling's output line by line (for live progress). */
  startTask(spec: TaskSpec, opts?: { setup?: boolean; onOutput?: (line: string) => void }): Promise<TaskDirs>;
  removeTask(id: string): Promise<void>;
  /** The id the workspace gives the next task of this kind, for kinds it numbers itself. */
  nextTaskId?(kind: TaskKind): Promise<string>;
  /** What Claude Code working in one of its tasks should know about the workspace. */
  agentBrief(task: BriefTask): AgentBrief;
  /** Commands that run the workspace's checks (tests, typecheck, lint), beyond the usual ones jin knows. */
  checkCommands?(): RegExp[];
  /** Deny and approval rules on top of jin's own. */
  policy(): PolicyRules;
}

/** The parts of a task a brief is written from. */
export interface BriefTask {
  id: string;
  kind: TaskKind;
  root?: string;
  repos: string[];
}

/**
 * What an agent in a task is told about the workspace (jin adds its own rules around it).
 * Each field is a sentence or a few, in the agent's voice-neutral instruction style.
 */
export interface AgentBrief {
  /** Where the agent starts and what is there (the task folder, its checkouts, a notes file). */
  start: string;
  /** What else it may read for context (the workspace's docs, other repos), and what not to touch. */
  readable?: string;
  /** How to set up a repo or the stack when the work needs it running (review tasks start with nothing installed). */
  setup?: string;
  /** The workspace's own must-follow rules. */
  rules?: string[];
  /** The file the task's notes (or a review's findings) go in, when the workspace has one. */
  notes?: string;
}

/** A command-line tool a workspace needs on a machine, beyond git, gh and Claude Code. */
export interface ToolSpec {
  id: string;
  label: string;
  /** Shown next to it: what it is for. */
  why: string;
  /** Optional tools are not needed for a machine to be ready. */
  optional: boolean;
  /** POSIX sh that installs it (may use $SUDO); run once when a machine is set up. */
  install?: string;
  /** POSIX sh that prints `<id> yes [account]`, `<id> no` or `<id> missing`. */
  status: string;
  /** The interactive sign-in command, run in a terminal. */
  signIn?: string;
  /** A link the sign-in prints, to open in the browser (its pattern). */
  signInUrl?: RegExp;
}

/** A workspace of this provider's kind found on a machine. */
export interface Detected {
  provider: string;
  root: string;
  /** The one the machine's own tooling points at (offered first). */
  preferred: boolean;
}

/** One kind of workspace: finds, installs and configures workspaces of its kind. */
export interface WorkspaceProvider {
  /** Its name in a workspace's config (`adapter: <id>`). */
  readonly id: string;
  readonly label: string;
  /** One line, for setup: what a workspace of this kind is. */
  readonly description: string;
  /** The kinds of task its workspaces run. */
  readonly taskKinds: TaskKindSpec[];
  /**
   * POSIX sh that finds workspaces of this kind under $HOME, run on this machine or over SSH:
   * prints `FOUND <root>` per workspace and `PREFERRED <root>` for the one the machine's
   * tooling points at. PATH is set up before it runs.
   */
  detectScript(): string;
  /** POSIX sh that exits 0 when $ROOT is a workspace of this kind (here or over SSH). */
  readonly check: string;
  /**
   * Installing a workspace of this kind: where by default (relative to $HOME), and POSIX sh
   * that installs it into $ROOT, or updates one already there. Absent: it can only be used.
   */
  install?: { defaultRoot: string; script: string };
  /** The id a new workspace of this kind gets in jin. */
  readonly defaultId: string;
  /** GitHub owners of a workspace's repos (to tell its pull requests apart), read from the workspace at `root`. */
  owners(root: string): string[];
  /** Tools its workspaces need on a machine. */
  tools(): ToolSpec[];
  create(config: WorkspaceConfig): WorkspaceAdapter;
}

/** A kind of task, as the new-task form and jin's chat offer it. */
export interface TaskKindSpec {
  id: TaskKind;
  label: string;
  /** The workspace picks the id (nextTaskId); otherwise the user gives one. */
  autoId: boolean;
  /** A hint for the id field, e.g. "PLEN-123". */
  idHint?: string;
  /** Change types to choose from (feature, bug, …), when the kind has them. */
  types?: string[];
  /** It checks out pull requests (and takes no repos or slug). */
  prs?: boolean;
  /** One line for the form, about how the workspace handles it (its numbering, what comes with it). */
  note?: string;
}

export class AdapterError extends Error {}
