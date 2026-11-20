import { randomUUID } from "node:crypto";
import type { Harness, HarnessRun } from "./types";

type Step = { tool: string; input: Record<string, unknown> } | { text: string } | { jinTool: string; input: Record<string, unknown> };

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
      // The script is the prompt, or a line of it (a room wraps what you wrote in the room's messages: the last script line counts).
      const line = run.prompt.trim().startsWith("{") ? run.prompt : (run.prompt.split("\n").map((l) => l.replace(/^[^{]*/, "")).filter((l) => l.startsWith('{"script"')).at(-1) ?? run.prompt);
      steps = (JSON.parse(line) as { script: Step[] }).script;
      if (!Array.isArray(steps)) throw new Error("script must be an array");
    } catch (err) {
      throw new Error(`scripted harness: prompt must be {"script": [...]}: ${(err as Error).message}`);
    }
    for (const step of steps) {
      run.signal.throwIfAborted();
      if ("text" in step) {
        // Stream it word by word first, like the real harness, then record the message.
        if (process.env.JIN_SCRIPTED_STREAM_MS) {
          for (const word of step.text.split(/(?<=\s)/)) {
            run.stream?.("message.delta", { text: word });
            await Bun.sleep(Number(process.env.JIN_SCRIPTED_STREAM_MS));
          }
        }
        run.emit("message", { text: step.text });
        continue;
      }
      if ("jinTool" in step) {
        // Jin's tools are named mcp__jin__<name> to the agent, like any MCP tool.
        const verdict = await run.gate(`mcp__jin__${step.jinTool}`, step.input, run.signal);
        const t = run.tools?.find((x) => x.name === step.jinTool);
        if (verdict.allow && t) run.emit("tool.result", { tool: `mcp__jin__${step.jinTool}`, input: step.input, output: await t.run(step.input) });
        continue;
      }
      const verdict = await run.gate(step.tool, step.input, run.signal);
      if (verdict.allow) run.emit("tool.result", { tool: step.tool, input: step.input, output: "(scripted)" });
    }
    return { sessionId };
  }
}
