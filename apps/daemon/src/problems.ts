import { json, type Router } from "./http";

/** Something jin did in the background that failed: syncing PRs, a tunnel, a title lookup… */
export interface Problem {
  /** What jin was doing ("PR sync", "tunnel to hub"). */
  scope: string;
  message: string;
  /** How many times in a row it failed the same way. */
  count: number;
  firstAt: string;
  lastAt: string;
}

const MAX = 100;

/**
 * Background failures, kept so they are seen: each is logged, and the last ones (the same
 * failure counted, not repeated) are listed for the app. A failure the user waits on is not
 * one of these: it is answered to them directly.
 */
export class Problems {
  private list: Problem[] = [];
  /** When each was last seen, in order (times can tie). */
  private order = new WeakMap<Problem, number>();
  private n = 0;

  /** Record a failure. */
  add(scope: string, err: unknown) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 500) || "failed";
    const at = new Date().toISOString();
    const same = this.list.find((p) => p.scope === scope && p.message === message);
    if (same) {
      same.count++;
      same.lastAt = at;
      this.order.set(same, ++this.n);
    } else {
      const p = { scope, message, count: 1, firstAt: at, lastAt: at };
      this.order.set(p, ++this.n);
      this.list.push(p);
      if (this.list.length > MAX) this.list.shift();
    }
    console.error(`[${scope}] ${message}`);
  }

  /** A `.catch` that records the failure under `scope` (and resolves to `fallback`). */
  catch<T = undefined>(scope: string, fallback?: T): (err: unknown) => T {
    return (err) => {
      this.add(scope, err);
      return fallback as T;
    };
  }

  /** Newest first. */
  recent(): Problem[] {
    return [...this.list].sort((a, b) => (this.order.get(b) ?? 0) - (this.order.get(a) ?? 0));
  }

  clear() {
    this.list = [];
  }
}

/** One per daemon. */
export const problems = new Problems();

export function problemRoutes(router: Router, p: Problems = problems) {
  router
    .on("GET", "/api/problems", () => json(p.recent()))
    .on("DELETE", "/api/problems", () => {
      p.clear();
      return json({ cleared: true });
    });
}
