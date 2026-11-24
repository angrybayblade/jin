import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse as parseJsonc, type ParseError, printParseErrorCode } from "jsonc-parser";
import { CodexAppServer } from "./codex-app-server";
import { body, HttpError, json, type Router } from "./http";

/**
 * The user settings of the coding agents other than Claude Code (whose file has its own module),
 * read and written for each machine's page:
 *
 *   codex     $CODEX_HOME/config.toml (~/.codex), written through Codex's own app-server
 *   pi        $PI_CODING_AGENT_DIR/settings.json (~/.pi/agent)
 *   opencode  ~/.config/opencode/opencode.jsonc or opencode.json
 *
 * The page sends either the settings as an object (from its forms) or the file's text (edited
 * by hand). An object becomes edits to just the keys that changed, so comments, order and keys
 * the page has no form for stay as they are; Codex applies its own edits (it keeps its TOML's
 * formatting). Text replaces the file once it parses. Either way a write names the version it
 * was based on and is refused if the file changed since, and the previous file is kept next to
 * it. Values are never logged: these files hold MCP servers' environment and headers.
 */

export const SETTINGS_AGENTS = ["codex", "pi", "opencode"] as const;
export type SettingsAgent = (typeof SETTINGS_AGENTS)[number];

type Obj = Record<string, unknown>;

export interface HarnessSettingsFile {
  agent: SettingsAgent;
  path: string;
  exists: boolean;
  format: "toml" | "json" | "jsonc";
  /** The file as written; when it does not parse, the page shows it as text to fix. */
  text: string;
  settings: Obj | null;
  /** The version a write must name. */
  hash: string;
  error: string | null;
}

export interface SettingsWrite {
  settings?: unknown;
  text?: string;
  base: string;
}

