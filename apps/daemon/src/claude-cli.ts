import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentBrief, ReviewedPR, TaskKind } from "./adapters";
import type { AgentLaunch } from "./agents";
import { taskPluginDir, taskSkills } from "./skills";
import type { Config, WorkspaceConfig } from "./config";

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
  /** The task's folder (Claude Code starts here: its checkouts, and whatever its workspace keeps there). */
  taskRoot?: string;
  /** The workspace's root (Claude Code may read all of it: --add-dir). */
  workspaceRoot?: string;
  /** The task this one was spawned from. */
  parent?: string | null;
  /** Claude Code has jin's `journal` tool. */
  journal?: boolean;
  kind?: TaskKind;
  prs?: ReviewedPR[];
  /** jin's skills in the task's plugin (/jin:<name>). */
  skills?: string[];
  /** What the task follows (its PRs, issue, Slack threads and channels, Notion pages). */
  links?: { kind: string; label: string; url: string | null }[];
  /** What its workspace says about working there (its provider's brief). */
  brief?: AgentBrief;
  /** What jin picked for it from long-term memory, as agents read it ("" or absent: nothing). */
  preContext?: string;
}

/** The task's context: what it follows, and how to get more when the work needs it. */
function contextRule(c: TaskContext): string {
  const follows = (c.links ?? []).map((l) => `  - ${l.label}${l.url ? ` ${l.url}` : ""}`);
  return [
    c.preContext ?? "",
    follows.length ? `THIS TASK FOLLOWS (as of when you started):\n${follows.join("\n")}` : "",
    "TASK CONTEXT: discussions, tickets and docs around this task live outside the code. When the work depends on one (a decision made in a Slack thread, the issue's scope, a Notion spec, review comments on a PR), call the `task_context` tool (or run `jin-task context`): it lists the PRs, Linear issue, Slack threads and channels and Notion pages the task follows, with the latest on each and how to read each in full. Then read only what you need with the Slack, Linear and Notion tools or gh. Don't load everything up front; ask again later to see what changed (links can be added while you work).",
  ]
    .filter(Boolean)
    .join("\n");
}

