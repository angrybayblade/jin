import { join } from "node:path";
import { piCalls } from "../agent-hooks";
import type { AgentTools } from "../agent-tools";
import { PI_EXTENSION } from "../pi-cli";
import type { Harness, HarnessRun } from "./types";

/**
 * pi for chats and room agents, through pi's RPC mode (JSON lines over stdio). jin's extension
 * sends every tool call to the session's gate and pi waits for the answer, so policy, the
 * session's rules (a read-only room agent) and approvals in jin hold exactly as for Claude.
 * jin's own tools reach pi as an MCP server (the same bridge Codex uses). pi uses its own
 * models and sign-ins.
 */

const BRIDGE = join(import.meta.dir, "..", "hooks", "agent-tools-mcp.ts");

interface Record_ {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: any;
  [k: string]: any;
}

export class PiHarness implements Harness {
  readonly id = "pi" as const;
  readonly adapter = "pi-rpc";

  constructor(private opts: { home: string; tools: AgentTools; execPath?: string; /** Throws when this machine's version is not one jin has checked. */ ensure?: () => Promise<unknown> }) {}

  async run(run: HarnessRun): Promise<{ sessionId: string }> {
    await this.opts.ensure?.();
    const registered = run.tools?.length ? this.opts.tools.register(run.tools) : null;
    const env: Record<string, string> = {
      ...run.env,
      JIN_HOME: this.opts.home,
      ...(run.jinSessionId ? { JIN_SESSION_ID: run.jinSessionId } : {}),
      ...(registered ? { JIN_PI_MCP: JSON.stringify({ command: this.opts.execPath ?? process.execPath, args: [BRIDGE], env: { JIN_AGENT_TOOLS: registered.token, JIN_HOME: this.opts.home }, exposure: "direct" }) } : {}),
    };
    const args = ["--mode", "rpc", "-e", PI_EXTENSION, ...(run.instructions ? ["--append-system-prompt", run.instructions] : []), ...(run.resume ? ["--session", run.resume] : [])];
    const shell = process.env.SHELL || "/bin/bash";
    const proc = Bun.spawn([shell, "-l", "-c", 'exec "$@"', "jin", "pi", ...args], { cwd: run.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
    const write = (r: Record_) => {
      try {
        proc.stdin.write(JSON.stringify(r) + "\n");
        proc.stdin.flush();
      } catch {
        // it stopped; reading reports that
      }
    };
    const waiting = new Map<string, (r: Record_) => void>();
    let next = 0;
    const ask = (r: Record_) =>
      new Promise<Record_>((resolve) => {
        const id = `jin-${++next}`;
        waiting.set(id, resolve);
        write({ ...r, id });
      });

    let failure: string | null = null;
    let settle!: { resolve: (aborted: boolean) => void; reject: (e: Error) => void };
    const settled = new Promise<boolean>((resolve, reject) => (settle = { resolve, reject }));
    const tools = new Map<string, string>();
    const onRecord = (r: Record_) => {
      if (r.type === "response" && r.id && waiting.has(r.id)) {
        waiting.get(r.id)!(r);
        waiting.delete(r.id);
        return;
      }
      switch (r.type) {
        case "message_update": {
          const ev = r.assistantMessageEvent;
          if (ev?.type === "text_delta" && typeof ev.delta === "string") run.stream?.("message.delta", { text: ev.delta });
          break;
        }
        case "message_end": {
          const m = r.message ?? {};
          if (m.role !== "assistant") break;
          const text = (Array.isArray(m.content) ? m.content : []).filter((c: { type?: string }) => c?.type === "text").map((c: { text: string }) => c.text).join("");
          if (text.trim()) run.emit("message", { text });
          if (m.stopReason === "error") failure = m.errorMessage ?? "the model request failed";
          break;
        }
        case "tool_execution_start": {
          const [call] = piCalls(String(r.toolName ?? ""), (r.args ?? {}) as Record<string, unknown>, run.cwd);
          tools.set(r.toolCallId, call!.tool);
          run.emit("tool.started", { id: r.toolCallId, tool: call!.tool, input: call!.input });
          break;
        }
        case "tool_execution_end":
          run.emit("tool.result", { id: r.toolCallId, isError: Boolean(r.isError) });
          break;
        case "extension_ui_request":
          // A dialog from another of the user's extensions: nobody is at a terminal to answer it.
          if (["select", "confirm", "input", "editor"].includes(r.method)) write({ type: "extension_ui_response", id: r.id, cancelled: true });
          break;
        case "agent_settled":
          settle.resolve(Boolean(r.aborted));
          break;
      }
    };
    const reading = (async () => {
      let buf = "";
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i).replace(/\r$/, "");
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          try {
            onRecord(JSON.parse(line));
          } catch {
            // not a record
          }
        }
      }
    })();
    let stderr = "";
    void (async () => {
      for await (const chunk of proc.stderr) stderr = (stderr + new TextDecoder().decode(chunk)).slice(-2000);
    })();
    void proc.exited.then((code) => settle.reject(new Error(`pi exited${code ? ` with ${code}` : ""}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-2).join(" ")}` : ""}`)));

    const abort = () => {
      write({ type: "abort" });
      setTimeout(() => proc.kill(), 3000);
    };
    run.signal.addEventListener("abort", abort, { once: true });
    try {
      const accepted = await ask({ type: "prompt", message: run.prompt });
      if (!accepted.success) throw new Error(`pi refused the prompt: ${accepted.error ?? "unknown error"}`);
      const aborted = accepted.data?.disposition === "handled" ? false : await settled;
      const state = await Promise.race([ask({ type: "get_state" }), Bun.sleep(5000).then(() => null)]);
      const sessionId = String(state?.data?.sessionId ?? run.resume ?? "");
      run.emit("result", { subtype: aborted ? "interrupted" : failure ? "error" : "success", turns: 1 });
      if (aborted) throw new Error("pi stopped: interrupted");
      if (failure) throw new Error(`pi stopped: ${failure}`);
      return { sessionId };
    } finally {
      run.signal.removeEventListener("abort", abort);
      registered?.done();
      try {
        proc.stdin.end();
      } catch {
        // already closed
      }
      setTimeout(() => proc.kill(), 3000);
      void reading;
    }
  }
}
