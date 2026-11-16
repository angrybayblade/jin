/**
 * Variables a Claude Code session sets for its own child processes. If the daemon is started
 * from inside Claude Code, they would reach every `claude` jin launches: the child-session
 * marker turns transcript saving off (so sessions cannot be resumed), and the messaging token
 * and ports belong to the parent session. User configuration such as CLAUDE_CODE_USE_BEDROCK
 * is kept.
 */
const SESSION_VARIABLES = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
]);
const SESSION_PREFIXES = ["CLAUDE_CODE_MESSAGING_", "CLAUDE_CODE_SESSION_"];

export const isSessionVariable = (key: string) => SESSION_VARIABLES.has(key) || SESSION_PREFIXES.some((p) => key.startsWith(p));

/** Remove inherited Claude Code session variables from this process (and so from everything it starts). */
export function dropInheritedClaudeSession(env: Record<string, string | undefined> = process.env): string[] {
  const dropped = Object.keys(env).filter(isSessionVariable);
  for (const key of dropped) delete env[key];
  return dropped;
}
