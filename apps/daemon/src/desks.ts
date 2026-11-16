import { query, type McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import type { Config, WorkspaceConfig } from "./config";
import { connectorsReady } from "./harness/claude";
import { json, type Router } from "./http";

/** Whether a desk's connection is there: GitHub through gh, the others through Claude's connectors. */
export interface DeskStatus {
  kind: "github" | "gmail" | "slack" | "linear" | "notion";
  state: "connected" | "needs-auth" | "failed" | "missing";
  /** What provides it: "gh", or the connector or MCP server's name. */
  via: string | null;
}

const DESKS = ["gmail", "slack", "linear", "notion"] as const;
const TTL = 5 * 60_000;

/** A desk's server among the user's: a claude.ai connector ("claude.ai Gmail") or an MCP server named after it. */
export function deskStatuses(servers: Pick<McpServerStatus, "name" | "status">[]): DeskStatus[] {
  return DESKS.map((kind) => {
    const mine = servers.filter((s) => s.name.toLowerCase().includes(kind));
    const best = mine.find((s) => s.status === "connected") ?? mine.find((s) => s.status === "needs-auth") ?? mine[0];
    if (!best) return { kind, state: "missing", via: null };
    const state = best.status === "connected" ? "connected" : best.status === "needs-auth" ? "needs-auth" : best.status === "pending" ? "missing" : "failed";
    return { kind, state, via: best.name };
  });
}

/**
 * Desk connections, checked by starting Claude without a message (no model call): it lists
 * the user's connectors and MCP servers once they have connected. Cached for a few minutes.
 */
export class Desks {
  private cached: { at: number; list: DeskStatus[] } | null = null;
  private inflight: Promise<DeskStatus[]> | null = null;

  constructor(
    private config: Config,
    private workspaces: WorkspaceConfig[],
  ) {}

  async status(fresh = false): Promise<DeskStatus[]> {
    if (!fresh && this.cached && Date.now() - this.cached.at < TTL) return this.cached.list;
    this.inflight ??= this.check().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async check(): Promise<DeskStatus[]> {
    const [servers, gh] = await Promise.all([this.servers(), this.gh()]);
    const list: DeskStatus[] = [{ kind: "github", state: gh ? "connected" : "needs-auth", via: "gh" }, ...deskStatuses(servers)];
    this.cached = { at: Date.now(), list };
    return list;
  }

  private async gh(): Promise<boolean> {
    const p = Bun.spawn(["gh", "auth", "status"], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  }

  private async servers(): Promise<McpServerStatus[]> {
    const profile = this.workspaces[0]?.profile.claudeConfigDir;
    const controller = new AbortController();
    let done!: () => void;
    const closed = new Promise<void>((r) => (done = r));
    // A prompt that never sends anything: the session starts, its servers connect, then it closes.
    const prompt = (async function* () {
      await closed;
    })() as AsyncIterable<never>;
    const q = query({
      prompt,
      options: {
        cwd: this.config.home,
        env: { ...process.env, ...(profile ? { CLAUDE_CONFIG_DIR: profile } : {}) } as Record<string, string>,
        settingSources: ["user"],
        abortController: controller,
      },
    });
    const drain = (async () => {
      try {
        for await (const _ of q) {
          // nothing is asked, nothing comes back but the init
        }
      } catch {
        // closed below
      }
    })();
    try {
      await connectorsReady(() => q.mcpServerStatus());
      return await q.mcpServerStatus();
    } catch {
      return [];
    } finally {
      done();
      controller.abort();
      await drain;
    }
  }
}

export function deskRoutes(router: Router, desks: Desks) {
  router.on("GET", "/api/desks", async (_req, _p, url) => json(await desks.status(url.searchParams.get("fresh") === "1")));
}
