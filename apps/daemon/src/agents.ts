import type { Database } from "bun:sqlite";
import type { AgentBrief, ReviewedPR, TaskKind } from "./adapters";
import type { WorkspaceConfig } from "./config";
import { body, HttpError, json, type Router } from "./http";

/**
 * The coding agents a terminal tab can run (Claude Code, Codex, pi, opencode), and which one this machine
 * starts by default. Each agent keeps its own setup and sign-in on the machine (~/.claude,
 * ~/.codex, ~/.pi, ~/.config/opencode); jin only adds its hooks, its tools and the task's rules when it launches one.
 */
export type AgentId = "claude" | "codex" | "pi" | "opencode";
export const AGENT_IDS: readonly AgentId[] = ["claude", "codex", "pi", "opencode"];

/** Where an agent starts and what it is told: a task's folder, rules and context. */
export interface LaunchContext {
  taskId?: string | null;
  taskRoot?: string;
  workspaceRoot?: string;
  parent?: string | null;
  terminalId?: string;
  kind?: TaskKind;
  prs?: ReviewedPR[];
  workspace?: WorkspaceConfig;
}

export interface AgentLaunch {
  readonly id: AgentId;
  /** As the user knows it: "Claude Code", "Codex". */
  readonly label: string;
  /** The command it runs as, looked up on the login shell's PATH. */
  readonly bin: string;
  /** A tab can start from another tab's conversation. */
  readonly canFork: boolean;
  /** The command line: jin's hooks, tools and rules, then resuming, forking or the first prompt. */
  argv(ctx: LaunchContext & { resume?: string; fork?: string; prompt?: string }): string[];
  env(workspace: WorkspaceConfig | undefined, ctx?: LaunchContext): Record<string, string>;
  /** Whether the agent saved a conversation under this id (one opened and left empty has none). */
  hasSession(sessionId: string, workspace: WorkspaceConfig | undefined): boolean;
  /**
   * Versions jin has checked its hooks against: why this one is not one of them (jin would not
   * know its tool calls are checked, so it is refused), else null. Absent: any version.
   */
  supports?(version: string | null): string | null;
  /** Before it starts (Codex: jin's hooks trusted); throws, with the reason, to refuse. */
  prepare?(ctx: LaunchContext): Promise<void>;
  /** What a task follows and what its workspace says, for its starting context (set once known). */
  linksOf?: (taskId: string) => { kind: string; label: string; url: string | null }[];
  briefOf?: (taskId: string) => AgentBrief | undefined;
}

export interface AgentView {
  id: AgentId;
  label: string;
  installed: boolean;
  version: string | null;
  /** Why jin will not run it here (a version it has not checked), else null. */
  problem: string | null;
}

/** An agent found on the login shell's PATH, and the version it reports. */
export interface Found {
  installed: boolean;
  version: string | null;
}

/** The first x.y.z in what `--version` printed. */
export const versionOf = (text: string): string | null => text.match(/(\d+)\.(\d+)\.(\d+)/)?.[0] ?? null;

/** For `supports`: a version whose major is one of `majors`, else why not. */
export const majors =
  (label: string, ok: number[], why: string) =>
  (version: string | null): string | null => {
    if (!version) return `jin could not read ${label}'s version, so it cannot tell whether it checks its tool calls`;
    const major = Number(version.split(".")[0]);
    return ok.includes(major) ? null : `jin supports ${label} ${ok.map((m) => `${m}.x`).join(", ")}; this machine has ${version}. ${why}`;
  };

const INSTALLED_FOR = 60_000; // ms a lookup is trusted

