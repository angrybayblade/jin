import { ClaudeHarness } from "./claude";
import { ScriptedHarness } from "./scripted";
import type { Harness } from "./types";

/** The Claude harness, or the scripted stand-in when JIN_HARNESS=scripted (tests). */
export function claudeHarness(): Harness {
  return process.env.JIN_HARNESS === "scripted" ? new ScriptedHarness() : new ClaudeHarness();
}

export type { Harness, HarnessRun, JinTool, ToolGate } from "./types";
