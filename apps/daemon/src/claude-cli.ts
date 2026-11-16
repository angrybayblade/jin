import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceAdapter } from "./adapters";
import type { Config, WorkspaceConfig } from "./config";
import { body, json, type Router } from "./http";
import { evaluate } from "./policy";
import { createdPrs } from "./prs";
import type { AgentStatus, ClaudeLaunch, Terminals } from "./terminals";

const HOOK = join(import.meta.dir, "hooks", "claude-hook.ts");
const JIN_TASK = join(import.meta.dir, "hooks", "jin-task.ts");
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"] as const;

/**
 * Settings jin passes to Claude Code with `--settings` (merged with the user's own): only
 * hooks that call back into jin. Lives in JIN_HOME, so nothing is written into the repos.
 */
export function writeClaudeSettings(config: Config): string {
  const dir = join(config.home, "claude");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.json");
  const command = (event: string) => `${JSON.stringify(process.execPath)} ${JSON.stringify(HOOK)} ${event}`;
  const hooks = Object.fromEntries(EVENTS.map((e) => [e, [{ hooks: [{ type: "command", command: command(e), timeout: 10 }] }]]));
  writeFileSync(file, JSON.stringify({ hooks }, null, 2));
  return file;
}

/** Where a task's Claude Code runs, for its appended context. */
export interface TaskContext {
  taskId: string;
  /** The task's folder (Claude Code starts here: its worktrees, TASK.md, task.json). */
  taskRoot?: string;
  /** The workspace's root (Claude Code may read all of it: --add-dir). */
  workspaceRoot?: string;
  /** The task this one was spawned from. */
  parent?: string | null;
}

/** jin's context and must-follow rules for Claude Code running in a task (appended to its system prompt). */
export function taskRules(ctx: TaskContext | string): string {
  const c = typeof ctx === "string" ? { taskId: ctx } : ctx;
  return [
    `You are running inside jin task ${c.taskId}; jin is the user's orchestrator and tracks this task's pull requests.`,
    c.taskRoot ? `You start in the task's folder, ${c.taskRoot}: one worktree per repo, plus TASK.md (the task's notes: read it first, and keep it up to date).` : "",
    c.workspaceRoot
      ? `The whole workspace, ${c.workspaceRoot}, is readable: its CLAUDE.md, docs/map/README.md and map/ (how services fit together), skills, and the other repos for reference. Make changes only in this task's worktrees; never edit ${c.workspaceRoot}/repos/<repo>, which stays at its pin.`
      : "",
    c.parent ? `This task is a sub-task of ${c.parent}: it covers one part of that work, as its own branch and pull request.` : "",
    "MUST-FOLLOW RULE: whenever you create a pull request for this work (with `gh pr create`, a GitHub tool, or any other way), immediately attach it to the task by running:",
    "  jin-task attach-pr <pull request URL>",
    "and check that it printed \"attached to the task\". Do the same when you push to, or take over, an existing pull request for this task.",
    "`jin-task prs` lists what is attached. Never skip this step, and tell the user if attaching fails.",
    "SUB-TASKS: when part of the work belongs in its own branch and pull request (an independent change, another repo's part, a prerequisite), you may split it off as a sub-task:",
    '  jin-task spawn <ID> --repos <repo,repo> --slug "<short title>" --prompt "<what its Claude Code should do>" [--type feature|enhancement|refactor|patch|bug] [--no-setup]',
    "It creates the task with the workspace's tooling and opens Claude Code there with your prompt; the user approves it first. Use an id like " +
      `${c.taskId}-a. Give the prompt everything the sub-task needs (it does not see this conversation). \`jin-task subtasks\` shows each one's state, its Claude Code status and its pull requests. For research inside this task, use your own subagents instead.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Where `jin-task` lives: a small launcher on PATH for the terminals jin starts. */
export function writeJinTaskCommand(config: Config): string {
  const dir = join(config.home, "bin");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "jin-task");
  writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(JIN_TASK)} "$@"\n`, { mode: 0o755 });
  return dir;
}

export function claudeLaunch(config: Config, settingsFile: string, binDir?: string): ClaudeLaunch {
  return {
    // The same model as jin's chats, so a task's Claude Code does not fall back to another default.
    args: (ctx) => [
      "--settings",
      settingsFile,
      "--model",
      config.model,
      // The whole workspace is readable from a task's folder; the task's context and rules go in the system prompt.
      ...(ctx?.taskId && ctx.workspaceRoot ? ["--add-dir", ctx.workspaceRoot] : []),
      ...(ctx?.taskId ? ["--append-system-prompt", taskRules({ ...ctx, taskId: ctx.taskId })] : []),
    ],
    env: (w: WorkspaceConfig | undefined) => ({
      JIN_HOME: config.home,
      ...(binDir ? { PATH: `${binDir}:${process.env.PATH ?? ""}` } : {}),
      ...(w?.profile.claudeConfigDir ? { CLAUDE_CONFIG_DIR: w.profile.claudeConfigDir } : {}),
    }),
  };
}

/** What Claude Code's hooks report: status for the command center, and jin's verdict on tool calls. */
export function claudeHookRoutes(
  router: Router,
  terminals: Terminals,
  adapters: Map<string, WorkspaceAdapter>,
  workspaceOf: (terminalId: string | null) => string | undefined,
  /** After each hook: the tab's status before and after (notifications use it). */
  onStatus?: (terminalId: string, before: AgentStatus, after: AgentStatus, event: string, input: Record<string, any>) => void,
  /** A tool call created pull requests (attached to the terminal's task). */
  onPrsCreated?: (terminalId: string, urls: string[]) => void,
) {
  router.on("POST", "/api/hooks/claude", async (req) => {
    const { event, terminalId, input } = await body<{ event: string; terminalId: string | null; input: Record<string, any> }>(req);
    const before = terminalId && terminals.isLive(terminalId) ? terminals.get(terminalId).status : null;
    const report = () => {
      if (terminalId && before && onStatus && terminals.isLive(terminalId)) onStatus(terminalId, before, terminals.get(terminalId).status, event, input);
    };
    if (terminalId) {
      // Claude Code's session id (new on /clear) lets the tab resume after a restart.
      if (typeof input.session_id === "string" && input.session_id) terminals.setClaudeSession(terminalId, input.session_id);
      if (event === "UserPromptSubmit" || event === "PreToolUse" || event === "PostToolUse") terminals.setStatus(terminalId, "working");
      else if (event === "Notification") terminals.setStatus(terminalId, input.notification_type === "idle_prompt" ? "idle" : "waiting");
      else if (event === "Stop" || event === "SessionStart") terminals.setStatus(terminalId, "idle");
    }
    if (event === "PostToolUse" && terminalId && onPrsCreated) {
      const urls = createdPrs(String(input.tool_name ?? ""), (input.tool_input ?? {}) as Record<string, unknown>, input.tool_response);
      if (urls.length) onPrsCreated(terminalId, urls);
    }
    if (event !== "PreToolUse") {
      report();
      return json({});
    }
    const workspace = workspaceOf(terminalId);
    const verdict = evaluate(String(input.tool_name ?? ""), (input.tool_input ?? {}) as Record<string, unknown>, workspace ? adapters.get(workspace)?.policy() : undefined);
    if (verdict.decision === "deny") return json({ decision: "deny", reason: verdict.reason });
    if (verdict.decision === "ask") {
      if (terminalId) terminals.setStatus(terminalId, "waiting");
      report();
      return json({ decision: "ask", reason: verdict.reason });
    }
    return json({}); // Claude Code's own permission rules decide, as in a terminal
  });
}
