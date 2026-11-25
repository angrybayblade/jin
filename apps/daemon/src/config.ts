import { TRACKER_IDS } from "./trackers";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { provider, providerId } from "./adapters";

/** Jin's own settings, from $JIN_HOME/config.yaml. */
export interface Config {
  home: string;
  /** local: no timers or unattended work. vm: always-on features enabled. */
  mode: "local" | "vm";
  /** The only browser origin the API accepts (the web app), as 127.0.0.1 and as localhost. */
  webOrigin: string;
  webOrigins: string[];
  port: number;
  /** Model for jin's chats (Agent SDK) and the Claude Code sessions jin starts; `model:` in config.yaml. */
  model: string;
  /** How jin sets itself up on the machines it adds (`machines:` in config.yaml). */
  machines: MachineSetup;
}

/**
 * Where jin puts itself on a machine it adds. The defaults are the real jin; a development copy
 * sets its own (`machines: { home: .jin-dev, port: 7318, service: jin-dev-daemon, source: worktree }`)
 * so its jin on a machine runs beside the real one, from this checkout's working tree.
 */
export interface MachineSetup {
  /** Its home there, relative to the user's home directory. */
  home: string;
  /** Its daemon's port there. */
  port: number;
  /** Its systemd user service's name there. */
  service: string;
  /** What it copies: "committed" (git HEAD) or "worktree" (the files as they are, uncommitted changes included). */
  source: "committed" | "worktree";
}

/** One organisation's workspace, from $JIN_HOME/workspaces/<id>.yaml. */
export interface WorkspaceConfig {
  id: string;
  /** Its workspace provider (adapters/: cws, git, …). */
  adapter: string;
  root: string;
  github: { owners: string[] };
  /** Where its tasks' issues live: a tracker's id (trackers/: linear, github), or null for none. Unset: its provider's default. */
  tracker?: string | null;
  /**
   * Harness config per organisation. Unset means the machine's default Claude login;
   * set it to keep one organisation's connectors and logins apart from another's
   * (each such directory needs its own `claude` login).
   */
  profile: { claudeConfigDir?: string; codexHome?: string };
}

export function jinHome(): string {
  return process.env.JIN_HOME ?? join(homedir(), ".jin");
}

const parse = (file: string): Record<string, any> => (Bun.YAML.parse(readFileSync(file, "utf8")) as Record<string, any>) ?? {};

export function loadConfig(home = jinHome()): Config {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, "config.yaml");
  const raw = existsSync(file) ? parse(file) : {};
  const mode = raw.mode === "vm" ? "vm" : "local";
  // webOrigins (a list) lets more than one jin use this daemon: a machine onboarded by your
  // installed app and by a development copy; webOrigin is the single-origin form.
  const listed = [raw.webOrigin, ...(Array.isArray(raw.webOrigins) ? raw.webOrigins : [])].filter(Boolean).map(String);
  const webOrigin = listed[0] ?? "http://127.0.0.1:3917";
  const alias = (o: string) => (o.includes("//127.0.0.1") ? o.replace("//127.0.0.1", "//localhost") : o.replace("//localhost", "//127.0.0.1"));
  return {
    home,
    mode,
    webOrigin,
    webOrigins: [...new Set((listed.length ? listed : [webOrigin]).flatMap((o) => [o, alias(o)]))],
    port: Number(process.env.JIN_PORT ?? raw.port ?? 7317),
    model: String(raw.model ?? "claude-opus-5-5"),
    machines: machineSetup(raw.machines),
  };
}

/** `machines:` from config.yaml, checked: a plain directory name, a port, a service name. */
export function machineSetup(raw: unknown): MachineSetup {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const home = String(r.home ?? ".jin").replace(/^~\//, "");
  if (!/^\.?[\w.-]+$/.test(home) || home === "." || home === "..") throw new Error(`config.yaml: machines.home must be a directory name in the home directory (got ${home})`);
  const port = Number(r.port ?? 7317);
  if (!Number.isInteger(port) || port <= 1024 || port >= 65536) throw new Error("config.yaml: machines.port must be a port above 1024");
  const service = String(r.service ?? "jin-daemon");
  if (!/^[\w-]+$/.test(service)) throw new Error("config.yaml: machines.service must be a plain service name");
  const source = r.source === "worktree" ? "worktree" : "committed";
  return { home, port, service, source };
}

/** The file a workspace is configured in (its name, or the one whose id it is), if any. */
export function workspaceFile(home: string, id: string): string | null {
  const dir = join(home, "workspaces");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const named = files.find((f) => f.replace(/\.ya?ml$/, "") === id);
  if (named) return join(dir, named);
  const other = files.find((f) => {
    try {
      return String(parse(join(dir, f)).id ?? "") === id;
    } catch {
      return false;
    }
  });
  return other ? join(dir, other) : null;
}

export function loadWorkspaces(home = jinHome()): WorkspaceConfig[] {
  const dir = join(home, "workspaces");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => {
      const raw = parse(join(dir, f));
      const id = String(raw.id ?? f.replace(/\.ya?ml$/, ""));
      if (!raw.adapter) throw new Error(`${f}: adapter is required`);
      if (!raw.root) throw new Error(`${f}: root is required`);
      return {
        id,
        adapter: providerId(String(raw.adapter)),
        root: String(raw.root),
        // Unset: read from the workspace by its provider (cws: its submodules' GitHub owners).
        github: { owners: Array.isArray(raw.github?.owners) ? raw.github.owners.map(String) : ownersOf(String(raw.adapter), String(raw.root)) },
        tracker: trackerOf(f, raw.tracker, String(raw.adapter)),
        profile: {
          claudeConfigDir: raw.profile?.claudeConfigDir ? String(raw.profile.claudeConfigDir) : undefined,
          codexHome: raw.profile?.codexHome ? String(raw.profile.codexHome) : undefined,
        },
      };
    });
}

/** The workspace's tracker: as configured ("none" for none), else its provider's default. */
function trackerOf(file: string, configured: unknown, adapter: string): string | null {
  if (configured !== undefined && configured !== null) {
    const id = String(configured);
    if (!(TRACKER_IDS as readonly string[]).includes(id)) throw new Error(`${file}: tracker must be one of ${TRACKER_IDS.join(", ")}`);
    return id === "none" ? null : id;
  }
  try {
    return provider(adapter).defaultTracker ?? null;
  } catch {
    return null;
  }
}

function ownersOf(adapter: string, root: string): string[] {
  try {
    return provider(adapter).owners(root);
  } catch {
    return [];
  }
}
