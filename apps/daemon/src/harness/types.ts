import type { z } from "zod";

/** What the session manager answers when an agent wants to use a tool. */
export type ToolGate = (tool: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<{ allow: true } | { allow: false; reason: string }>;

/** A tool jin itself provides to an agent (served in-process as the `jin` MCP server). */
export interface JinTool {
  name: string;
  description: string;
  input: z.ZodRawShape;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface HarnessRun {
  prompt: string;
  cwd: string;
  /** More folders the agent may read and work in (beside cwd). */
  addDirs?: string[];
  /** Extra environment for the agent process, e.g. CLAUDE_CONFIG_DIR for the workspace's profile. */
  env: Record<string, string>;
  /** The harness's own session id to continue, when resuming. */
  resume?: string;
  /** Model id; the harness default when unset. */
  model?: string;
  /** Reasoning effort; the model's default when unset. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Appended to the agent's system prompt: what this chat is for. */
  instructions?: string;
  /** Hold the first message until the user's claude.ai connectors (Gmail, Slack...) have connected. */
  needsConnectors?: boolean;
  /** Jin's own tools for this chat (jin's chat gets orchestration tools; others none). */
  tools?: JinTool[];
  /** Every tool call goes through this gate before it runs. */
  gate: ToolGate;
  /** Record a session event (persisted and streamed by the session manager). */
  emit(kind: string, payload: Record<string, unknown>): void;
  /** Send a live-only event to open streams, not persisted (e.g. text deltas while a message is written). */
  stream?(kind: string, payload: Record<string, unknown>): void;
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
