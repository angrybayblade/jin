import { join } from "node:path";
import type { AgentTools } from "../agent-tools";
import { CodexAppServer } from "../codex-app-server";
import { codexHookFlags, toml, trustCodexHooks } from "../codex-cli";
import type { Harness, HarnessRun } from "./types";

/**
 * Codex for chats and room agents, through `codex app-server` with jin as its client. Policy
 * holds as for Claude, in three places:
 * - jin's hooks (trusted first, or the run does not start) deny what policy denies before a
 *   tool runs, including a read-only room agent's edits;
 * - Codex runs sandboxed with the network off, so a command that reaches out asks to run
 *   outside the sandbox, and that request comes to jin's gate (an approval the user decides,
 *   for as long as it takes);
 * - every MCP tool call (jin's own tools, and the user's Slack, Linear...) is a request to jin
 *   first, through the same gate.
 */

const BRIDGE = join(import.meta.dir, "..", "hooks", "agent-tools-mcp.ts");

/** Codex runs commands as `/bin/zsh -lc '<command>'`: the command itself, for policy. */
export function innerCommand(command: string): string {
  const m = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+'([\s\S]*)'$/.exec(command.trim()) ?? /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+"([\s\S]*)"$/.exec(command.trim());
  return m ? m[1]!.replace(/'\\''/g, "'") : command;
}

/** Codex's effort names jin's: the ones Codex has pass through; the rest are left to the model. */
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

export class CodexHarness implements Harness {
  readonly id = "codex" as const;
  readonly adapter = "codex-app-server";

  constructor(
    private opts: {
      home: string;
      tools: AgentTools;
      trust?: typeof trustCodexHooks;
      execPath?: string;
    },
  ) {}

  async run(run: HarnessRun): Promise<{ sessionId: string }> {
    const hooks = codexHookFlags();
    const env = { ...run.env, JIN_HOME: this.opts.home, ...(run.jinSessionId ? { JIN_SESSION_ID: run.jinSessionId } : {}) };
    await (this.opts.trust ?? trustCodexHooks)(hooks, run.cwd, env).catch((err) => {
      throw new Error(`jin could not get Codex to trust its hooks, and without them nothing would check its tool calls (${err instanceof Error ? err.message : err})`);
    });
    const registered = run.tools?.length ? this.opts.tools.register(run.tools) : null;
    const flags = [...hooks, "-c", "sandbox_workspace_write.network_access=false"];
    if (registered) {
      flags.push(
        "-c", `mcp_servers.jin.command=${toml(this.opts.execPath ?? process.execPath)}`,
        "-c", `mcp_servers.jin.args=[${toml(BRIDGE)}]`,
        "-c", `mcp_servers.jin.env={JIN_AGENT_TOOLS=${toml(registered.token)}, JIN_HOME=${toml(this.opts.home)}}`,
      );
    }
    const server = new CodexAppServer(flags, env);
    // What each file change touches, from its start: an approval for it names the item only.
    const changes = new Map<string, string[]>();
    let threadId = run.resume ?? "";
    let turnId = "";
    let settle!: { resolve: () => void; reject: (e: Error) => void };
    const turnDone = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
    const allowed = async (tool: string, input: Record<string, unknown>) => (await run.gate(tool, input, run.signal)).allow;

    server.onRequest(async (method, p) => {
      if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
        const command = innerCommand(Array.isArray(p.command) ? p.command.join(" ") : String(p.command ?? ""));
        return { decision: (await allowed("Bash", { command })) ? "accept" : "decline" };
      }
      if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
        const files = changes.get(String(p.itemId ?? "")) ?? Object.keys(p.fileChanges ?? {});
        for (const file_path of files.length ? files : [""]) if (!(await allowed("Edit", { file_path }))) return { decision: "decline" };
        return { decision: "accept" };
      }
      if (method === "mcpServer/elicitation/request" && p?._meta?.codex_approval_kind === "mcp_tool_call") {
        const tool = `mcp__${p.serverName}__${p._meta.tool_name}`;
        return (await allowed(tool, (p._meta.tool_params ?? {}) as Record<string, unknown>)) ? { action: "accept", content: {} } : { action: "decline" };
      }
      if (method === "mcpServer/elicitation/request") return { action: "decline" };
      // Wider permissions for the session, questions for the user: not something jin grants.
      throw new Error(`jin does not grant ${method}`);
    });

    server.onNotification((method, p) => {
      if (p?.threadId && threadId && p.threadId !== threadId) return;
      if (method === "item/agentMessage/delta" && typeof p.delta === "string") run.stream?.("message.delta", { text: p.delta });
      else if (method === "turn/started") turnId = p.turn?.id ?? turnId;
      else if (method === "item/started" || method === "item/completed") {
        const it = p.item ?? {};
        const done = method === "item/completed";
        if (it.type === "agentMessage" && done && String(it.text ?? "").trim()) run.emit("message", { text: it.text });
        const call =
          it.type === "commandExecution"
            ? { tool: "Bash", input: { command: innerCommand(String(it.command ?? "")) } }
            : it.type === "fileChange"
              ? { tool: "Edit", input: { file_path: (it.changes ?? []).map((c: { path: string }) => c.path).join(", ") } }
              : it.type === "mcpToolCall"
                ? { tool: `mcp__${it.server}__${it.tool}`, input: (it.arguments ?? {}) as Record<string, unknown> }
                : null;
        if (call && !done) {
          if (it.type === "fileChange") changes.set(it.id, (it.changes ?? []).map((c: { path: string }) => c.path));
          run.emit("tool.started", { id: it.id, ...call });
        }
        if (call && done) run.emit("tool.result", { id: it.id, isError: it.status === "failed" || it.status === "declined" });
      } else if (method === "turn/completed") {
        const turn = p.turn ?? {};
        run.emit("result", { subtype: turn.status === "completed" ? "success" : turn.status, turns: 1 });
        if (turn.status === "completed") settle.resolve();
        else settle.reject(new Error(turn.status === "interrupted" ? "Codex stopped: interrupted" : `Codex stopped: ${turn.error?.message ?? turn.status}`));
      }
    });

    const abort = () => {
      if (threadId && turnId) void server.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      setTimeout(() => server.close(), 2000);
    };
    run.signal.addEventListener("abort", abort, { once: true });
    void server.closed.then(() => settle.reject(new Error("Codex's app-server stopped")));
    try {
      await server.initialize();
      const thread = {
        cwd: run.cwd,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        ...(run.instructions ? { developerInstructions: run.instructions } : {}),
        ...(run.model && !run.model.startsWith("claude-") ? { model: run.model } : {}),
      };
      const started = run.resume ? await server.request("thread/resume", { threadId: run.resume, ...thread }) : await server.request("thread/start", thread);
      threadId = started?.thread?.id ?? threadId;
      const turn = await server.request("turn/start", {
        threadId,
        input: [{ type: "text", text: run.prompt }],
        ...(run.effort && EFFORTS.has(run.effort) ? { effort: run.effort } : {}),
      });
      turnId = turn?.turn?.id ?? turnId;
      await turnDone;
    } finally {
      run.signal.removeEventListener("abort", abort);
      registered?.done();
      server.close();
    }
    return { sessionId: threadId };
  }
}
