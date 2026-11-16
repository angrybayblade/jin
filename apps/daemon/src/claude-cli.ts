import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceAdapter } from "./adapters";
import type { Config, WorkspaceConfig } from "./config";
import { body, json, type Router } from "./http";
import { evaluate } from "./policy";
import type { ClaudeLaunch, Terminals } from "./terminals";

const HOOK = join(import.meta.dir, "hooks", "claude-hook.ts");
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

export function claudeLaunch(config: Config, settingsFile: string): ClaudeLaunch {
  return {
    args: () => ["--settings", settingsFile],
    env: (w: WorkspaceConfig | undefined) => ({
      JIN_HOME: config.home,
      ...(w?.profile.claudeConfigDir ? { CLAUDE_CONFIG_DIR: w.profile.claudeConfigDir } : {}),
    }),
  };
}

/** What Claude Code's hooks report: status for the command center, and jin's verdict on tool calls. */
export function claudeHookRoutes(router: Router, terminals: Terminals, adapters: Map<string, WorkspaceAdapter>, workspaceOf: (terminalId: string | null) => string | undefined) {
  router.on("POST", "/api/hooks/claude", async (req) => {
    const { event, terminalId, input } = await body<{ event: string; terminalId: string | null; input: Record<string, any> }>(req);
    if (terminalId) {
      // Claude Code's session id (new on /clear) lets the tab resume after a restart.
      if (typeof input.session_id === "string" && input.session_id) terminals.setClaudeSession(terminalId, input.session_id);
      if (event === "UserPromptSubmit" || event === "PreToolUse" || event === "PostToolUse") terminals.setStatus(terminalId, "working");
      else if (event === "Notification") terminals.setStatus(terminalId, input.notification_type === "idle_prompt" ? "idle" : "waiting");
      else if (event === "Stop" || event === "SessionStart") terminals.setStatus(terminalId, "idle");
    }
    if (event !== "PreToolUse") return json({});
    const workspace = workspaceOf(terminalId);
    const verdict = evaluate(String(input.tool_name ?? ""), (input.tool_input ?? {}) as Record<string, unknown>, workspace ? adapters.get(workspace)?.policy() : undefined);
    if (verdict.decision === "deny") return json({ decision: "deny", reason: verdict.reason });
    if (verdict.decision === "ask") {
      if (terminalId) terminals.setStatus(terminalId, "waiting");
      return json({ decision: "ask", reason: verdict.reason });
    }
    return json({}); // Claude Code's own permission rules decide, as in a terminal
  });
}
