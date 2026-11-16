import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Jin's own settings, from $JIN_HOME/config.yaml. */
export interface Config {
  home: string;
  /** local: no timers or unattended work. vm: always-on features enabled. */
  mode: "local" | "vm";
  /** The only browser origin the API accepts (the web app). */
  webOrigin: string;
  port: number;
}

/** One organisation's workspace, from $JIN_HOME/workspaces/<id>.yaml. */
export interface WorkspaceConfig {
  id: string;
  adapter: "composio" | "git";
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
  return {
    home,
    mode,
    webOrigin: String(raw.webOrigin ?? "http://127.0.0.1:3917"),
    port: Number(process.env.JIN_PORT ?? raw.port ?? 7317),
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
      if (raw.adapter !== "composio" && raw.adapter !== "git") throw new Error(`${f}: unknown adapter ${raw.adapter}`);
      if (!raw.root) throw new Error(`${f}: root is required`);
      return {
        id,
        adapter: raw.adapter,
        root: String(raw.root),
        github: { owners: (raw.github?.owners ?? []).map(String) },
        profile: {
          claudeConfigDir: raw.profile?.claudeConfigDir ? String(raw.profile.claudeConfigDir) : undefined,
          codexHome: raw.profile?.codexHome ? String(raw.profile.codexHome) : undefined,
        },
      };
    });
}
