import { Glob } from "bun";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentLaunch, LaunchContext } from "./agents";
import { taskRules } from "./claude-cli";
import type { Config } from "./config";
import { HttpError } from "./http";

/**
 * Codex in a terminal tab. jin passes everything per launch with -c, so nothing is written
 * into the repos or into ~/.codex except one thing: Codex runs a hook only once it is trusted,
 * and skips an untrusted one without a word, so before each start jin checks its hooks through
 * Codex's app-server and trusts them (a `hooks.state` entry in ~/.codex/config.toml). If they
 * are still not trusted, the tab does not start.
 *
 * Codex runs in its workspace-write sandbox with the network off: anything outward (a push,
 * a pull request, a message) needs the network, so Codex asks the user in the terminal first.
 */

const HOOK = join(import.meta.dir, "hooks", "codex-hook.ts");
const TOOL_EVENTS = ["PreToolUse", "PostToolUse", "PermissionRequest"] as const;
const OTHER_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const;

/** A TOML string (JSON's escapes are valid TOML basic-string escapes). */
const toml = (s: string) => JSON.stringify(s);

/** jin's hooks, as -c flags: the same text on every launch, so Codex's trust in them holds. */
export function codexHookFlags(execPath = process.execPath, hook = HOOK): string[] {
  const command = (e: string) => `${JSON.stringify(execPath)} ${JSON.stringify(hook)} ${e}`;
  return [
    ...TOOL_EVENTS.map((e) => `hooks.${e}=[{matcher="*", hooks=[{type="command", command=${toml(command(e))}, timeout=${e === "PreToolUse" ? 30 : 10}}]}]`),
    ...OTHER_EVENTS.map((e) => `hooks.${e}=[{hooks=[{type="command", command=${toml(command(e))}, timeout=10}]}]`),
  ].flatMap((f) => ["-c", f]);
}

/** The sandbox jin runs Codex in, whatever ~/.codex/config.toml says: workspace writes, no network, ask first. */
export const CODEX_SANDBOX = ["-s", "workspace-write", "-a", "on-request", "-c", "sandbox_workspace_write.network_access=false"];

const SANDBOX_RULE =
  "SANDBOX: you run in Codex's workspace-write sandbox with the network off. Anything that needs the network (git push, gh, fetching or installing packages) or talks to jin on this machine (jin-task) fails inside it: request escalated permissions for that command, and the user approves it in this terminal.";

interface HookEntry {
  key: string;
  source: string;
  trustStatus: string;
  currentHash: string;
}

/** Run Codex's app-server (through the login shell, for its PATH), send requests, and stop it. */
async function appServer<T>(flags: string[], env: Record<string, string>, talk: (send: (method: string, params?: unknown) => Promise<any>) => Promise<T>): Promise<T> {
  const shell = process.env.SHELL || "/bin/bash";
  const proc = Bun.spawn([shell, "-l", "-c", 'exec "$@"', "jin", "codex", "app-server", ...flags], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, ...env } });
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let next = 1;
  const reader = (async () => {
    let buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: { id?: number; method?: string; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id == null || msg.method != null) continue;
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) w?.reject(new Error(msg.error.message ?? "app-server error"));
        else w?.resolve(msg.result);
      }
    }
    for (const w of waiting.values()) w.reject(new Error("Codex's app-server stopped"));
  })();
  const write = (m: unknown) => {
    proc.stdin.write(JSON.stringify(m) + "\n");
    proc.stdin.flush();
  };
  const send = (method: string, params?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      write({ id, method, params });
    });
  const timer = setTimeout(() => proc.kill(), 30_000);
  try {
    await send("initialize", { clientInfo: { name: "jin", version: "1" } });
    write({ method: "initialized" });
    return await talk(send);
  } finally {
    clearTimeout(timer);
    proc.kill();
    await reader.catch(() => {});
  }
}

/**
 * Make sure Codex will run jin's hooks: list them as Codex sees them with these flags, trust
 * the ones that are not (yet, or since they changed), and check again. Throws if any is still
 * untrusted, because Codex would then run every tool call unchecked.
 */
