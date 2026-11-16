import { existsSync } from "node:fs";
import { join } from "node:path";
import { HttpError, json, type Router } from "./http";
import type { Tasks } from "./tasks";

/**
 * Fuzzy score of `query` against `path` (higher is better), or null when the query's
 * characters do not appear in order. Favours matches in the file name, at word starts
 * (after / . _ - or a case change) and in runs, like editor quick-open.
 */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const p = path.toLowerCase();
  // Matching greedily from the first occurrence lets an early letter (the "t" in "platform")
  // break up a strong run later on; try each place the query could start and keep the best.
  let best: number | null = null;
  let from = p.indexOf(q[0]!);
  for (let tries = 0; from >= 0 && tries < 40; tries++) {
    const s = scoreFrom(q, path, p, from);
    if (s !== null && (best === null || s > best)) best = s;
    from = p.indexOf(q[0]!, from + 1);
  }
  return best;
}

function scoreFrom(q: string, path: string, p: string, start: number): number | null {
  const nameStart = path.lastIndexOf("/") + 1;
  let score = 0;
  let pi = start;
  let run = 0;
  let firstMatch = -1;
  for (const ch of q) {
    const at = p.indexOf(ch, pi);
    if (at < 0) return null;
    if (firstMatch < 0) firstMatch = at;
    const prev = path[at - 1];
    const boundary = at === 0 || prev === "/" || prev === "." || prev === "_" || prev === "-" || (prev !== undefined && prev === prev.toLowerCase() && path[at] !== path[at]!.toLowerCase());
    run = at === pi && at > start ? run + 1 : 0;
    score += 1 + (boundary ? 6 : 0) + run * 4 + (at >= nameStart ? 3 : 0);
    pi = at + 1;
  }
  // Shorter paths and matches that start in the file name rank higher.
  if (firstMatch >= nameStart) score += 8;
  if (p.slice(nameStart).startsWith(q)) score += 12;
  return score - path.length * 0.02;
}

interface Listing {
  at: number;
  files: string[];
}

async function git(args: string[], cwd: string, timeoutMs = 10_000): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  return out;
}

/** Files and text in a task's worktrees, for the file finder and search in files. */
export class Finder {
  private cache = new Map<string, Listing>();

  constructor(private tasks: Tasks) {}

  private dirs(taskId: string): [string, string][] {
    const t = this.tasks.get(taskId);
    if (t.state !== "ready") throw new HttpError(409, `task ${taskId} is ${t.state}`);
    return Object.entries(t.dirs).filter(([, d]) => existsSync(d));
  }

  /** Tracked and untracked (not ignored) files, as task-relative paths (repo/path). Cached briefly. */
  async files(taskId: string): Promise<string[]> {
    const hit = this.cache.get(taskId);
    if (hit && Date.now() - hit.at < 20_000) return hit.files;
    const lists = await Promise.all(
      this.dirs(taskId).map(async ([repo, dir]) =>
        (await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], dir))
          .split("\0")
          .filter(Boolean)
          .map((f) => `${repo}/${f}`),
      ),
    );
    const files = [...new Set(lists.flat())];
    this.cache.set(taskId, { at: Date.now(), files });
    return files;
  }

  async find(taskId: string, query: string, limit = 50): Promise<{ path: string; score: number }[]> {
    const files = await this.files(taskId);
    if (!query.trim()) return files.slice(0, limit).map((path) => ({ path, score: 0 }));
    const scored: { path: string; score: number }[] = [];
    for (const path of files) {
      const score = fuzzyScore(query, path);
      if (score !== null) scored.push({ path, score });
    }
    return scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length).slice(0, limit);
  }

  /** Lines containing `query` (case-insensitive, literal), across the task's repos. */
  async grep(taskId: string, query: string, limit = 200): Promise<{ path: string; line: number; text: string }[]> {
    if (query.trim().length < 2) return [];
    const out: { path: string; line: number; text: string }[] = [];
    for (const [repo, dir] of this.dirs(taskId)) {
      if (out.length >= limit) break;
      const res = await git(["grep", "-n", "-I", "-i", "-F", "--untracked", "--exclude-standard", "--max-count=20", "-e", query], dir);
      for (const row of res.split("\n")) {
        const m = row.match(/^(.+?):(\d+):(.*)$/);
        if (!m) continue;
        out.push({ path: `${repo}/${m[1]}`, line: Number(m[2]), text: m[3]!.trim().slice(0, 240) });
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}

export function finderRoutes(router: Router, finder: Finder) {
  router
    .on("GET", "/api/tasks/:id/find", async (_req, p, url) => json(await finder.find(p.id!, url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 50))))
    .on("GET", "/api/tasks/:id/grep", async (_req, p, url) => json(await finder.grep(p.id!, url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 200))));
}
