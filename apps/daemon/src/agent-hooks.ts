import { isAbsolute, join } from "node:path";
import type { WorkspaceAdapter } from "./adapters";
import type { AgentId } from "./agents";
import { body, json, type Router } from "./http";
import { evaluate, type Verdict } from "./policy";
import { createdPrs } from "./prs";
import type { AgentStatus, Terminals } from "./terminals";

/**
 * What the hooks of agents in terminal tabs report (POST /api/hooks/<agent>): status for the
 * command center, the session id to resume, journal evidence, created pull requests, and jin's
 * verdict on each tool call. Claude Code and Codex send the same events under the same names;
 * where they differ (Codex edits files with one `apply_patch` call, and cannot be told to ask)
 * is said here.
 */

/** A tool call as jin's policy and journal name it (Claude Code's tool names). */
interface Call {
  tool: string;
  input: Record<string, unknown>;
}

/** The files an `apply_patch` patch adds, changes, deletes or moves to. */
export function patchFiles(patch: string, cwd?: string): string[] {
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) => (m[1] ?? m[2]!).trim());
  return [...new Set(files)].map((f) => (cwd && !isAbsolute(f) ? join(cwd, f) : f));
}

/** Codex's tool calls as jin knows them: each file an apply_patch touches is an Edit. */
export function codexCalls(tool: string, input: Record<string, unknown>, cwd?: string): Call[] {
  if (tool === "apply_patch") {
    const patch = String(input.command ?? input.patch ?? input.input ?? "");
    const files = patchFiles(patch, cwd);
    return files.length ? files.map((file_path) => ({ tool: "Edit", input: { file_path } })) : [{ tool, input }];
  }
  return [{ tool, input }];
}

/** pi's built-in tools as jin knows them (Claude Code's names and fields); MCP and others as they are. */
export function piCalls(tool: string, input: Record<string, unknown>, cwd?: string): Call[] {
  const abs = (p: unknown) => (typeof p === "string" && p ? (cwd && !isAbsolute(p) ? join(cwd, p) : p) : undefined);
  switch (tool) {
    case "bash":
      return [{ tool: "Bash", input: { command: String(input.command ?? "") } }];
    case "edit":
      return [{ tool: "Edit", input: { file_path: abs(input.path) } }];
    case "write":
      return [{ tool: "Write", input: { file_path: abs(input.path) } }];
    case "read":
      return [{ tool: "Read", input: { file_path: abs(input.path) } }];
    case "grep":
      return [{ tool: "Grep", input: { pattern: input.pattern, path: abs(input.path) } }];
    case "find":
      return [{ tool: "Glob", input: { pattern: input.pattern, path: abs(input.path) } }];
    case "ls":
      return [{ tool: "LS", input: { path: abs(input.path) } }];
    default:
      return [{ tool, input }];
  }
}

/** opencode's built-in tools as jin knows them; its patch tool is an edit of each file it touches. */
export function opencodeCalls(tool: string, input: Record<string, unknown>, cwd?: string): Call[] {
  const abs = (p: unknown) => (typeof p === "string" && p ? (cwd && !isAbsolute(p) ? join(cwd, p) : p) : undefined);
  switch (tool) {
    case "bash":
      return [{ tool: "Bash", input: { command: String(input.command ?? "") } }];
    case "edit":
      return [{ tool: "Edit", input: { file_path: abs(input.filePath) } }];
    case "write":
      return [{ tool: "Write", input: { file_path: abs(input.filePath) } }];
    case "read":
      return [{ tool: "Read", input: { file_path: abs(input.filePath) } }];
    case "glob":
      return [{ tool: "Glob", input: { pattern: input.pattern, path: abs(input.path) } }];
    case "grep":
      return [{ tool: "Grep", input: { pattern: input.pattern, path: abs(input.path) } }];
    case "list":
      return [{ tool: "LS", input: { path: abs(input.path) } }];
    case "webfetch":
      return [{ tool: "WebFetch", input: { url: input.url } }];
    case "patch":
    case "apply_patch": {
      const files = patchFiles(String(input.patchText ?? input.patch ?? ""), cwd);
      return files.length ? files.map((file_path) => ({ tool: "Edit", input: { file_path } })) : [{ tool, input }];
    }
    default:
      return [{ tool, input }];
  }
}

/**
 * What jin answers an agent's hook for one tool call. Claude Code shows its own permission
 * prompt for "ask". Codex ignores "ask", so: a shell command needs the network to do anything
 * outward and Codex's sandbox (network off) makes it ask the user first; any other tool jin
 * would ask about is blocked, since nothing would stop it.
 */
export function answer(agent: AgentId, tool: string, verdict: Verdict): { decision?: "deny" | "ask"; reason?: string } {
  if (verdict.decision === "deny") return { decision: "deny", reason: verdict.reason };
  if (verdict.decision !== "ask") return {};
  // Claude Code shows its permission prompt; jin's pi extension shows pi's own; jin's opencode
  // plugin leaves opencode's permission request for the user to answer.
  if (agent === "claude" || agent === "pi" || agent === "opencode") return { decision: "ask", reason: verdict.reason };
  if (tool === "Bash") return {};
  return { decision: "deny", reason: `${verdict.reason}; a Codex tab cannot ask you first, so jin blocks it. Do it from a Claude Code tab, or yourself.` };
}