/** One change: `value` undefined removes the key. */
export interface SettingsEdit {
  path: string[];
  value: unknown;
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const sha = (text: string) => (text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : "");

/** The smallest edits that turn `before` into `after`: objects on both sides are walked into, anything else is replaced whole. */
export function editsBetween(before: Obj, after: Obj, at: string[] = []): SettingsEdit[] {
  const out: SettingsEdit[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const [a, b] = [before[k], after[k]];
    if (Bun.deepEquals(a, b)) continue;
    if (isObj(a) && isObj(b)) out.push(...editsBetween(a, b, [...at, k]));
    else out.push({ path: [...at, k], value: b });
  }
  return out;
}

// ---- what the forms edit, checked before a write (the agents judge everything else)

const oneOf = (out: string[], s: Obj, key: string, allowed: readonly string[]) => {
  if (s[key] !== undefined && !allowed.includes(s[key] as string)) out.push(`${key} must be one of ${allowed.join(", ")}`);
};
const typed = (out: string[], s: Obj, keys: string[], type: "string" | "boolean" | "number") => {
  for (const k of keys) if (s[k] !== undefined && typeof s[k] !== type) out.push(`${k} must be ${type === "boolean" ? "true or false" : `a ${type}`}`);
};
const lists = (out: string[], s: Obj, keys: string[]) => {
  for (const k of keys) if (s[k] !== undefined && !strings(s[k])) out.push(`${k} must be a list of strings`);
};
const servers = (out: string[], v: unknown, key: string, check: (name: string, s: Obj) => string | null) => {
  if (v === undefined) return;
  if (!isObj(v)) return out.push(`${key} must be an object of servers`);
  for (const [name, s] of Object.entries(v)) {
    const why = isObj(s) ? check(name, s) : `${key}.${name} must be an object`;
    if (why) out.push(why);
  }
};
const stringMap = (v: unknown) => v === undefined || (isObj(v) && Object.values(v).every((x) => typeof x === "string"));

export const CODEX_APPROVALS = ["untrusted", "on-request", "never"] as const;
export const CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;
export const PI_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const OPENCODE_EFFECTS = ["allow", "ask", "deny"] as const;

export function settingsProblems(agent: SettingsAgent, s: unknown): string[] {
  if (!isObj(s)) return ["settings must be an object"];
  const out: string[] = [];
  if (agent === "codex") {
    typed(out, s, ["model", "model_provider", "model_reasoning_effort", "review_model", "developer_instructions"], "string");
    if (s.approval_policy !== undefined && !isObj(s.approval_policy)) oneOf(out, s, "approval_policy", CODEX_APPROVALS);
    oneOf(out, s, "sandbox_mode", CODEX_SANDBOXES);
    oneOf(out, s, "web_search", ["disabled", "cached", "indexed", "live"]);
    oneOf(out, s, "model_reasoning_summary", ["auto", "concise", "detailed", "none"]);
    oneOf(out, s, "model_verbosity", ["low", "medium", "high"]);
    lists(out, s, ["notify"]);
    const w = s.sandbox_workspace_write;
    if (w !== undefined) {
      if (!isObj(w)) out.push("sandbox_workspace_write must be a table");
      else {
        if (w.network_access !== undefined && typeof w.network_access !== "boolean") out.push("sandbox_workspace_write.network_access must be true or false");
        if (w.writable_roots !== undefined && !strings(w.writable_roots)) out.push("sandbox_workspace_write.writable_roots must be a list of paths");
      }
    }
    servers(out, s.mcp_servers, "mcp_servers", (n, m) =>
      typeof m.command !== "string" && typeof m.url !== "string" ? `mcp_servers.${n} needs a command or a url` : m.args !== undefined && !strings(m.args) ? `mcp_servers.${n}.args must be a list of strings` : !stringMap(m.env) ? `mcp_servers.${n}.env must map names to strings` : null,
    );
  } else if (agent === "pi") {
    typed(out, s, ["defaultProvider", "defaultModel", "theme", "shellPath", "shellCommandPrefix"], "string");
    typed(out, s, ["hideThinkingBlock", "enableSkillCommands", "enableInstallTelemetry"], "boolean");
    oneOf(out, s, "defaultThinkingLevel", PI_THINKING);
    oneOf(out, s, "defaultProjectTrust", ["ask", "always", "never"]);
    lists(out, s, ["enabledModels", "defaultTools", "extensions", "skills", "prompts", "themes"]);
    for (const k of ["compaction", "retry"]) if (s[k] !== undefined && !isObj(s[k])) out.push(`${k} must be an object`);
  } else {
    const model = /^[^/#]+\/[^#]+$/;
    for (const k of ["model", "small_model"]) if (s[k] !== undefined && !(typeof s[k] === "string" && model.test(s[k] as string)) && !isObj(s[k])) out.push(`${k} must be provider/model`);
    typed(out, s, ["default_agent", "shell", "username"], "string");
    typed(out, s, ["snapshots"], "boolean");
    oneOf(out, s, "share", ["manual", "auto", "disabled"]);
    oneOf(out, s, "update", ["disable", "notify", "auto"]);
    lists(out, s, ["instructions", "disabled_providers", "enabled_providers"]);
    if (s.permissions !== undefined) {
      if (!Array.isArray(s.permissions)) out.push("permissions must be a list of rules");
      else
        s.permissions.forEach((r, i) => {
          if (!isObj(r) || typeof r.action !== "string" || typeof r.resource !== "string" || !(OPENCODE_EFFECTS as readonly unknown[]).includes(r.effect)) out.push(`permissions[${i}] needs an action, a resource and an effect (${OPENCODE_EFFECTS.join(", ")})`);
        });
    }
    if (s.mcp !== undefined) {
      if (!isObj(s.mcp)) out.push("mcp must be an object");
      else
        servers(out, s.mcp.servers, "mcp.servers", (n, m) =>
          m.type === "local"
            ? strings(m.command) && (m.command as string[]).length
              ? !stringMap(m.environment)
                ? `mcp.servers.${n}.environment must map names to strings`
                : null
              : `mcp.servers.${n} needs a command`
            : m.type === "remote"
              ? typeof m.url === "string" && m.url
                ? !stringMap(m.headers)
                  ? `mcp.servers.${n}.headers must map names to strings`
                  : null
                : `mcp.servers.${n} needs a url`
              : `mcp.servers.${n}.type must be local or remote`,
        );
    }
  }
  return out;
}

// ---- files

/** Write `text` over `path` in one step, keeping what was there as `<path>.jin-backup`. */
function replaceFile(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.jin-backup`);
  const tmp = `${path}.jin-${process.pid}.tmp`;
  writeFileSync(tmp, text.endsWith("\n") ? text : `${text}\n`);
  renameSync(tmp, path);
}

const STALE = "the settings file changed since you opened it: reload to see the change";

/** A JSON settings file (pi), or JSON with comments (opencode). */
export class JsonSettings {
  constructor(
    readonly agent: "pi" | "opencode",
    /** Where the file may be, in the order the agent prefers; a new file is the first. */
    private readonly candidates: string[],
    readonly format: "json" | "jsonc",
  ) {}

  get path() {
    return this.candidates.find((p) => existsSync(p)) ?? this.candidates[0]!;
  }

  private parse(text: string): { settings: Obj | null; error: string | null } {
    if (!text.trim()) return { settings: {}, error: null };
    let v: unknown;
    if (this.format === "jsonc") {
      const errors: ParseError[] = [];
      v = parseJsonc(text, errors, { allowTrailingComma: true });
      if (errors.length) return { settings: null, error: `the file is not valid JSON: ${printParseErrorCode(errors[0]!.error)} at offset ${errors[0]!.offset}` };
    } else {
      try {
        v = JSON.parse(text);
      } catch (e) {
        return { settings: null, error: `the file is not valid JSON: ${(e as Error).message}` };
      }
    }
    return isObj(v) ? { settings: v, error: null } : { settings: null, error: "the file is not a JSON object" };
  }

  async read(): Promise<HarnessSettingsFile> {
    const path = this.path;
    const exists = existsSync(path);
    const text = exists ? readFileSync(path, "utf8") : "";
    return { agent: this.agent, path, exists, format: this.format, text, ...this.parse(text), hash: sha(text) };
  }

  async write(w: SettingsWrite): Promise<HarnessSettingsFile> {
    const now = await this.read();
    let next: string;
    if (typeof w.text === "string") {
      const parsed = this.parse(w.text);
      if (!parsed.settings) throw new HttpError(400, parsed.error ?? "the settings do not parse");
      const problems = settingsProblems(this.agent, parsed.settings);
      if (problems.length) throw new HttpError(400, problems.join("; "));
      if (now.hash !== w.base) throw new HttpError(409, STALE);
      next = w.text;
    } else {
      const problems = settingsProblems(this.agent, w.settings);
      if (problems.length) throw new HttpError(400, problems.join("; "));
      if (now.hash !== w.base) throw new HttpError(409, STALE);
      if (!now.settings) throw new HttpError(400, `${now.error}: fix the file's text first`);
      // Edit only what changed, so comments and the order of everything else stay.
      next = now.text.trim() ? now.text : "{}\n";
      for (const e of editsBetween(now.settings, w.settings as Obj)) next = applyEdits(next, modify(next, e.path, e.value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }));
    }
    if (next === now.text) return now;
    replaceFile(now.path, next);
    return this.read();
  }
}

