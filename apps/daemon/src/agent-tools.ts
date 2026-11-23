import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { JinTool } from "./harness/types";
import { body, HttpError, json, type Router } from "./http";

/**
 * jin's own tools for an agent that cannot be handed them in-process (Codex): while a run lasts,
 * its tools are kept here under a random token, and `hooks/agent-tools-mcp.ts` (an MCP server
 * Codex starts) lists and calls them through the daemon. Codex asks jin before each call (an
 * MCP approval), so they go through the session's gate like any other tool.
 */
export class AgentTools {
  private live = new Map<string, JinTool[]>();

  /** Keep a run's tools until `done`. */
  register(tools: JinTool[]): { token: string; done: () => void } {
    const token = randomBytes(24).toString("hex");
    this.live.set(token, tools);
    return { token, done: () => this.live.delete(token) };
  }

  private tools(token: string): JinTool[] {
    const t = this.live.get(token);
    if (!t) throw new HttpError(404, "these tools are no longer available (the run ended)");
    return t;
  }

  list(token: string) {
    return this.tools(token).map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.input)) }));
  }

  async call(token: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools(token).find((t) => t.name === name);
    if (!tool) throw new HttpError(404, `unknown tool ${name}`);
    const parsed = z.object(tool.input).safeParse(args ?? {});
    if (!parsed.success) throw new HttpError(400, parsed.error.message);
    return tool.run(parsed.data);
  }
}

export function agentToolRoutes(router: Router, tools: AgentTools) {
  router
    .on("GET", "/api/agent-tools/:token", (_req, p) => json(tools.list(p.token!)))
    .on("POST", "/api/agent-tools/:token/:name", async (req, p) => {
      const { args } = await body<{ args?: Record<string, unknown> }>(req);
      try {
        const result = await tools.call(p.token!, p.name!, args ?? {});
        return json({ text: typeof result === "string" ? result : JSON.stringify(result, null, 2) });
      } catch (err) {
        if (err instanceof HttpError && err.status !== 400) throw err;
        return json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
}