/** Run a command through the login shell (its PATH is the one agents run with); give up after `ms`. */
async function shellOut(script: string, bin: string, ms: number): Promise<{ code: number; out: string } | null> {
  const shell = process.env.SHELL || "/bin/bash";
  const proc = Bun.spawn([shell, "-l", "-c", script, "jin", bin], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  // A child that keeps the output open (a tool that waits for input on --version) must not hold us up.
  const done = Promise.all([proc.exited, new Response(proc.stdout).text()]).then(([code, out]) => ({ code, out }));
  const result = await Promise.race([done, Bun.sleep(ms).then(() => null)]);
  if (!result) proc.kill();
  return result;
}

/**
 * Whether `bin` is on the login shell's PATH and, when asked, the version it reports (null when
 * it does not say within a few seconds, which refuses an agent that lists the versions it supports).
 */
async function onPath(bin: string, withVersion: boolean): Promise<Found> {
  const found = await shellOut('command -v "$1" >/dev/null', bin, 10_000);
  if (!found || found.code !== 0) return { installed: false, version: null };
  if (!withVersion) return { installed: true, version: null };
  const v = await shellOut('"$1" --version 2>&1 </dev/null | head -5', bin, 8_000);
  return { installed: true, version: v ? versionOf(v.out) : null };
}

export class Agents {
  private seen = new Map<AgentId, Found & { at: number }>();

  constructor(
    private db: Database,
    private launches: Record<AgentId, AgentLaunch>,
    private lookup: (bin: string, withVersion: boolean) => Promise<Found> = onPath,
  ) {}

  launch(id: string): AgentLaunch {
    if (!(AGENT_IDS as readonly string[]).includes(id)) throw new HttpError(400, `agent must be one of ${AGENT_IDS.join(", ")}`);
    return this.launches[id as AgentId];
  }

  all(): AgentLaunch[] {
    return AGENT_IDS.map((id) => this.launches[id]);
  }

  /** The agent new tabs on this machine start: Claude Code until you pick another. */
  defaultId(): AgentId {
    const row = this.db.query("select value from settings where key = 'agent.default'").get() as { value: string } | null;
    return row && (AGENT_IDS as readonly string[]).includes(row.value) ? (row.value as AgentId) : "claude";
  }

  async setDefault(id: string): Promise<AgentId> {
    const agent = this.launch(id);
    const view = await this.view(agent.id, true);
    if (!view.installed) throw new HttpError(409, `${agent.label} is not installed on this machine (no \`${agent.bin}\` on the login shell's PATH)`);
    if (view.problem) throw new HttpError(409, view.problem);
    this.db.query("insert into settings (key, value) values ('agent.default', ?) on conflict(key) do update set value = excluded.value").run(agent.id);
    return agent.id;
  }

  private async found(id: AgentId, fresh = false): Promise<Found> {
    const hit = this.seen.get(id);
    if (!fresh && hit && Date.now() - hit.at < INSTALLED_FOR) return hit;
    const a = this.launches[id];
    // Every agent is asked its version (shown on its machine's page); the lookup gives up after a few seconds.
    const found = await this.lookup(a.bin, true).catch(() => ({ installed: false, version: null }));
    this.seen.set(id, { ...found, at: Date.now() });
    return found;
  }

  async view(id: AgentId, fresh = false): Promise<AgentView> {
    const a = this.launches[id];
    const { installed, version } = await this.found(id, fresh);
    return { id, label: a.label, installed, version, problem: installed ? (a.supports?.(version) ?? null) : null };
  }

  async installed(id: AgentId, fresh = false): Promise<boolean> {
    return (await this.found(id, fresh)).installed;
  }

  async list(): Promise<AgentView[]> {
    return Promise.all(this.all().map((a) => this.view(a.id)));
  }

  /** What a new agent tab or chat runs: the one asked for, else this machine's default; installed, and a version jin has checked. */
  async pick(id?: string | null): Promise<AgentLaunch> {
    const agent = this.launch(id || this.defaultId());
    const view = await this.view(agent.id);
    if (!view.installed) throw new HttpError(409, `${agent.label} is not installed on this machine: install it, or pick another agent for this machine in Settings`);
    if (view.problem) throw new HttpError(409, view.problem);
    return agent;
  }
}

export function agentRoutes(router: Router, agents: Agents) {
  router
    .on("GET", "/api/agents", async () => json({ default: agents.defaultId(), agents: await agents.list() }))
    .on("PUT", "/api/agents/default", async (req) => {
      const { id } = await body<{ id?: string }>(req);
      if (!id) throw new HttpError(400, "id is required");
      return json({ default: await agents.setDefault(id), agents: await agents.list() });
    });
}
