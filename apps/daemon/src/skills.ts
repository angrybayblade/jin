import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { body, HttpError, json, type Router } from "./http";

/**
 * jin's own skills: Claude Code skills (a SKILL.md each) that you keep in jin and tag. A task
 * gets the skills whose tags it asks for (a review task: `pr-review`), as a plugin Claude Code
 * loads with --plugin-dir, so they show as /jin:<name>. Nothing is written into the workspace.
 *
 * Skills live on the home (hub) when there is one: the store there is the one you edit, and a
 * machine fetches the tagged skills from it when a task's Claude Code starts.
 */

export interface Skill {
  name: string;
  /** From the SKILL.md frontmatter. */
  description: string;
  tags: string[];
  updatedAt: string;
}

export interface SkillBody {
  name: string;
  body: string;
  tags: string[];
}

/** The tags each kind of task asks for; `every-task` goes to all of them. */
export const TASK_TAGS: Record<string, string[]> = {
  review: ["pr-review"],
  linear: ["linear-task"],
};
export const EVERY_TASK = "every-task";
export const tagsFor = (kind: string | null | undefined) => [...(TASK_TAGS[kind ?? "linear"] ?? []), EVERY_TASK];

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TAG = /^[a-z0-9][a-z0-9:-]{0,63}$/;

/** The frontmatter's description (one line), or "". */
export function describe(md: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
  const line = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? "";
  return line.replace(/^["']|["']$/g, "");
}

/** A SKILL.md with the frontmatter Claude Code needs (name, description), keeping what is written. */
export function withFrontmatter(name: string, md: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(md);
  if (fm) return /^name:/m.test(fm[1]!) ? md : md.replace(/^---\n/, `---\nname: ${name}\n`);
  const first = md.trim().split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? name;
  return `---\nname: ${name}\ndescription: ${first.slice(0, 200)}\n---\n\n${md.trim()}\n`;
}

export class Skills {
  constructor(private home: string) {}

  private get dir() {
    return join(this.home, "skills");
  }
  private get tagsFile() {
    return join(this.home, "skills.json");
  }
  private tagMap(): Record<string, { tags: string[] }> {
    try {
      return existsSync(this.tagsFile) ? JSON.parse(readFileSync(this.tagsFile, "utf8")) : {};
    } catch {
      return {};
    }
  }
  private file(name: string) {
    if (!NAME.test(name)) throw new HttpError(400, "a skill's name is lowercase letters, digits and '-'");
    return join(this.dir, name, "SKILL.md");
  }

  list(): Skill[] {
    if (!existsSync(this.dir)) return [];
    const tags = this.tagMap();
    return readdirSync(this.dir)
      .filter((n) => NAME.test(n) && existsSync(join(this.dir, n, "SKILL.md")))
      .map((name) => {
        const f = join(this.dir, name, "SKILL.md");
        return { name, description: describe(readFileSync(f, "utf8")), tags: tags[name]?.tags ?? [], updatedAt: statSync(f).mtime.toISOString() };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillBody {
    const f = this.file(name);
    if (!existsSync(f)) throw new HttpError(404, `no skill ${name}`);
    return { name, body: readFileSync(f, "utf8"), tags: this.tagMap()[name]?.tags ?? [] };
  }

  /** Create or change a skill: its SKILL.md, its tags, or both. */
  save(name: string, patch: { body?: string; tags?: string[] }): SkillBody {
    const f = this.file(name);
    if (patch.body === undefined && !existsSync(f)) throw new HttpError(400, "a new skill needs its SKILL.md");
    if (patch.body !== undefined) {
      if (!patch.body.trim()) throw new HttpError(400, "SKILL.md is empty");
      mkdirSync(join(this.dir, name), { recursive: true });
      writeFileSync(f, withFrontmatter(name, patch.body));
    }
    if (patch.tags !== undefined) {
      const tags = [...new Set(patch.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
      const bad = tags.find((t) => !TAG.test(t));
      if (bad) throw new HttpError(400, `tag "${bad}": lowercase letters, digits, ':' and '-'`);
      const map = this.tagMap();
      map[name] = { tags };
      writeFileSync(this.tagsFile, JSON.stringify(map, null, 1));
    }
    return this.get(name);
  }

  remove(name: string) {
    const f = this.file(name);
    if (!existsSync(f)) throw new HttpError(404, `no skill ${name}`);
    rmSync(join(this.dir, name), { recursive: true, force: true });
    const map = this.tagMap();
    delete map[name];
    writeFileSync(this.tagsFile, JSON.stringify(map, null, 1));
  }

  /** The skills carrying any of these tags, with their SKILL.md (what a task's plugin is made of). */
  bundle(tags: string[]): SkillBody[] {
    const want = new Set(tags);
    return this.list()
      .filter((s) => s.tags.some((t) => want.has(t)))
      .map((s) => this.get(s.name));
  }
}

/** Where a task's plugin lives (outside the workspace): Claude Code gets --plugin-dir with it. */
export const taskPluginDir = (home: string, taskId: string) => join(home, "task-plugins", taskId, "jin");

/** The /jin:<name> skills a task's plugin holds (what its Claude Code is told about). */
export function taskSkills(home: string, taskId: string): string[] {
  const dir = join(taskPluginDir(home, taskId), "skills");
  return existsSync(dir) ? readdirSync(dir).filter((n) => existsSync(join(dir, n, "SKILL.md"))).sort() : [];
}

/** Write a task's plugin from these skills; none: no plugin (and an old one is removed). */
export function writeTaskPlugin(home: string, taskId: string, skills: SkillBody[]) {
  const dir = taskPluginDir(home, taskId);
  rmSync(dir, { recursive: true, force: true });
  if (!skills.length) return;
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "jin", description: `jin's skills for task ${taskId}`, version: "1.0.0" }, null, 2));
  for (const s of skills) {
    if (!NAME.test(s.name)) continue;
    mkdirSync(join(dir, "skills", s.name), { recursive: true });
    writeFileSync(join(dir, "skills", s.name, "SKILL.md"), withFrontmatter(s.name, s.body));
  }
}

export function skillRoutes(router: Router, skills: Skills) {
  router
    .on("GET", "/api/skills", () => json({ skills: skills.list(), taskTags: TASK_TAGS, everyTask: EVERY_TASK }))
    // A machine fetching what a task asks for (from its home).
    .on("GET", "/api/skills/bundle", (_req, _p, url) => json(skills.bundle((url.searchParams.get("tags") ?? "").split(",").filter(Boolean))))
    .on("GET", "/api/skills/:name", (_req, p) => json(skills.get(p.name!)))
    .on("PUT", "/api/skills/:name", async (req, p) => json(skills.save(p.name!, await body<{ body?: string; tags?: string[] }>(req))))
    .on("DELETE", "/api/skills/:name", (_req, p) => {
      skills.remove(p.name!);
      return json({ removed: true });
    });
}