export async function trustCodexHooks(flags: string[], cwd: string, env: Record<string, string> = {}): Promise<void> {
  const ours = (r: { data?: { hooks?: HookEntry[] }[] }) => (r.data ?? []).flatMap((d) => d.hooks ?? []).filter((h) => h.source === "sessionFlags");
  await appServer(flags, env, async (send) => {
    const before = ours(await send("hooks/list", { cwds: [cwd] }));
    if (!before.length) throw new Error("Codex did not load jin's hooks");
    const edits = before
      .filter((h) => h.trustStatus !== "trusted" && h.trustStatus !== "managed")
      .map((h) => ({ keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`, mergeStrategy: "replace", value: h.currentHash }));
    if (edits.length) await send("config/batchWrite", { edits });
    const after = ours(await send("hooks/list", { cwds: [cwd] }));
    const untrusted = after.filter((h) => h.trustStatus !== "trusted" && h.trustStatus !== "managed");
    if (untrusted.length || after.length !== before.length) throw new Error(`Codex still does not trust ${untrusted.length || "all"} of jin's hooks`);
  });
}

/** Codex keeps each conversation as a rollout file named after its id, under sessions/<date>/. */
export function codexHasSession(sessionId: string, codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")): boolean {
  if (!/^[\w-]+$/.test(sessionId)) return false;
  const dir = join(codexHome, "sessions");
  if (!existsSync(dir)) return false;
  for (const _ of new Glob(`**/*${sessionId}.jsonl`).scanSync({ cwd: dir, onlyFiles: true })) return true;
  return false;
}

export function codexLaunch(config: Config, binDir?: string, trust: typeof trustCodexHooks = trustCodexHooks): AgentLaunch {
  const hooks = codexHookFlags();
  const launch: AgentLaunch = {
    id: "codex",
    label: "Codex",
    bin: "codex",
    canFork: false,
    argv: (ctx) => {
      const flags = [...hooks, ...CODEX_SANDBOX];
      // jin's tools (the work journal, the task's context) through `jin-task mcp`, which knows its
      // terminal; Codex runs them without asking (they only read the task and write its journal).
      if (ctx.taskId && ctx.terminalId && binDir) {
        flags.push(
          "-c", `mcp_servers.jin.command=${toml(join(binDir, "jin-task"))}`,
          "-c", 'mcp_servers.jin.args=["mcp"]',
          "-c", `mcp_servers.jin.env={JIN_TERMINAL_ID=${toml(ctx.terminalId)}, JIN_HOME=${toml(config.home)}}`,
          "-c", 'mcp_servers.jin.default_tools_approval_mode="approve"',
        );
      }
      if (ctx.taskId) {
        const rules = taskRules({ ...ctx, taskId: ctx.taskId, journal: Boolean(binDir && ctx.terminalId), links: launch.linksOf?.(ctx.taskId) ?? [], brief: launch.briefOf?.(ctx.taskId) });
        flags.push("-c", `developer_instructions=${toml(`${rules}\n${SANDBOX_RULE}`)}`);
      }
      if (ctx.resume) return ["codex", ...flags, "resume", ctx.resume];
      return ["codex", ...flags, ...(ctx.prompt?.trim() ? [ctx.prompt.trim()] : [])];
    },
    env: () => ({ JIN_HOME: config.home, ...(binDir ? { PATH: `${binDir}:${process.env.PATH ?? ""}` } : {}) }),
    hasSession: (id) => codexHasSession(id),
    prepare: async (ctx: LaunchContext) => {
      const cwd = ctx.taskRoot ?? ctx.workspaceRoot ?? homedir();
      try {
        await trust(hooks, cwd, launch.env(ctx.workspace));
      } catch (err) {
        throw new HttpError(409, `Codex did not start: jin could not get Codex to trust its hooks, and without them nothing would check its tool calls (${err instanceof Error ? err.message : err})`);
      }
    },
  };
  return launch;
}