type AppServer = Pick<CodexAppServer, "initialize" | "request" | "close"> & { closed: Promise<unknown> };

/** Codex's config.toml: Codex reports its version and applies the forms' edits itself, keeping its formatting. */
export class CodexSettings {
  readonly agent = "codex" as const;
  constructor(
    private readonly home = process.env.CODEX_HOME || join(homedir(), ".codex"),
    private readonly server: () => AppServer = () => new CodexAppServer([], { CODEX_HOME: this.home }),
  ) {}

  get path() {
    return join(this.home, "config.toml");
  }

  /** Run `fn` against a fresh app-server for this home, given up on after 30 s. */
  private async with<T>(fn: (s: AppServer) => Promise<T>): Promise<T> {
    const s = this.server();
    const timer = setTimeout(() => s.close(), 30_000);
    try {
      await s.initialize();
      return await fn(s);
    } finally {
      clearTimeout(timer);
      s.close();
      await s.closed.catch(() => {});
    }
  }

  /** Codex's version of the file, or (when Codex cannot load it, say it does not parse) one of our own. */
  private async version(text: string): Promise<string> {
    try {
      const r = (await this.with((s) => s.request("config/read", { includeLayers: true }))) as { layers?: { name?: { type?: string }; version?: string }[] };
      const v = r.layers?.find((l) => l.name?.type === "user")?.version;
      if (v) return v;
    } catch {
      // Fall through: Codex could not read it.
    }
    return `file:${sha(text)}`;
  }

