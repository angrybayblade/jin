import { join } from "node:path";
import { opencodeCalls } from "../agent-hooks";
import type { AgentTools } from "../agent-tools";
import { opencodeConfig, writeInstructions } from "../opencode-cli";
import type { Harness, HarnessRun } from "./types";

/**
 * opencode for chats and room agents: each turn is one `opencode run --format json`, continuing
 * its session with `-s`. jin's plugin sends every tool call to the session's gate and opencode
 * waits for the answer, so policy, the session's rules (a read-only room agent) and approvals
 * in jin hold as for Claude. jin's own tools reach opencode as an MCP server (the bridge Codex
 * and pi use). opencode uses its own models and sign-ins.
 */

const BRIDGE = join(import.meta.dir, "..", "hooks", "agent-tools-mcp.ts");

export class OpencodeHarness implements Harness {
  readonly id = "opencode" as const;
  readonly adapter = "opencode-run";

  constructor(private opts: { home: string; tools: AgentTools; execPath?: string; /** Throws when this machine's version is not one jin has checked. */ ensure?: () => Promise<unknown> }) {}

  async run(run: HarnessRun): Promise<{ sessionId: string }> {
    await this.opts.ensure?.();
    const registered = run.tools?.length ? this.opts.tools.register(run.tools) : null;
    const instructions = run.instructions ? writeInstructions(this.opts.home, `session-${run.jinSessionId ?? "chat"}`, run.instructions) : undefined;
    const mcp = registered ? { command: [this.opts.execPath ?? process.execPath, BRIDGE], environment: { JIN_AGENT_TOOLS: registered.token, JIN_HOME: this.opts.home } } : undefined;
    const env: Record<string, string> = {
      ...run.env,
      JIN_HOME: this.opts.home,
      ...(run.jinSessionId ? { JIN_SESSION_ID: run.jinSessionId } : {}),
      OPENCODE_CONFIG_CONTENT: opencodeConfig({ ask: false, mcp, instructions }),
    };
    const args = ["run", "--format", "json", ...(run.resume ? ["-s", run.resume] : []), run.prompt];
    const shell = process.env.SHELL || "/bin/bash";
    const proc = Bun.spawn([shell, "-l", "-c", 'exec "$@"', "jin", "opencode", ...args], { cwd: run.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
    const abort = () => proc.kill("SIGINT");
    run.signal.addEventListener("abort", abort, { once: true });

    let sessionId = run.resume ?? "";
    let failure: string | null = null;
    const name = (tool: string) => (tool.startsWith("jin_") ? `mcp__jin__${tool.slice(4)}` : tool);
    let stderr = "";
    const errors = (async () => {
      for await (const chunk of proc.stderr) stderr = (stderr + new TextDecoder().decode(chunk)).slice(-4000);
    })();
    try {
      let buf = "";
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let e: { type?: string; sessionID?: string; part?: any; error?: any };
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          if (e.sessionID) sessionId = e.sessionID;
          if (e.type === "text" && String(e.part?.text ?? "").trim()) run.emit("message", { text: e.part.text });
          else if (e.type === "tool_use" && e.part) {
            const [call] = opencodeCalls(name(String(e.part.tool ?? "")), (e.part.state?.input ?? {}) as Record<string, unknown>, run.cwd);
            run.emit("tool.started", { id: e.part.callID, tool: call!.tool, input: call!.input });
            run.emit("tool.result", { id: e.part.callID, isError: e.part.state?.status === "error" });
          } else if (e.type === "error") failure = String(e.error?.data?.message ?? e.error?.message ?? e.error?.name ?? "opencode failed");
        }
      }
      const code = await proc.exited;
      await errors;
      if (run.signal.aborted) {
        run.emit("result", { subtype: "interrupted", turns: 1 });
        throw new Error("opencode stopped: interrupted");
      }
      if (!failure && code !== 0) failure = stderr.trim().split("\n").slice(-2).join(" ") || `opencode exited with ${code}`;
      run.emit("result", { subtype: failure ? "error" : "success", turns: 1 });
      if (failure) throw new Error(`opencode stopped: ${failure}`);
      return { sessionId };
    } finally {
      run.signal.removeEventListener("abort", abort);
      registered?.done();
    }
  }
}