export interface AgentHookDeps {
  terminals: Terminals;
  adapters: Map<string, WorkspaceAdapter>;
  workspaceOf: (terminalId: string | null) => string | undefined;
  /** After each hook: the tab's status before and after (notifications use it). */
  onStatus?: (terminalId: string, before: AgentStatus, after: AgentStatus, event: string, input: Record<string, any>) => void;
  /** A tool call created pull requests (attached to the terminal's task). */
  onPrsCreated?: (terminalId: string, urls: string[]) => void;
  /** A chat or room agent's tool call (Codex through jin's app-server client): why it may not start, else null. */
  precheck?: (sessionId: string, tool: string, input: Record<string, unknown>) => string | null;
  /** A chat or room agent's tool call, decided in full by its session's gate (pi waits for it, approvals included). */
  sessionGate?: (sessionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<{ allow: boolean; reason?: string }>;
  /** The task's work journal: turns start, and tool calls leave evidence. */
  journal?: { turnStarted: (terminalId: string) => void; evidence: (terminalId: string, tool: string, input: Record<string, unknown>) => void };
}

export function agentHookRoutes(router: Router, deps: AgentHookDeps) {
  const { terminals } = deps;
  const handle = async (agent: AgentId, req: Request) => {
    const { event, terminalId, sessionId, input } = await body<{ event: string; terminalId: string | null; sessionId?: string | null; input: Record<string, any> }>(req);
    const tool = String(input.tool_name ?? "");
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
    const calls =
      agent === "codex" ? codexCalls(tool, toolInput, cwd) : agent === "pi" ? piCalls(tool, toolInput, cwd) : agent === "opencode" ? opencodeCalls(tool, toolInput, cwd) : [{ tool, input: toolInput }];
    // A pi or opencode chat or room agent: the session's gate decides, and the agent waits (an approval included).
    if ((agent === "pi" || agent === "opencode") && sessionId && !terminalId) {
      if (event !== "PreToolUse" || !deps.sessionGate) return json({});
      for (const c of calls) {
        const v = await deps.sessionGate(sessionId, c.tool, c.input, req.signal);
        if (!v.allow) return json({ decision: "deny", reason: v.reason ?? "not allowed" });
      }
      return json({ decision: "allow" });
    }
    // A Codex chat or room agent: its session's rules decide whether a call may start; what
    // needs the user's approval comes to the session's gate from the harness.
    if (sessionId && !terminalId) {
      if (event !== "PreToolUse" || !deps.precheck) return json({});
      for (const c of calls) {
        const reason = deps.precheck(sessionId, c.tool, c.input);
        if (reason) return json({ decision: "deny", reason });
      }
      return json({});
    }
    const before = terminalId && terminals.isLive(terminalId) ? terminals.get(terminalId).status : null;
    const report = () => {
      if (terminalId && before && deps.onStatus && terminals.isLive(terminalId)) deps.onStatus(terminalId, before, terminals.get(terminalId).status, event, input);
    };
    if (terminalId) {
      // The agent's session id (Claude Code's is new on /clear) lets the tab resume after a restart.
      if (typeof input.session_id === "string" && input.session_id) terminals.setAgentSession(terminalId, input.session_id);
      if (event === "UserPromptSubmit" || event === "PreToolUse" || event === "PostToolUse" || event === "Resumed") terminals.setStatus(terminalId, "working");
      else if (event === "Notification") terminals.setStatus(terminalId, input.notification_type === "idle_prompt" ? "idle" : "waiting", typeof input.message === "string" ? input.message : null);
      else if (event === "PermissionRequest") terminals.setStatus(terminalId, "waiting", `approval: ${typeof toolInput.command === "string" ? toolInput.command : tool}`);
      else if (event === "Stop" || event === "SessionStart") terminals.setStatus(terminalId, "idle");
    }
    if (terminalId && deps.journal) {
      if (event === "UserPromptSubmit") deps.journal.turnStarted(terminalId);
      else if (event === "PostToolUse") for (const c of calls) deps.journal.evidence(terminalId, c.tool, c.input);
    }
    if (event === "PostToolUse" && terminalId && deps.onPrsCreated) {
      const urls = createdPrs(calls[0]!.tool, calls[0]!.input, input.tool_response);
      if (urls.length) deps.onPrsCreated(terminalId, urls);
    }
    if (event !== "PreToolUse") {
      report();
      return json({});
    }
    const workspace = deps.workspaceOf(terminalId);
    const rules = workspace ? deps.adapters.get(workspace)?.policy() : undefined;
    // The strictest verdict across the call's parts (each file a patch touches).
    const verdicts = calls.map((c) => evaluate(c.tool, c.input, rules));
    const verdict = verdicts.find((v) => v.decision === "deny") ?? verdicts.find((v) => v.decision === "ask") ?? verdicts[0]!;
    const out = answer(agent, calls[0]!.tool, verdict);
    if (out.decision === "ask" && terminalId) terminals.setStatus(terminalId, "waiting", `approval: ${verdict.reason}`);
    report();
    return json(out); // nothing: the agent's own permission rules decide, as in a terminal
  };
  router
    .on("POST", "/api/hooks/claude", (req) => handle("claude", req))
    .on("POST", "/api/hooks/codex", (req) => handle("codex", req))
    .on("POST", "/api/hooks/pi", (req) => handle("pi", req))
    .on("POST", "/api/hooks/opencode", (req) => handle("opencode", req));
}
