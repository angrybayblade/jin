import type { AgentStatus, RoomAgentState, SessionState } from "./daemon";

/**
 * One way to say what an agent is doing, whichever kind it is: a Claude Code terminal (its
 * hooks report it), a headless session (a chat, the desk, a doc's chat), or a room agent. The
 * sidebar, tabs, chat lists and the room's roster all use these words and marks.
 */
export type AgentState = "working" | "needs-you" | "queued" | "idle" | "failed" | "stopped" | "new";

export const AGENT_LABEL: Record<AgentState, string> = {
  working: "working",
  "needs-you": "needs you",
  queued: "queued",
  idle: "idle",
  failed: "failed",
  stopped: "stopped",
  new: "not started",
};

/** A headless session's state. */
export function fromSession(s: SessionState | null | undefined): AgentState {
  switch (s) {
    case "running":
      return "working";
    case "waiting_approval":
      return "needs-you";
    case "failed":
      return "failed";
    case "interrupted":
      return "stopped";
    default:
      return "idle";
  }
}

/** A Claude Code terminal's status (from its hooks). */
export function fromTerminal(s: AgentStatus): AgentState {
  switch (s) {
    case "starting":
    case "working":
      return "working";
    case "waiting":
      return "needs-you";
    case "idle":
      return "idle";
    default:
      return "stopped";
  }
}

/** A room agent's state. */
export function fromRoom(s: RoomAgentState): AgentState {
  return s === "new" ? "new" : s === "queued" ? "queued" : fromSession(s);
}

/** Worth a live mark in a list (otherwise a quiet dot): it is doing something, or something happened to it. */
export const isNotable = (s: AgentState) => s === "working" || s === "needs-you" || s === "queued" || s === "failed";
/** Busy: a new message waits behind its turn. */
export const isBusy = (s: AgentState) => s === "working" || s === "needs-you" || s === "queued";
