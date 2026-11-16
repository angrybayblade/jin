import type { WorkspaceConfig } from "../config";

export interface Repo {
  name: string;
  path: string;
  branch: string;
  description: string;
}

export interface TaskSpec {
  id: string;
  type?: string;
  repos: string[];
  slug: string;
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
  startTask(spec: TaskSpec): Promise<TaskDirs>;
  removeTask(id: string): Promise<void>;
  policy(): PolicyRules;
}

export class AdapterError extends Error {}
