import { spawnSync } from "node:child_process";
import type { Detected, WorkspaceProvider } from "./types";
import { PROVIDERS } from "./index";

/**
 * Finding workspaces, for every provider at once: one script that runs on this machine or
 * over SSH. Each line it prints is `<provider> <FOUND|PREFERRED|USING> <inode> <root>`; the
 * inode tells two spellings of one folder apart on a case-insensitive disk.
 */
export function detectionScript(providers: WorkspaceProvider[] = PROVIDERS): string {
  const one = (p: WorkspaceProvider) => `
( ${p.detectScript()}
) 2>/dev/null | while read -r how root; do
  [ -n "$root" ] && [ -d "$root" ] && echo "${p.id} $how $(ls -di "$root" | awk '{print $1}') $root"
done`;
  return `${providers.map(one).join("\n")}
# the workspaces jin there already uses
for f in "$HOME"/.jin/workspaces/*.yaml; do
  [ -f "$f" ] || continue
  r=$(sed -n 's/^root: *//p' "$f" | head -1); a=$(sed -n 's/^adapter: *//p' "$f" | head -1)
  [ -n "$r" ] && echo "\${a:-?} USING 0 $r"
done
true
`;
}

/** What the detection script found: the workspaces (preferred first), and the roots jin there uses. */
export function readDetections(out: string): { found: Detected[]; using: string[] } {
  const found = new Map<string, Detected>();
  const using: string[] = [];
  for (const line of out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n")) {
    const m = /^(\S+) (FOUND|PREFERRED|USING) (\d+) (.+)$/.exec(line.trim());
    if (!m) continue;
    const [, provider, how, inode, root] = m;
    if (how === "USING") {
      using.push(root!.trim());
      continue;
    }
    const key = `${provider}:${inode}`;
    const prev = found.get(key);
    if (!prev || (how === "PREFERRED" && !prev.preferred)) found.set(key, { provider: provider!, root: root!.trim(), preferred: how === "PREFERRED" });
  }
  return { found: [...found.values()].sort((a, b) => Number(b.preferred) - Number(a.preferred)), using };
}

/** Whether `root` on this machine is a workspace of this provider's kind. */
export function isWorkspaceAt(p: WorkspaceProvider, root: string): boolean {
  return spawnSync("sh", ["-c", p.check], { env: { ...process.env, ROOT: root }, stdio: "ignore" }).status === 0;
}

/** A workspace's config file ($JIN_HOME/workspaces/<id>.yaml); owners are read from the workspace when left out. */
export function workspaceYaml(w: { id: string; adapter: string; root: string; owners?: string[] }): string {
  return [`id: ${w.id}`, `adapter: ${w.adapter}`, `root: ${w.root}`, ...(w.owners?.length ? ["github:", `  owners: [${w.owners.join(", ")}]`] : []), ""].join("\n");
}

/** A kind of workspace, for setup screens. */
export interface ProviderView {
  id: string;
  label: string;
  description: string;
  /** Where it installs one (under the home folder), when it can. */
  installsTo: string | null;
}

export const providerViews = (): ProviderView[] => PROVIDERS.map((p) => ({ id: p.id, label: p.label, description: p.description, installsTo: p.install ? `~/${p.install.defaultRoot}` : null }));