  async read(): Promise<HarnessSettingsFile> {
    const exists = existsSync(this.path);
    const text = exists ? readFileSync(this.path, "utf8") : "";
    let settings: Obj | null = {};
    let error: string | null = null;
    if (text.trim())
      try {
        settings = Bun.TOML.parse(text) as Obj;
      } catch (e) {
        [settings, error] = [null, `the file is not valid TOML: ${(e as Error).message}`];
      }
    return { agent: "codex", path: this.path, exists, format: "toml", text, settings, error, hash: await this.version(text) };
  }

  async write(w: SettingsWrite): Promise<HarnessSettingsFile> {
    const now = await this.read();
    if (typeof w.text === "string") {
      let parsed: unknown;
      try {
        parsed = Bun.TOML.parse(w.text);
      } catch (e) {
        throw new HttpError(400, `the settings are not valid TOML: ${(e as Error).message}`);
      }
      const problems = settingsProblems("codex", parsed);
      if (problems.length) throw new HttpError(400, problems.join("; "));
      if (now.hash !== w.base) throw new HttpError(409, STALE);
      if (w.text !== now.text) replaceFile(this.path, w.text);
      return this.read();
    }
    const problems = settingsProblems("codex", w.settings);
    if (problems.length) throw new HttpError(400, problems.join("; "));
    if (now.hash !== w.base) throw new HttpError(409, STALE);
    if (!now.settings) throw new HttpError(400, `${now.error}: fix the file's text first`);
    const edits = editsBetween(now.settings, w.settings as Obj).map((e) => ({
      // Codex's key paths quote a segment that is not a bare TOML key (a project's path, a plugin id).
      keyPath: e.path.map((k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k))).join("."),
      mergeStrategy: "replace",
      value: e.value === undefined ? null : e.value,
    }));
    if (!edits.length) return now;
    if (now.exists) copyFileSync(this.path, `${this.path}.jin-backup`);
    try {
      await this.with((s) => s.request("config/batchWrite", { edits, expectedVersion: w.base }));
    } catch (e) {
      const msg = (e as Error).message;
      throw new HttpError(/modified since/i.test(msg) ? 409 : 400, /modified since/i.test(msg) ? STALE : `Codex refused the change: ${msg}`);
    }
    return this.read();
  }
}

export type HarnessSettingsStore = JsonSettings | CodexSettings;

/** This machine's settings files, by agent. */
export function harnessSettings(env = process.env): Record<SettingsAgent, HarnessSettingsStore> {
  const piDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const opencodeDir = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  return {
    codex: new CodexSettings(),
    pi: new JsonSettings("pi", [join(piDir, "settings.json")], "json"),
    opencode: new JsonSettings("opencode", [join(opencodeDir, "opencode.jsonc"), join(opencodeDir, "opencode.json")], "jsonc"),
  };
}

export function harnessSettingsRoutes(router: Router, stores: Record<SettingsAgent, HarnessSettingsStore>) {
  const store = (id: string | undefined) => {
    if (!(SETTINGS_AGENTS as readonly string[]).includes(id ?? "")) throw new HttpError(404, `no settings editor for ${id}`);
    return stores[id as SettingsAgent];
  };
  router
    .on("GET", "/api/agents/:id/settings", async (_req, p) => json(await store(p.id).read()))
    .on("PUT", "/api/agents/:id/settings", async (req, p) => {
      const s = store(p.id);
      const b = await body<{ settings?: unknown; text?: string; base?: string }>(req);
      return json(await s.write({ settings: b.settings, text: b.text, base: b.base ?? "" }));
    });
}
