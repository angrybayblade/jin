import type { WorkspaceConfig } from "../config";

export interface Repo {
  name: string;
  path: string;
  branch: string;
  description: string;
  /** owner/name on GitHub, when known (to find the repo of a pull request). */
  github?: string;
}

/** A change from a Linear issue (the default), or a review of pull requests. */
export type TaskKind = "linear" | "review";

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
 * What jin needs from an organisation's workspace. Jin's core knows nothing about a
 * particular organisation; composio-workspace is one adapter, another organisation's
 * workspace is another.
 */
export interface WorkspaceAdapter {
  readonly config: WorkspaceConfig;
  repos(): Promise<Repo[]>;
  /**
   * The workspace's tasks, including ones created outside jin (e.g. `cws task new` in a
   * terminal). This is the task-provider surface: jin lists what the workspace has and only
   * adds its own metadata on top. Synchronous because it reads local files; a remote
   * provider would serve a cached snapshot.
   */
  listTasks(): ProviderTask[];
  /** Create a task; `onOutput` receives the workspace tooling's output line by line (for live progress). */
  startTask(spec: TaskSpec, opts?: { setup?: boolean; onOutput?: (line: string) => void }): Promise<TaskDirs>;
  removeTask(id: string): Promise<void>;
  /** The id the workspace gives the next task of this kind (review tasks are numbered by it). */
  nextTaskId?(kind: TaskKind): Promise<string>;
  policy(): PolicyRules;
}

export class AdapterError extends Error {}
