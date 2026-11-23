// jin's plugin for opencode (passed per launch in OPENCODE_CONFIG_CONTENT, in a terminal tab or
// for a chat or room agent). Every tool call is checked by the jin daemon before it runs:
// - a call jin denies is blocked (the hook throws, and opencode reports jin's reason);
// - in a terminal tab, jin sets every tool to "ask": the plugin answers opencode's permission
//   request itself for calls jin allows, and leaves the ones jin asks about to opencode's own
//   prompt;
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

export const Jin = async ({ client, directory }: { client: any; directory: string }) => {
  // What jin said about each call, until opencode asks permission for it.
  const verdicts = new Map<string, "allow" | "ask">();
  // MCP servers by name: opencode names their tools `<server>_<tool>`; jin's rules say mcp__<server>__<tool>.
  let servers: string[] = [];
  const toolName = (tool: string) => {
    const s = servers.filter((x) => tool.startsWith(`${x}_`)).sort((a, b) => b.length - a.length)[0];
    return s ? `mcp__${s}__${tool.slice(s.length + 1)}` : tool;
  };
  let reported = "";
  const started = (id: string | undefined) => {
    if (id && id !== reported) {
      reported = id;
      quiet(post("SessionStart", { session_id: id, cwd: directory }));
    }
  };

  return {
    config: async (config: { mcp?: Record<string, unknown> }) => {
      servers = Object.keys(config?.mcp ?? {});
    },
    "chat.message": async (input: { sessionID: string }) => {
      started(input.sessionID);
      quiet(post("UserPromptSubmit", {}));
    },
    "tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }, output: { args: Record<string, unknown> }) => {
      started(input.sessionID);
      const verdict = await post("PreToolUse", { tool_name: toolName(input.tool), tool_input: output.args ?? {}, cwd: directory });
      if (verdict.decision === "deny") throw new Error(`jin: ${verdict.reason ?? "not allowed"}`);
      verdicts.set(input.callID, verdict.decision === "ask" ? "ask" : "allow");
    },
    "tool.execute.after": async (input: { tool: string; callID: string }, output: { output?: string; metadata?: unknown; args?: Record<string, unknown> }) => {
      verdicts.delete(input.callID);
      quiet(post("PostToolUse", { tool_name: toolName(input.tool), tool_input: output.args ?? {}, tool_response: String(output.output ?? "").slice(0, 20000), cwd: directory }));
    },
    event: async ({ event }: { event: { type: string; properties: any } }) => {
      if (event.type === "permission.asked") {
        const p = event.properties;
        const v = p.tool?.callID ? verdicts.get(p.tool.callID) : undefined;
        if (v === "allow") {
          await client.postSessionIdPermissionsPermissionId({ path: { id: p.sessionID, permissionID: p.id }, body: { response: "once" } }).catch(() => {});
        } else if (terminalId) {
          // jin asks, or it is a request jin did not see (a folder outside the task): opencode's prompt shows.
          quiet(post("Notification", { notification_type: "permission", message: `approval: ${(p.patterns ?? []).join(" ") || p.permission}` }));
        }
        return;
      }
      if (event.type === "permission.replied") quiet(post("Resumed", {}));
      if (event.type === "session.idle") quiet(post("Stop", {}));
    },
  };
};
