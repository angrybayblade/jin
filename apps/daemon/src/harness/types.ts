/** What the session manager answers when an agent wants to use a tool. */
export type ToolGate = (tool: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<{ allow: true } | { allow: false; reason: string }>;

export interface HarnessRun {
  prompt: string;
  cwd: string;
  /** Extra environment for the agent process, e.g. CLAUDE_CONFIG_DIR for the workspace's profile. */
  env: Record<string, string>;
  /** The harness's own session id to continue, when resuming. */
  resume?: string;
  /** Every tool call goes through this gate before it runs. */
  gate: ToolGate;
  /** Record a session event (persisted and streamed by the session manager). */
  emit(kind: string, payload: Record<string, unknown>): void;
  signal: AbortSignal;
}

/**
 * An agent runtime (Claude through the Agent SDK; a scripted stand-in for tests).
 * Resolves with the harness's own session id, used to resume later.
 */
export interface Harness {
  readonly id: "claude" | "codex";
  /** Which implementation runs it ("claude-agent-sdk", "scripted"). */
  readonly adapter: string;
  run(run: HarnessRun): Promise<{ sessionId: string }>;
}
