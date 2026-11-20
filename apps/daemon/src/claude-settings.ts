import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { body, HttpError, json, type Router } from "./http";

/**
 * Your Claude Code settings (~/.claude/settings.json on this machine), read and written for
 * jin's settings page. jin's chats and terminals read this file, and so does a plain `claude`.
 * jin's own hooks are not in it: jin passes them separately to its runs.
 *
 * A write replaces the file with what the page sends (keys it has no form for travel with the
 * rest), only when the file has not changed since the page read it, and keeps the previous
 * file next to it. Values are never logged: `env` often holds tokens.
 */

export interface ClaudeSettingsFile {
  path: string;
  exists: boolean;
  /** The file as written; when it does not parse, the page shows it raw to fix. */
  text: string;
  settings: Record<string, unknown> | null;
  /** Of the text: a write must name the version it was based on. */
  hash: string;
  error: string | null;
}

export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"] as const;
const HOOK_TYPES = ["command", "prompt", "agent", "http", "mcp_tool"];

export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const hashOf = (text: string) => (text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** What is wrong with settings, for the keys the page edits (others are Claude Code's to judge). */
export function settingsProblems(s: unknown): string[] {
  if (!isObj(s)) return ["settings must be a JSON object"];
  const out: string[] = [];
  const p = s.permissions;
  if (p !== undefined) {
    if (!isObj(p)) out.push("permissions must be an object");
    else {
      for (const k of ["allow", "deny", "ask", "additionalDirectories"]) if (p[k] !== undefined && !strings(p[k])) out.push(`permissions.${k} must be a list of strings`);
      if (p.defaultMode !== undefined && !(PERMISSION_MODES as readonly unknown[]).concat("manual").includes(p.defaultMode)) out.push(`permissions.defaultMode must be one of ${PERMISSION_MODES.join(", ")}`);
    }
  }
  if (s.env !== undefined && (!isObj(s.env) || !Object.values(s.env).every((v) => typeof v === "string"))) out.push("env must map names to string values");
  for (const k of ["model", "outputStyle"]) if (s[k] !== undefined && typeof s[k] !== "string") out.push(`${k} must be a string`);
  for (const k of ["includeCoAuthoredBy", "respectGitignore", "enableAllProjectMcpServers", "disableClaudeAiConnectors", "disableAllHooks"]) if (s[k] !== undefined && typeof s[k] !== "boolean") out.push(`${k} must be true or false`);
  if (s.cleanupPeriodDays !== undefined && !(typeof s.cleanupPeriodDays === "number" && Number.isInteger(s.cleanupPeriodDays) && s.cleanupPeriodDays >= 0)) out.push("cleanupPeriodDays must be a whole number of days");
  for (const k of ["enabledMcpjsonServers", "disabledMcpjsonServers"]) if (s[k] !== undefined && !strings(s[k])) out.push(`${k} must be a list of strings`);
  if (s.enabledPlugins !== undefined && !isObj(s.enabledPlugins)) out.push("enabledPlugins must be an object");
  if (s.hooks !== undefined) {
    if (!isObj(s.hooks)) out.push("hooks must be an object of events");
    else
      for (const [event, groups] of Object.entries(s.hooks)) {
        if (!Array.isArray(groups)) {
          out.push(`hooks.${event} must be a list`);
          continue;
        }
        groups.forEach((g, i) => {
          if (!isObj(g) || !Array.isArray(g.hooks)) return out.push(`hooks.${event}[${i}] needs a hooks list`);
          if (g.matcher !== undefined && typeof g.matcher !== "string") out.push(`hooks.${event}[${i}].matcher must be a string`);
          g.hooks.forEach((h, j) => {
            if (!isObj(h) || !HOOK_TYPES.includes(h.type as string)) out.push(`hooks.${event}[${i}].hooks[${j}] needs a type (${HOOK_TYPES.join(", ")})`);
            else if (h.type === "command" && (typeof h.command !== "string" || !h.command.trim())) out.push(`hooks.${event}[${i}].hooks[${j}] needs a command`);
          });
        });
      }
  }
  return out;
}

export class ClaudeSettings {
  constructor(private readonly dir = claudeDir()) {}

  get path() {
    return join(this.dir, "settings.json");
  }

  read(): ClaudeSettingsFile {
    const exists = existsSync(this.path);
    const text = exists ? readFileSync(this.path, "utf8") : "";
    let settings: Record<string, unknown> | null = {};
    let error: string | null = null;
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (isObj(parsed)) settings = parsed;
        else [settings, error] = [null, "the file is not a JSON object"];
      } catch (e) {
        [settings, error] = [null, `the file is not valid JSON: ${(e as Error).message}`];
      }
    }
    return { path: this.path, exists, text, settings, hash: hashOf(text), error };
  }

  /** Replace the file with `settings`, if it is still the version `base` names. */
  write(settings: unknown, base: string): ClaudeSettingsFile {
    const problems = settingsProblems(settings);
    if (problems.length) throw new HttpError(400, problems.join("; "));
    const now = this.read();
    if (now.hash !== base) throw new HttpError(409, "the settings file changed since you opened it: reload to see the change");
    mkdirSync(this.dir, { recursive: true });
    if (now.exists) copyFileSync(this.path, `${this.path}.jin-backup`);
    const tmp = `${this.path}.jin-${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    renameSync(tmp, this.path);
    return this.read();
  }
}

export function claudeSettingsRoutes(router: Router, settings: ClaudeSettings) {
  router
    .on("GET", "/api/claude-settings", () => json(settings.read()))
    .on("PUT", "/api/claude-settings", async (req) => {
      const b = await body<{ settings?: unknown; base?: string }>(req);
      return json(settings.write(b.settings, b.base ?? ""));
    });
}
