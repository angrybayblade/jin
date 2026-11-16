#!/usr/bin/env bun
// Claude Code hook for terminals jin starts (registered through `claude --settings`).
// Reads the hook input on stdin, asks the jin daemon, and answers Claude Code:
// - PreToolUse: deny what jin never runs (deploys, releases...), ask for outward actions
//   (push, PR, messages) so Claude Code shows its own permission prompt, and otherwise
//   stay silent so Claude Code's normal permission rules apply, exactly as in a terminal.
// - Other events report status (working, waiting, idle) for the command center.
// If the daemon cannot be reached, PreToolUse fails closed for commands jin would check.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const event = process.argv[2] ?? "";
const input = JSON.parse((await Bun.stdin.text()) || "{}") as Record<string, unknown>;

async function ask(): Promise<{ decision?: "deny" | "ask"; reason?: string }> {
  const home = process.env.JIN_HOME ?? join(homedir(), ".jin");
  const { host, port, token } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { host: string; port: number; token: string };
  const res = await fetch(`http://${host}:${port}/api/hooks/claude`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ event, terminalId: process.env.JIN_TERMINAL_ID ?? null, input }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`jin daemon answered ${res.status}`);
  return (await res.json()) as { decision?: "deny" | "ask"; reason?: string };
}

try {
  const answer = await ask();
  if (event === "PreToolUse" && answer.decision) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: answer.decision, permissionDecisionReason: `jin: ${answer.reason ?? ""}` } }),
    );
  }
  process.exit(0);
} catch (err) {
  if (event === "PreToolUse" && input.tool_name === "Bash") {
    process.stderr.write(`jin could not check this command (${err instanceof Error ? err.message : err}); blocked to be safe.`);
    process.exit(2); // blocks the tool call and shows the message to Claude
  }
  process.exit(0);
}
