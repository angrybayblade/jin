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
}

/** One organisation's workspace, from $JIN_HOME/workspaces/<id>.yaml. */
export interface WorkspaceConfig {
  id: string;
  /** Its workspace provider (adapters/: cws, git, …). */
  adapter: string;
  root: string;
  github: { owners: string[] };
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
  };
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
        profile: {
          claudeConfigDir: raw.profile?.claudeConfigDir ? String(raw.profile.claudeConfigDir) : undefined,
          codexHome: raw.profile?.codexHome ? String(raw.profile.codexHome) : undefined,
        },
      };
    });
}

function ownersOf(adapter: string, root: string): string[] {
  try {
    return provider(adapter).owners(root);
  } catch {
    return [];
  }
}
