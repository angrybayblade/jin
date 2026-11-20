import { githubTracker } from "./github";
import { linearTracker } from "./linear";
import type { IssueDetails, IssueTracker } from "./types";

export type { IssueDetails, IssueTracker, TrackerView } from "./types";
export { trackerView } from "./types";

/** How to reach each tracker's issues (set by the daemon: Linear through Composio, GitHub through gh). */
export interface TrackerDeps {
  linear?: (id: string) => Promise<IssueDetails | null>;
  github?: (id: string) => Promise<IssueDetails | null>;
  /** The GitHub owners jin's workspaces use (a short repo#123 is theirs). */
  owners?: () => string[];
}

/** The trackers jin knows, by id ("none": a workspace whose tasks have no issues). */
export class Trackers {
  private all: Map<string, IssueTracker>;
  constructor(deps: TrackerDeps = {}) {
    this.all = new Map(
      [linearTracker({ lookup: deps.linear }), githubTracker({ owners: deps.owners ?? (() => []), lookup: deps.github })].map((t) => [t.id, t]),
    );
  }

  get(id: string | null | undefined): IssueTracker | null {
    return id && id !== "none" ? (this.all.get(id) ?? null) : null;
  }

  list(): IssueTracker[] {
    return [...this.all.values()];
  }

  ids(): string[] {
    return [...this.all.keys()];
  }

  /** The tracker an issue key belongs to ("linear:ENG-1"), and its id. */
  ofKey(key: string): { tracker: IssueTracker; id: string } | null {
    const at = key.indexOf(":");
    const tracker = at > 0 ? this.all.get(key.slice(0, at)) : undefined;
    return tracker ? { tracker, id: key.slice(at + 1) } : null;
  }

  /** An issue page from any tracker jin knows. */
  fromUrl(raw: string): { tracker: IssueTracker; id: string } | null {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    for (const tracker of this.all.values()) {
      const id = tracker.parseUrl(u);
      if (id) return { tracker, id };
    }
    return null;
  }

  /** Teach every tracker from a link (Linear learns its workspace's slug). */
  learn(url: string) {
    for (const t of this.all.values()) t.learn?.(url);
  }
}

/** The ids of the trackers jin ships with, for config checks. */
export const TRACKER_IDS = ["linear", "github", "none"] as const;
