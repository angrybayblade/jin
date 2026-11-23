// jin's extension for pi (loaded with `pi -e`, in a terminal tab or for a chat or room agent).
// Every tool call is checked by the jin daemon before it runs:
// - in a terminal tab, jin denies what it never runs and asks you, in pi's own prompt, before
//   outward actions (a push, a PR, a message);
// - for a chat or room agent, the session's gate decides, and an approval waits in jin for as
//   long as you take.
// pi blocks a call whose handler fails, so a daemon that cannot be reached means no call runs.
// Other events report status, the session id (to resume) and journal evidence.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.JIN_HOME ?? join(homedir(), ".jin");
const terminalId = process.env.JIN_TERMINAL_ID ?? null;
const sessionId = process.env.JIN_SESSION_ID ?? null;

type Verdict = { decision?: "deny" | "ask" | "allow"; reason?: string };

async function post(event: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Verdict> {
  const { host, port, token } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { host: string; port: number; token: string };
  const res = await fetch(`http://${host}:${port}/api/hooks/pi`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ event, terminalId, sessionId, input }),
    // A tool call waits for jin (an approval can take a while); status reports do not.
    signal: event === "PreToolUse" ? signal : AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`jin daemon answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Verdict;
}

const quiet = (p: Promise<unknown>) => void p.catch(() => {});
const textOf = (content: unknown) => (Array.isArray(content) ? content.map((c: { type?: string; text?: string }) => (c?.type === "text" ? c.text : "")).join("") : "");

export default function jin(pi: any) {
  // jin's tools (the work journal, the task's context; a chat's own tools), as an MCP server.
  if (process.env.JIN_PI_MCP) pi.registerMcpServer("jin", JSON.parse(process.env.JIN_PI_MCP));

  pi.on("session_start", async (_e: unknown, ctx: any) => quiet(post("SessionStart", { session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd })));
  pi.on("agent_start", async () => quiet(post("UserPromptSubmit", {})));
  pi.on("ui_prompt_start", async () => quiet(post("Notification", { notification_type: "prompt", message: "pi is asking you something" })));
  pi.on("agent_settled", async () => quiet(post("Stop", {})));

  pi.on("tool_call", async (e: any, ctx: any) => {
    const verdict = await post("PreToolUse", { tool_name: e.toolName, tool_input: e.input, cwd: ctx.cwd }, ctx.signal);
    if (verdict.decision === "deny") return { block: true, reason: `jin: ${verdict.reason ?? "not allowed"}` };
    if (verdict.decision === "ask") {
      if (!ctx.hasUI) return { block: true, reason: `jin: ${verdict.reason}; it needs your approval and nobody can give it here` };
      const what = typeof e.input?.command === "string" ? e.input.command : `${e.toolName} ${JSON.stringify(e.input ?? {}).slice(0, 200)}`;
      const ok = await ctx.ui.confirm("jin: allow this?", `${verdict.reason}\n\n${what}`);
      quiet(post("Resumed", {}));
      if (!ok) return { block: true, reason: "jin: the user declined this" };
    }
  });

  pi.on("tool_result", async (e: any, ctx: any) =>
    quiet(post("PostToolUse", { tool_name: e.toolName, tool_input: e.input, tool_response: textOf(e.content), cwd: ctx.cwd })),
  );
}
