import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentLaunch } from "./agents";
import { taskRules } from "./claude-cli";
import type { Config } from "./config";

/**
 * opencode in a terminal tab. Everything jin adds goes in OPENCODE_CONFIG_CONTENT for that
 * launch (nothing is written to ~/.config/opencode): jin's plugin (`hooks/opencode-plugin.ts`),
 * which checks every tool call with the daemon; every tool set to "ask", so a call jin asks
 * about shows opencode's own permission prompt (the plugin answers the rest itself); jin's
 * tools as an MCP server; and the task's rules as an instructions file. opencode keeps its own
 * models and sign-ins.
 */

export const OPENCODE_PLUGIN = join(import.meta.dir, "hooks", "opencode-plugin.ts");

/** Every tool asks (the plugin answers what jin allows), named ones too, so a user's own "allow" cannot skip jin's ask. */
const ASK_ALL = { "*": "ask", bash: "ask", edit: "ask", write: "ask", read: "ask", glob: "ask", grep: "ask", list: "ask", webfetch: "ask", websearch: "ask", task: "ask", patch: "ask", external_directory: "ask" };

export interface OpencodeConfig {
  /** A terminal tab: every tool asks (see ASK_ALL). A chat leaves permissions alone; its gate decides in the plugin. */
  ask: boolean;
  /** jin's tools, as an MCP server opencode starts. */
  mcp?: { command: string[]; environment: Record<string, string> };
  /** A file with the rules and context the agent is told. */
  instructions?: string;
}

export function opencodeConfig(c: OpencodeConfig): string {
  return JSON.stringify({
    plugin: [`file://${OPENCODE_PLUGIN}`],
    ...(c.ask ? { permission: ASK_ALL } : {}),
    ...(c.mcp ? { mcp: { jin: { type: "local", command: c.mcp.command, environment: c.mcp.environment, enabled: true } } } : {}),
    ...(c.instructions ? { instructions: [c.instructions] } : {}),
  });
}

/** Where jin keeps the instructions it gives an agent run (one file per tab or chat). */
export function writeInstructions(home: string, id: string, text: string): string {
  const dir = join(home, "agent-instructions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id.replace(/[^\w-]/g, "_")}.md`);
  writeFileSync(file, text);
  return file;
}

/** opencode keeps sessions in its database; a session there can be continued. */
export function opencodeHasSession(sessionId: string, dataDir = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode")): boolean {
  if (!/^[\w-]+$/.test(sessionId)) return false;
  const file = join(dataDir, "opencode.db");
  if (!existsSync(file)) return false;
  try {
    const db = new Database(file, { readonly: true });
    try {
      return Boolean(db.query("select 1 from session where id = ?").get(sessionId));
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export function opencodeLaunch(config: Config, binDir?: string): AgentLaunch {
  const launch: AgentLaunch = {
    id: "opencode",
    label: "opencode",
    bin: "opencode",
    canFork: false,
    argv: (ctx) => ["opencode", ...(ctx.resume ? ["-s", ctx.resume] : ctx.prompt?.trim() ? ["--prompt", ctx.prompt.trim()] : [])],
    env: (_w, ctx) => {
      const rules =
        ctx?.taskId && ctx.terminalId
          ? writeInstructions(config.home, ctx.terminalId, taskRules({ ...ctx, taskId: ctx.taskId, journal: Boolean(binDir), links: launch.linksOf?.(ctx.taskId) ?? [], brief: launch.briefOf?.(ctx.taskId) }))
          : undefined;
      const mcp = ctx?.taskId && ctx.terminalId && binDir ? { command: [join(binDir, "jin-task"), "mcp"], environment: { JIN_TERMINAL_ID: ctx.terminalId, JIN_HOME: config.home } } : undefined;
      return {
        JIN_HOME: config.home,
        ...(binDir ? { PATH: `${binDir}:${process.env.PATH ?? ""}` } : {}),
        OPENCODE_CONFIG_CONTENT: opencodeConfig({ ask: true, mcp, instructions: rules }),
      };
    },
    hasSession: (id) => opencodeHasSession(id),
  };
  return launch;
}
