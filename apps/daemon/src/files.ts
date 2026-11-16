import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { body, HttpError, json, type Router } from "./http";
import type { Tasks } from "./tasks";

const HIDDEN = new Set([".git", "node_modules", ".next", "dist", ".turbo", ".venv", "__pycache__", ".DS_Store"]);
const MAX_FILE = 1024 * 1024;

/** Resolve a path inside root, refusing anything that escapes it (including through symlinks). */
export function within(root: string, rel: string): string {
  const base = realpathSync(root);
  const target = resolve(base, rel || ".");
  const real = existsSync(target) ? realpathSync(target) : target;
  if (real !== base && !real.startsWith(base + sep)) throw new HttpError(400, "path is outside the task");
  return real;
}

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
}

export function listDir(root: string, rel: string): Entry[] {
  const dir = within(root, rel);
  const base = realpathSync(root);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => !HIDDEN.has(d.name))
    .map((d) => ({ name: d.name, path: relative(base, join(dir, d.name)), dir: d.isDirectory() || (d.isSymbolicLink() && statSync(join(dir, d.name), { throwIfNoEntry: false })?.isDirectory() === true) }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out : "";
}

export function fileRoutes(router: Router, tasks: Tasks) {
  const root = (id: string) => {
    const t = tasks.get(id);
    if (t.state !== "ready") throw new HttpError(409, `task ${id} is ${t.state}`);
    return t.root;
  };
  router
    .on("GET", "/api/tasks/:id/files", (_req, p, url) => json(listDir(root(p.id!), url.searchParams.get("path") ?? "")))
    .on("GET", "/api/tasks/:id/file", (_req, p, url) => {
      const file = within(root(p.id!), url.searchParams.get("path") ?? "");
      const st = statSync(file);
      if (!st.isFile()) throw new HttpError(400, "not a file");
      if (st.size > MAX_FILE) throw new HttpError(413, "file is larger than 1 MB");
      const buf = readFileSync(file);
      if (buf.includes(0)) throw new HttpError(415, "binary file");
      return json({ path: url.searchParams.get("path"), content: buf.toString("utf8") });
    })
    .on("PUT", "/api/tasks/:id/file", async (req, p) => {
      const { path, content } = await body<{ path: string; content: string }>(req);
      if (typeof content !== "string" || content.length > MAX_FILE) throw new HttpError(400, "content must be text under 1 MB");
      const file = within(root(p.id!), path);
      if (existsSync(file) && !statSync(file).isFile()) throw new HttpError(400, "not a file");
      writeFileSync(file, content);
      return json({ path, saved: true });
    })
    .on("GET", "/api/tasks/:id/diff", async (_req, p) => {
      const task = tasks.get(p.id!);
      const repos = await Promise.all(
        Object.entries(task.dirs).map(async ([repo, dir]) => {
          if (!existsSync(dir)) return { repo, branch: "", diff: "", untracked: [] as string[] };
          const [branch, diff, untracked] = await Promise.all([
            git(["rev-parse", "--abbrev-ref", "HEAD"], dir),
            git(["diff", "HEAD", "--no-color"], dir),
            git(["ls-files", "--others", "--exclude-standard"], dir),
          ]);
          return { repo, branch: branch.trim(), diff, untracked: untracked.split("\n").filter(Boolean) };
        }),
      );
      return json(repos);
    });
}