/** jin's context and must-follow rules for Claude Code running in a task (appended to its system prompt). */
export function taskRules(ctx: TaskContext | string): string {
  const c: TaskContext = typeof ctx === "string" ? { taskId: ctx } : ctx;
  const b = c.brief;
  const skills = c.skills?.length ? `SKILLS: jin added skills for this task: ${c.skills.map((s) => `/jin:${s}`).join(", ")}. Use them for this work: they say how the user wants it done.` : "";
  // Where it starts and what it may read: the workspace's brief, or a plain default.
  const start = b?.start || (c.taskRoot ? `You start in the task's folder, ${c.taskRoot}: one checkout per repo.` : "");
  const readable = b?.readable || (c.workspaceRoot ? `The workspace, ${c.workspaceRoot}, is readable for reference. Make changes only in this task's checkouts.` : "");
  const rules = (b?.rules ?? []).map((r) => `WORKSPACE RULE: ${r}`);
  if (c.kind === "review") {
    const prs = (c.prs ?? []).map((p) => `${p.repo}#${p.number}${p.title ? ` (${p.title})` : ""}${p.url ? ` ${p.url}` : ""}`).join("; ");
    const notes = b?.notes ? `in ${b.notes}` : "in your reply";
    return [
      `You are running inside jin task ${c.taskId}, a REVIEW of pull requests: ${prs || "see the task's folder"}.`,
      start,
      readable,
      `MUST-FOLLOW RULES: you review; you do not change the PRs. Never commit, push, approve, request changes or post comments on GitHub unless the user says so for that comment; draft comments ${notes} and show them. To pick up a new push: \`git fetch origin pull/<n>/head && git checkout --detach FETCH_HEAD\` in that checkout.`,
      `SETUP IS YOURS TO DECIDE: the checkouts are plain, with no dependencies installed and nothing running. Reading the change needs neither. ${b?.setup || "If running a repo's tests, typecheck or lint would settle something, install what that repo needs in its checkout first, and say what you set up and why."}`,
      ...rules,
      contextRule(c),
      skills,
      c.journal
        ? "WORK JOURNAL: the user follows your review in jin's journal, grouped by concern (a short label for one area, e.g. \"rate limiter\"; reuse labels). Call the `journal` tool for each finding (kind found, with why it matters) and each conclusion (decision). One line each; send it alongside your next tool call, and never read the journal back."
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    contextRule(c),
    skills,
    `You are running inside jin task ${c.taskId}; jin is the user's orchestrator and tracks this task's pull requests.`,
    start,
    readable,
    ...rules,
    c.parent ? `This task is a sub-task of ${c.parent}: it covers one part of that work, as its own branch and pull request.` : "",
    "MUST-FOLLOW RULE: whenever you create a pull request for this work (with `gh pr create`, a GitHub tool, or any other way), immediately attach it to the task by running:",
    "  jin-task attach-pr <pull request URL>",
    "and check that it printed \"attached to the task\". Do the same when you push to, or take over, an existing pull request for this task.",
    "`jin-task prs` lists what is attached. Never skip this step, and tell the user if attaching fails.",
    "SUB-TASKS: when part of the work belongs in its own branch and pull request (an independent change, another repo's part, a prerequisite), you may split it off as a sub-task:",
    '  jin-task spawn <ID> --repos <repo,repo> --slug "<short title>" --prompt "<what its Claude Code should do>" [--type <change type>] [--no-setup]',
    "It creates the task with the workspace's tooling and opens Claude Code there with your prompt; the user approves it first. Use an id like " +
      `${c.taskId}-a. Give the prompt everything the sub-task needs (it does not see this conversation). \`jin-task subtasks\` shows each one's state, its Claude Code status and its pull requests. For research inside this task, use your own subagents instead.`,
    c.journal
      ? "WORK JOURNAL: the user follows your work in jin's journal, grouped by concern (a short label for one area of the work, e.g. \"rate limiter\" or \"migration\"; reuse labels). Call the `journal` tool when you make a decision (kind decision, with why), finish a piece of work (done) or learn something that shapes the work (found). One line each, a few per concern, not every step; files, commits and tests are recorded for you. Send it alongside your next tool call rather than on its own, and never read the journal back. LONG-TERM MEMORY: memory_search reads what earlier tasks in this workspace decided and learned (kept by jin when they finished); search it before a decision that may have been made before."
      : "",
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

/** Whether Claude Code has a saved conversation for `sessionId` (under any project directory). */
export function hasTranscript(sessionId: string, configDir?: string): boolean {
  if (!/^[\w-]+$/.test(sessionId)) return false;
  const projects = join(configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  try {
    return readdirSync(projects).some((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}

/** Claude Code in a terminal tab: jin's settings file with its hooks, its tools, the task's rules and skills. */
export function claudeLaunch(config: Config, settingsFile: string, binDir?: string): AgentLaunch {
  const links = (taskId: string) => {
    try {
      return launch.linksOf?.(taskId) ?? [];
    } catch {
      return [];
    }
  };
  const brief = (taskId: string) => {
    try {
      return launch.briefOf?.(taskId);
    } catch {
      return undefined;
    }
  };
  const launch: AgentLaunch = {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    canFork: true,
    argv: (ctx) => [
      "claude",
      // The work journal: jin's `journal` tool, through `jin-task mcp` (it knows its terminal). First:
      // both flags take lists, so the next argument must be another flag, never the prompt.
      ...(ctx.taskId && ctx.terminalId && binDir
        ? [
            "--mcp-config",
            JSON.stringify({ mcpServers: { jin: { type: "stdio", command: join(binDir, "jin-task"), args: ["mcp"], env: { JIN_TERMINAL_ID: ctx.terminalId, JIN_HOME: config.home } } } }),
            "--allowedTools",
            "mcp__jin__journal,mcp__jin__task_context",
          ]
        : []),
      "--settings",
      settingsFile,
      // jin's skills for this task (by its tags), as a plugin: /jin:<name>.
      ...(ctx.taskId && existsSync(taskPluginDir(config.home, ctx.taskId)) ? ["--plugin-dir", taskPluginDir(config.home, ctx.taskId)] : []),
      // The same model as jin's chats, so a task's Claude Code does not fall back to another default.
      "--model",
      config.model,
      // The whole workspace is readable from a task's folder; the task's context and rules go in the system prompt.
      ...(ctx.taskId && ctx.workspaceRoot ? ["--add-dir", ctx.workspaceRoot] : []),
      ...(ctx.taskId ? ["--append-system-prompt", taskRules({ ...ctx, taskId: ctx.taskId, journal: Boolean(binDir && ctx.terminalId), skills: taskSkills(config.home, ctx.taskId), links: links(ctx.taskId), brief: brief(ctx.taskId), preContext: launch.preContextOf?.(ctx.taskId) })] : []),
      ...(ctx.resume ? ["--resume", ctx.resume] : ctx.fork ? ["--resume", ctx.fork, "--fork-session"] : ctx.prompt?.trim() ? [ctx.prompt.trim()] : []),
    ],
    env: (w: WorkspaceConfig | undefined) => ({
      JIN_HOME: config.home,
      ...(binDir ? { PATH: `${binDir}:${process.env.PATH ?? ""}` } : {}),
      ...(w?.profile.claudeConfigDir ? { CLAUDE_CONFIG_DIR: w.profile.claudeConfigDir } : {}),
    }),
    hasSession: (id, w) => hasTranscript(id, w?.profile.claudeConfigDir),
  };
  return launch;
}
