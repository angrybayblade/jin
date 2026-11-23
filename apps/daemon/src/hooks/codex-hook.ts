#!/usr/bin/env bun
// Codex hook for terminals jin starts (passed to `codex` with -c, and trusted by jin first).
// Reads the hook input on stdin, asks the jin daemon, and answers Codex:
// - PreToolUse: deny what jin never runs (deploys, releases, jin's own secrets...) and stay
//   silent otherwise. Outward actions need the network, which Codex's sandbox keeps off, so
//   Codex asks the user in the terminal before any of them runs.
// - Other events report status (working, waiting, idle) for the command center.
// Codex runs a tool call whose hook crashed or timed out, so on PreToolUse any failure here
// exits 2, which blocks the call: a broken check never means an unchecked one.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const event = process.argv[2] ?? "";

async function ask(input: Record<string, unknown>): Promise<{ decision?: "deny"; reason?: string }> {
  const home = process.env.JIN_HOME ?? join(homedir(), ".jin");
  const { host, port, token } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { host: string; port: number; token: string };
  const res = await fetch(`http://${host}:${port}/api/hooks/codex`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ event, terminalId: process.env.JIN_TERMINAL_ID ?? null, sessionId: process.env.JIN_SESSION_ID ?? null, input }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`jin daemon answered ${res.status}`);
  return (await res.json()) as { decision?: "deny"; reason?: string };
}

try {
  const input = JSON.parse((await Bun.stdin.text()) || "{}") as Record<string, unknown>;
  const answer = await ask(input);
  if (event === "PreToolUse" && answer.decision === "deny") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `jin: ${answer.reason ?? ""}` } }));
  }
  process.exit(0);
} catch (err) {
  if (event === "PreToolUse") {
    process.stderr.write(`jin could not check this tool call (${err instanceof Error ? err.message : err}); blocked to be safe.`);
    process.exit(2); // blocks the tool call and shows the message to Codex
  }
  process.exit(0);
}
