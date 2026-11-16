import { randomUUID } from "node:crypto";
import type { Harness, HarnessRun } from "./types";

type Step = { tool: string; input: Record<string, unknown> } | { text: string };

/**
 * A deterministic stand-in for Claude, selected with JIN_HARNESS=scripted (tests only).
 * The prompt is a JSON script of tool calls and messages. Each tool call goes through
 * the same gate the real harness uses, so policy and approvals are exercised for real;
 * only the model is replaced.
 */
export class ScriptedHarness implements Harness {
  readonly id = "claude" as const;
  readonly adapter = "scripted";

  async run(run: HarnessRun): Promise<{ sessionId: string }> {
    const sessionId = run.resume ?? randomUUID();
    let steps: Step[];
    try {
      steps = (JSON.parse(run.prompt) as { script: Step[] }).script;
      if (!Array.isArray(steps)) throw new Error("script must be an array");
    } catch (err) {
      throw new Error(`scripted harness: prompt must be {"script": [...]}: ${(err as Error).message}`);
    }
    for (const step of steps) {
      run.signal.throwIfAborted();
      if ("text" in step) {
        run.emit("message", { text: step.text });
        continue;
      }
      const verdict = await run.gate(step.tool, step.input, run.signal);
      if (verdict.allow) run.emit("tool.result", { tool: step.tool, input: step.input, output: "(scripted)" });
    }
    return { sessionId };
  }
}
