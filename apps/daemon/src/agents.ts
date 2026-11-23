import type { Database } from "bun:sqlite";
import type { AgentBrief, ReviewedPR, TaskKind } from "./adapters";
import type { WorkspaceConfig } from "./config";
import { body, HttpError, json, type Router } from "./http";

/**
 * The coding agents a terminal tab can run (Claude Code, Codex, pi), and which one this machine
 * starts by default. Each agent keeps its own setup and sign-in on the machine (~/.claude,
 * ~/.codex, ~/.pi); jin only adds its hooks, its tools and the task's rules when it launches one.
 */
export type AgentId = "claude" | "codex" | "pi";
export const AGENT_IDS: readonly AgentId[] = ["claude", "codex", "pi"];

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
}

const INSTALLED_FOR = 60_000; // ms a lookup is trusted

/** Whether `bin` is on the login shell's PATH (agents run through it, so its PATH is the one that counts). */
async function onPath(bin: string): Promise<boolean> {
  const shell = process.env.SHELL || "/bin/bash";
  const proc = Bun.spawn([shell, "-l", "-c", 'command -v "$1" >/dev/null', "jin", bin], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), 10_000);
  const code = await proc.exited;
  clearTimeout(timer);
  return code === 0;
}

export class Agents {
  private seen = new Map<AgentId, { installed: boolean; at: number }>();

  constructor(
    private db: Database,
    private launches: Record<AgentId, AgentLaunch>,
    private lookup: (bin: string) => Promise<boolean> = onPath,
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
    if (!(await this.installed(agent.id, true))) throw new HttpError(409, `${agent.label} is not installed on this machine (no \`${agent.bin}\` on the login shell's PATH)`);
    this.db.query("insert into settings (key, value) values ('agent.default', ?) on conflict(key) do update set value = excluded.value").run(agent.id);
    return agent.id;
  }

  async installed(id: AgentId, fresh = false): Promise<boolean> {
    const hit = this.seen.get(id);
    if (!fresh && hit && Date.now() - hit.at < INSTALLED_FOR) return hit.installed;
    const installed = await this.lookup(this.launches[id].bin).catch(() => false);
    this.seen.set(id, { installed, at: Date.now() });
    return installed;
  }

  async list(): Promise<AgentView[]> {
    return Promise.all(this.all().map(async (a) => ({ id: a.id, label: a.label, installed: await this.installed(a.id) })));
  }

  /** What a new agent tab runs: the one asked for, else this machine's default; it must be installed. */
  async pick(id?: string | null): Promise<AgentLaunch> {
    const agent = this.launch(id || this.defaultId());
    if (!(await this.installed(agent.id))) throw new HttpError(409, `${agent.label} is not installed on this machine: install it, or pick another agent for this machine in Settings`);
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
