import { query, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { HttpError, json, type Router } from "./http";

/**
 * Skills in chats: the skills (and custom commands) Claude Code offers where a chat runs (the
 * user's, the workspace's, plugins'), for the composer's `/` picker; and, in a message, the
 * ones the user named. A message that starts with `/skill` runs it the way Claude Code does;
 * one named later in a message is told to the agent, which runs it with its Skill tool.
 */

export interface ChatSkill {
  name: string;
  description: string;
  argumentHint: string;
}

/** `/name` at the start or after a space: a skill (plugin skills are `plugin:name`). Not paths: `/a/b` stops at the slash. */
const SKILL_REF = /(^|\s)\/([A-Za-z0-9][\w:.-]*)(?=$|[\s),.;!?])/g;

/** The `/names` in a message, in order, once each. */
export function skillRefs(text: string): string[] {
  return [...new Set([...text.matchAll(SKILL_REF)].map((m) => m[2]!.replace(/[.:]+$/, "")))];
}

/** The skills a message names (of those `known`), and what the agent is told about the ones Claude Code does not run itself. */
export function skillContext(text: string, known: ChatSkill[]): { used: ChatSkill[]; context: string } {
  const byName = new Map(known.map((s) => [s.name.toLowerCase(), s]));
  const used = skillRefs(text)
    .map((n) => byName.get(n.toLowerCase()))
    .filter((s): s is ChatSkill => Boolean(s));
  // `/skill …` as the message's first word is Claude Code's own: it runs the skill with the rest as its arguments.
  const lead = /^\s*\/([A-Za-z0-9][\w:.-]*)/.exec(text)?.[1]?.toLowerCase();
  const told = used.filter((s) => s.name.toLowerCase() !== lead);
  const context = told.length
    ? `\n\n(The user named ${told.length === 1 ? "this skill" : "these skills"}: ${told.map((s) => `/${s.name}${s.description ? ` (${s.description.slice(0, 120)})` : ""}`).join("; ")}. Run ${told.length === 1 ? "it" : "each"} with the Skill tool as part of this request.)`
    : "";
  return { used, context };
}

type Probe = (cwd: string, env: Record<string, string>) => Promise<SlashCommand[]>;

/** Starts Claude Code without a message (no model call) and asks for its commands. */
export const probeCommands: Probe = async (cwd, env) => {
  const controller = new AbortController();
  let done!: () => void;
  const closed = new Promise<void>((r) => (done = r));
  const prompt = (async function* () {
    await closed;
  })() as AsyncIterable<never>;
  const q = query({ prompt, options: { cwd, env: { ...process.env, ...env } as Record<string, string>, settingSources: ["user", "project"], abortController: controller } });
  const drain = (async () => {
    try {
      for await (const _ of q) {
        // nothing is asked
      }
    } catch {
      // closed below
    }
  })();
  try {
    return await q.supportedCommands();
  } finally {
    done();
    controller.abort();
    await drain;
  }
};

const TTL = 10 * 60_000;

/** Skills by where a chat runs, cached for a few minutes (a new skill shows up after that, or with fresh). */
export class ChatSkills {
  private cache = new Map<string, { at: number; list: ChatSkill[] }>();
  private inflight = new Map<string, Promise<ChatSkill[]>>();

  constructor(private probe: Probe = probeCommands) {}

  async list(cwd: string, env: Record<string, string> = {}, fresh = false): Promise<ChatSkill[]> {
    const hit = this.cache.get(cwd);
    if (!fresh && hit && Date.now() - hit.at < TTL) return hit.list;
    let p = this.inflight.get(cwd);
    if (!p) {
      p = this.probe(cwd, env)
        .then((cmds) => {
          // Claude Code's own commands (/clear, /cost…) are not skills; rows that share a name keep the first.
          const seen = new Set<string>();
          const list = cmds
            .filter((c) => !c.builtin && !seen.has(c.name) && seen.add(c.name))
            .map((c) => ({ name: c.name, description: c.description ?? "", argumentHint: c.argumentHint ?? "" }))
            .sort((a, b) => a.name.localeCompare(b.name));
          this.cache.set(cwd, { at: Date.now(), list });
          return list;
        })
        .finally(() => this.inflight.delete(cwd));
      this.inflight.set(cwd, p);
    }
    return p;
  }
}

export function chatSkillRoutes(router: Router, where: (kind: string) => { cwd: string; env: Record<string, string> }, skills: ChatSkills | undefined) {
  router.on("GET", "/api/chat-skills", async (_req, _p, url) => {
    const kind = url.searchParams.get("kind") ?? "jin";
    let place;
    try {
      place = where(kind);
    } catch {
      throw new HttpError(400, `unknown chat kind ${kind}`);
    }
    return json(skills ? await skills.list(place.cwd, place.env, url.searchParams.get("fresh") === "1") : []);
  });
}
