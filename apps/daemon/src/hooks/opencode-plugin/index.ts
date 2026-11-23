// jin's plugin for opencode 2 (loaded per launch through `plugins` in OPENCODE_CONFIG_CONTENT,
// with opencode started --standalone so its server, which runs the tools, is the one that has
// it). Every tool call is checked by the jin daemon before it runs:
// - a call jin denies is rejected (the hook throws, and opencode reports jin's reason);
// - in a terminal tab, a call jin asks about goes to opencode's own approval prompt
//   (`permission.assert`), showing the actual call, and runs only once you allow it;
// - for a chat or room agent, the session's gate decides, and an approval waits in jin for as
//   long as you take.
// A daemon that cannot be reached throws too, so nothing runs unchecked.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.JIN_HOME ?? join(homedir(), ".jin");
const terminalId = process.env.JIN_TERMINAL_ID ?? null;
const sessionId = process.env.JIN_SESSION_ID ?? null;

type Verdict = { decision?: "deny" | "ask" | "allow"; reason?: string };

async function post(event: string, input: Record<string, unknown>): Promise<Verdict> {
  const { host, port, token } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { host: string; port: number; token: string };
  const res = await fetch(`http://${host}:${port}/api/hooks/opencode`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ event, terminalId, sessionId, input }),
    // A tool call waits for jin (an approval can take a while); status reports do not.
    ...(event === "PreToolUse" ? {} : { signal: AbortSignal.timeout(5000) }),
  });
  if (!res.ok) throw new Error(`jin daemon answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Verdict;
}

const quiet = (p: Promise<unknown>) => void p.catch(() => {});

interface ToolEvent {
  tool: string;
  sessionID: string;
  messageID: string;
  id: string;
  input: unknown;
}

export default {
  id: "jin",
  async setup(ctx: any) {
    const directory: string = ctx.location?.directory ?? process.cwd();
    // MCP servers by name: opencode names their tools `<server>_<tool>`; jin's rules say mcp__<server>__<tool>.
    // (Listed after the check is registered: MCP servers may still be connecting.)
    let servers: string[] = ["jin"];
    const toolName = (tool: string) => {
      const s = servers.filter((x) => tool.startsWith(`${x.replaceAll(".", "_")}_`)).sort((a, b) => b.length - a.length)[0];
      return s ? `mcp__${s}__${tool.slice(s.replaceAll(".", "_").length + 1)}` : tool;
    };
    let reported = "";
    const started = (id: string | undefined) => {
      if (id && id !== reported) {
        reported = id;
        quiet(post("SessionStart", { session_id: id, cwd: directory }));
      }
    };
    // Calls jin asked about and you are being asked: opencode's own permission check for them asks too.
    const asking = new Set<string>();

    await ctx.tool.hook("execute.before", async (event: ToolEvent) => {
      started(event.sessionID);
      const input = (event.input ?? {}) as Record<string, unknown>;
      const verdict = await post("PreToolUse", { tool_name: toolName(event.tool), tool_input: input, cwd: directory });
      if (verdict.decision === "deny") throw new Error(`jin: ${verdict.reason ?? "not allowed"}`);
      if (verdict.decision !== "ask") return;
      const what = typeof input.command === "string" ? input.command : typeof input.path === "string" ? input.path : JSON.stringify(input).slice(0, 200);
      quiet(post("Notification", { notification_type: "permission", message: `approval: ${what}` }));
      asking.add(event.id);
      try {
        // opencode's own prompt, for this call; a rejection fails the call.
        await ctx.permission.assert({
          sessionID: event.sessionID,
          action: event.tool,
          resources: [what],
          metadata: { description: `jin: ${verdict.reason ?? "needs your approval"}` },
          source: { type: "tool", messageID: event.messageID, id: event.id },
        });
      } finally {
        asking.delete(event.id);
        quiet(post("Resumed", {}));
      }
    });

    // The rest only reports status and evidence: registered after the check, and each guarded,
    // so a hook opencode renames cannot keep the check above from loading.
    const optional = async (register: () => Promise<unknown>) => {
      try {
        await register();
      } catch {
        // reported nowhere: status is a convenience
      }
    };
    await optional(() =>
      ctx.permission.hook("evaluate", (event: { source?: { id?: string }; effect: string }) => {
        if (event.source?.id && asking.has(event.source.id)) event.effect = "ask";
      }),
    );
    await optional(() =>
      ctx.session.hook("prompt", (event: { sessionID: string }) => {
        started(event.sessionID);
        quiet(post("UserPromptSubmit", {}));
      }),
    );
    await optional(() =>
      ctx.tool.hook("execute.after", (event: ToolEvent & { status: string; result?: { output?: unknown }; error?: unknown }) => {
        const out = event.status === "completed" ? event.result?.output : event.error;
        quiet(post("PostToolUse", { tool_name: toolName(event.tool), tool_input: event.input ?? {}, tool_response: (typeof out === "string" ? out : JSON.stringify(out ?? "")).slice(0, 20000), cwd: directory }));
      }),
    );
    await optional(() => ctx.session.hook("experimental.idle", () => quiet(post("Stop", {}))));
    void (async () => {
      try {
        const listed = await ctx.mcp?.list?.();
        const names = (Array.isArray(listed) ? listed : Object.values(listed ?? {})).map((s: any) => String(s?.name ?? s?.id ?? "")).filter(Boolean);
        servers = [...new Set([...servers, ...names])];
      } catch {
        // only jin's own server is known
      }
    })();
  },
};
