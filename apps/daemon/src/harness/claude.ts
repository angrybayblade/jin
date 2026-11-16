import { createSdkMcpServer, query, tool, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Harness, HarnessRun } from "./types";

/**
 * Claude through the Claude Agent SDK. Policy is enforced twice:
 * - a PreToolUse hook runs on every tool call, including ones Claude Code would allow
 *   on its own, and sends it through jin's gate (deny, or wait for an approval);
 * - canUseTool covers the permission prompts Claude Code raises itself.
 * The hook blocks the call if it fails (onFailure: "block"), so a broken gate never
 * means an unchecked tool call.
 */
export class ClaudeHarness implements Harness {
  readonly id = "claude" as const;
  readonly adapter = "claude-agent-sdk";

  async run(run: HarnessRun): Promise<{ sessionId: string }> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    run.signal.addEventListener("abort", abort, { once: true });

    // Tool calls the hook already let through, so canUseTool does not ask twice.
    const cleared = new Set<string>();
    const preToolUse: HookCallback = async (input, toolUseId, { signal }) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const verdict = await run.gate(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, signal);
      if (!verdict.allow) {
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason } };
      }
      if (toolUseId) cleared.add(toolUseId);
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    };

    let sessionId = run.resume ?? "";
    // Jin's own tools, served in-process; their calls go through the same gate.
    const mcpServers = run.tools?.length
      ? {
          jin: createSdkMcpServer({
            name: "jin",
            tools: run.tools.map((t) =>
              tool(t.name, t.description, t.input, async (args) => {
                try {
                  const result = await t.run(args as Record<string, unknown>);
                  return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
                } catch (err) {
                  return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
                }
              }),
            ),
          }),
        }
      : undefined;
    const session = query({
      prompt: run.prompt,
      options: {
        cwd: run.cwd,
        env: { ...process.env, ...run.env } as Record<string, string>,
        resume: run.resume,
        model: run.model,
        abortController: controller,
        permissionMode: "default",
        systemPrompt: run.instructions ? { type: "preset", preset: "claude_code", append: run.instructions } : { type: "preset", preset: "claude_code" },
        mcpServers,
        // User settings bring the user's MCP servers (Slack, Linear, Notion...); project
        // settings bring the workspace's CLAUDE.md and skills, as in Claude Code.
        settingSources: ["user", "project"],
        includePartialMessages: false,
        hooks: { PreToolUse: [{ hooks: [preToolUse], onFailure: "block", timeout: 24 * 60 * 60 }] },
        canUseTool: async (tool, input, options) => {
          if (options.toolUseID && cleared.has(options.toolUseID)) return { behavior: "allow", updatedInput: input };
          const verdict = await run.gate(tool, input, options.signal);
          return verdict.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: verdict.reason };
        },
      },
    });

    try {
      for await (const message of session) {
        if ("session_id" in message && message.session_id) sessionId = message.session_id;
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) run.emit("message", { text: block.text });
            if (block.type === "tool_use") run.emit("tool.started", { id: block.id, tool: block.name, input: block.input as Record<string, unknown> });
          }
        }
        if (message.type === "user" && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (typeof block === "object" && block.type === "tool_result") run.emit("tool.result", { id: block.tool_use_id, isError: Boolean(block.is_error) });
          }
        }
        if (message.type === "result") {
          run.emit("result", {
            subtype: message.subtype,
            costUsd: "total_cost_usd" in message ? message.total_cost_usd : undefined,
            turns: message.num_turns,
          });
          if (message.subtype !== "success") throw new Error(`Claude stopped: ${message.subtype}`);
        }
      }
    } finally {
      run.signal.removeEventListener("abort", abort);
      session.close();
    }
    return { sessionId };
  }
}
