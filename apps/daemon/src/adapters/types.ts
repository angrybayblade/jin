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
  startTask(spec: TaskSpec): Promise<TaskDirs>;
  removeTask(id: string): Promise<void>;
  policy(): PolicyRules;
}

export class AdapterError extends Error {}
