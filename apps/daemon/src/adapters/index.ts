import type { WorkspaceConfig } from "../config";
import { ComposioAdapter } from "./composio";
import { AdapterError, type WorkspaceAdapter } from "./types";

export function createAdapter(config: WorkspaceConfig): WorkspaceAdapter {
  switch (config.adapter) {
    case "composio":
      return new ComposioAdapter(config);
    case "git":
      // The plain-git fallback (clones + git worktree) is planned for v1.
      throw new AdapterError(`${config.id}: the git adapter is not available yet (v1)`);
  }
}

export * from "./types";
