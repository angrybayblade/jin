import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { majors, type AgentLaunch } from "./agents";
import { taskRules } from "./claude-cli";
import type { Config } from "./config";

/**
 * opencode 2 in a terminal tab. Everything jin adds goes in OPENCODE_CONFIG_CONTENT for that
 * launch (nothing is written to ~/.config/opencode): jin's plugin (`hooks/opencode-plugin/`),
 * which checks every tool call with the daemon and sends the ones jin asks about to opencode's
 * own approval prompt; jin's tools as an MCP server; and the task's rules as an instructions
 * file. opencode runs --standalone: by default every client shares one background server, which
 * runs the tools with its own configuration and would never load jin's plugin. opencode keeps its
 * own models and sign-ins.
 */

export const OPENCODE_PLUGIN = join(import.meta.dir, "hooks", "opencode-plugin");

export interface OpencodeConfig {
  /** jin's tools, as an MCP server opencode starts. */
  mcp?: { command: string[]; environment: Record<string, string> };
  /** A file with the rules and context the agent is told. */
  instructions?: string;
}

export function opencodeConfig(c: OpencodeConfig): string {
  return JSON.stringify({
    plugins: [OPENCODE_PLUGIN],
    // codemode: false puts jin's tools on the model's own tool list (opencode 2 otherwise reaches MCP tools only through code-mode scripts).
    ...(c.mcp ? { mcp: { servers: { jin: { type: "local", command: c.mcp.command, environment: c.mcp.environment, codemode: false } } } } : {}),
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

/** opencode keeps sessions in its database (`session_v2` since opencode 2); a session there can be continued. */
export function opencodeHasSession(sessionId: string, dataDir = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode")): boolean {
  if (!/^[\w-]+$/.test(sessionId)) return false;
  const file = join(dataDir, "opencode.db");
  if (!existsSync(file)) return false;
  try {
    const db = new Database(file, { readonly: true });
    try {
      return Boolean(db.query("select 1 from session_v2 where id = ?").get(sessionId));
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
    // jin's plugin uses opencode 2's plugin API (opencode 1 loads plugins differently).
    supports: majors("opencode", [2], "jin's plugin is written for opencode 2's plugin system; update opencode (`opencode upgrade`)."),
    argv: (ctx) => ["opencode", "--standalone", ...(ctx.resume ? ["-s", ctx.resume] : ctx.prompt?.trim() ? ["--prompt", ctx.prompt.trim()] : [])],
    env: (_w, ctx) => {
      const rules =
        ctx?.taskId && ctx.terminalId
          ? writeInstructions(config.home, ctx.terminalId, taskRules({ ...ctx, taskId: ctx.taskId, journal: Boolean(binDir), links: launch.linksOf?.(ctx.taskId) ?? [], preContext: launch.preContextOf?.(ctx.taskId), brief: launch.briefOf?.(ctx.taskId) }))
          : undefined;
      const mcp = ctx?.taskId && ctx.terminalId && binDir ? { command: [join(binDir, "jin-task"), "mcp"], environment: { JIN_TERMINAL_ID: ctx.terminalId, JIN_HOME: config.home } } : undefined;
      return {
        JIN_HOME: config.home,
        ...(binDir ? { PATH: `${binDir}:${process.env.PATH ?? ""}` } : {}),
        OPENCODE_CONFIG_CONTENT: opencodeConfig({ mcp, instructions: rules }),
      };
    },
    hasSession: (id) => opencodeHasSession(id),
  };
  return launch;
}
