import { Glob } from "bun";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { majors, type AgentLaunch } from "./agents";
import { taskRules } from "./claude-cli";
import type { Config } from "./config";

/**
 * pi in a terminal tab. jin's extension (`hooks/pi-extension.ts`, passed with `-e`, so it loads
 * without pi's project-trust question) checks every tool call with the daemon: what jin never
 * runs is blocked, and outward actions ask you in pi's own prompt. pi blocks a call whose
 * handler fails, so nothing runs unchecked. pi keeps its own models and sign-ins (~/.pi/agent).
 */

export const PI_EXTENSION = join(import.meta.dir, "hooks", "pi-extension.ts");

/** pi's agent folder: its settings, sign-ins and sessions. */
export const piAgentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/** pi names each session file `<timestamp>_<id>.jsonl`, under sessions/<its folder>/. */
export function piHasSession(sessionId: string, agentDir = piAgentDir()): boolean {
  if (!/^[\w-]+$/.test(sessionId)) return false;
  const dir = process.env.PI_CODING_AGENT_SESSION_DIR ?? join(agentDir, "sessions");
  if (!existsSync(dir)) return false;
  for (const _ of new Glob(`**/*_${sessionId}.jsonl`).scanSync({ cwd: dir, onlyFiles: true })) return true;
  return false;
}

export function piLaunch(config: Config, binDir?: string): AgentLaunch {
  const launch: AgentLaunch = {
    id: "pi",
    label: "pi",
    bin: "pi",
    canFork: false,
    // jin's extension uses pi's extension API as of 1.x; another major may load it differently.
    supports: majors("pi", [1], "Its extension API may have changed, so jin could not be sure it checks pi's tool calls."),
    argv: (ctx) => {
      const args = ["pi", "-e", PI_EXTENSION];
      if (ctx.taskId) {
        const rules = taskRules({ ...ctx, taskId: ctx.taskId, journal: Boolean(binDir && ctx.terminalId), links: launch.linksOf?.(ctx.taskId) ?? [], brief: launch.briefOf?.(ctx.taskId) });
        args.push("--append-system-prompt", rules);
      }
      if (ctx.resume) args.push("--session", ctx.resume);
      else if (ctx.prompt?.trim()) args.push(ctx.prompt.trim());
      return args;
    },
    env: (_w, ctx) => ({
      JIN_HOME: config.home,
      ...(binDir ? { PATH: `${binDir}:${process.env.PATH ?? ""}` } : {}),
      // jin's journal and task-context tools, through `jin-task mcp` (it knows its terminal).
      ...(ctx?.taskId && ctx.terminalId && binDir
        ? { JIN_PI_MCP: JSON.stringify({ command: join(binDir, "jin-task"), args: ["mcp"], env: { JIN_TERMINAL_ID: ctx.terminalId, JIN_HOME: config.home }, exposure: "direct" }) }
        : {}),
    }),
    hasSession: (id) => piHasSession(id),
  };
  return launch;
}
