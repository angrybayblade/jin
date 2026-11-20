import type { PolicyRules } from "./adapters";

export type Decision = "allow" | "deny" | "ask";
export interface Verdict {
  decision: Decision;
  reason: string;
}

/**
 * Jin's base policy, enforced on every agent tool call whatever the workspace.
 * deny: never runs (deploys, releases, publishing, production and secret changes).
 * ask: runs only after the user approves it in the command center (outward actions).
 * A workspace adds its own rules on top (its provider's policy()).
 */
const UNSAFE_SCRIPT = /(^|[:_\-.])(deploy|release|publish|prod|production|staging|ecr|changeset|promote)([:_\-.]|$)/i;

const DENY: { pattern: RegExp; why: string }[] = [
  { pattern: /^pulumi\s+(up|destroy|refresh|import|cancel|stack\s+rm)\b/, why: "changes real infrastructure" },
  { pattern: /^terraform\s+(apply|destroy|import)\b/, why: "changes real infrastructure" },
  { pattern: /^vercel\b.*(\s--prod\b|\sdeploy\b|\spromote\b|\srollback\b|\salias\b)/, why: "deploys to Vercel" },
  { pattern: /^vercel\s*$/, why: "deploys to Vercel" },
  { pattern: /^wrangler\s+(deploy|publish|secret|versions)\b/, why: "deploys to Cloudflare" },
  { pattern: /^(sls|serverless)\s+deploy\b/, why: "deploys a serverless stack" },
  { pattern: /^(kubectl)\s+(apply|delete|create|replace|patch|rollout|scale|set)\b/, why: "changes a Kubernetes cluster" },
  { pattern: /^helm\s+(install|upgrade|uninstall|rollback|delete)\b/, why: "changes a Kubernetes cluster" },
  { pattern: /^docker\s+(push|buildx\s+build\b.*--push)\b/, why: "pushes an image" },
  { pattern: /^gh\s+workflow\s+(run|enable|disable)\b/, why: "triggers or changes a GitHub workflow" },
  { pattern: /^gh\s+run\s+(rerun|cancel)\b/, why: "triggers a GitHub workflow" },
  { pattern: /^gh\s+release\s+(create|delete|edit|upload)\b/, why: "publishes a release" },
  { pattern: /^gh\s+secret\s+(set|delete)\b/, why: "changes repository secrets" },
  { pattern: /^doppler\s+(secrets\s+(set|delete|upload)|configs?\s+(create|delete|clone|lock|unlock)|environments?\s+(create|delete)|projects?\s+(create|delete))\b/, why: "changes Doppler" },
  { pattern: /^(npm|pnpm|yarn|bun)\s+publish\b/, why: "publishes a package" },
  { pattern: /^(npx\s+|pnpm\s+(exec\s+)?|bunx\s+)?changeset\s+publish\b/, why: "publishes packages" },
  { pattern: /^aws\s+.*\b(deploy|update-service|update-function-code|put-secret-value|delete-[a-z-]+)\b/, why: "changes AWS resources" },
];

const ASK: { pattern: RegExp; why: string }[] = [
  { pattern: /^git\s+push\b/, why: "pushes to a remote" },
  { pattern: /^gh\s+pr\s+(create|merge|comment|review|close|reopen|edit|ready)\b/, why: "acts on a pull request" },
  { pattern: /^gh\s+issue\s+(create|comment|close|reopen|edit|delete|transfer)\b/, why: "acts on an issue" },
  { pattern: /^gh\s+api\b.*(\s-X\s*|\s--method\s+)(POST|PUT|PATCH|DELETE)\b/i, why: "writes through the GitHub API" },
  { pattern: /^gh\s+repo\s+(create|delete|edit|rename|archive)\b/, why: "changes a repository" },
  { pattern: /^jin-task\s+spawn\b/, why: "starts a sub-task: a new branch, worktrees and a Claude Code session" },
];

// MCP tools that send or change something in Slack, Linear, Notion, Gmail and the like.
const OUTWARD_TOOL = /^mcp__.*(send|post|create|update|delete|remove|comment|reply|draft|save|share|archive|assign|move|merge|schedule|mark|label|trash|forward|invite|add_|resolve)/i;

const ENV_ASSIGNMENTS = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;
// Prefixes that run the rest of the line as a command: `sudo x`, `npx vercel`, `pnpm dlx x`.
const WRAPPER = /^(?:sudo(?:\s+-\S+)*|env(?:\s+-\S+)*|exec|time|nohup|command|xargs(?:\s+-\S+)*|npx(?:\s+-y|\s+--yes)?|bunx|pnpm\s+(?:dlx|exec)|yarn\s+dlx|npm\s+exec(?:\s+--)?)\s+/;
// `sh -c "..."`, `bash -lc '...'`, `eval "..."`: the quoted string is itself a command line.
const NESTED = /^(?:(?:ba|z|da)?sh\s+(?:-\w*c\w*)|eval)\s+(["'])([\s\S]*)\1\s*$/;

/** Splits a shell command line into simple commands, without env assignments, wrappers or `cd x`. */
export function simpleCommands(command: string, depth = 0): string[] {
  const out: string[] = [];
  for (const raw of command.split(/\n|&&|\|\||;|\||\$\(|`|\(|\)/)) {
    let c = raw.trim();
    for (let prev = ""; prev !== c; ) {
      prev = c;
      c = c.replace(ENV_ASSIGNMENTS, "").replace(WRAPPER, "").trim();
    }
    const nested = c.match(NESTED);
    if (nested && depth < 4) out.push(...simpleCommands(nested[2]!, depth + 1));
    else if (c && !/^cd(\s|$)/.test(c)) out.push(c);
  }
  return out;
}

/** curl or wget sending data (a body, a form, a file) to a host other than this machine: where it goes, else null. */
export function uploadTarget(cmd: string): string | null {
  const curl = /^curl\b/.test(cmd) && /(\s-d\b|\s-d\S|\s--data\S*|\s-F\b|\s--form\b|\s-T\b|\s--upload-file\b|\s-X\s*(POST|PUT|PATCH)\b|\s--request\s+(POST|PUT|PATCH)\b|\s--json\b)/i.test(cmd);
  const wget = /^wget\b/.test(cmd) && /\s--(post|body)-(data|file)\b|\s--method[= ](POST|PUT|PATCH)\b/i.test(cmd);
  if (!curl && !wget) return null;
  const url = /(https?:\/\/[^\s'"]+)/.exec(cmd)?.[1];
  // This machine, written without a scheme (curl localhost:7317/x): stays here.
  if (!url && /(^|[\s'"])(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|\s|$)/.test(cmd)) return null;
  let host: string;
  try {
    host = url ? new URL(url).hostname : (/\s([\w.-]+\.[a-z]{2,})(?:[:/]|\s|$)/i.exec(cmd)?.[1] ?? "");
  } catch {
    host = "";
  }
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return null;
  return host || "an address it names";
}

/** `pnpm run deploy:prod`, `npm run release`, `yarn deploy`, `bun run publish`, `make deploy`. */
function unsafeScript(cmd: string): boolean {
  const m = cmd.match(/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+|-w\s+run\s+|--filter\s+\S+\s+(?:run\s+)?)?([A-Za-z0-9:_.\-]+)/) ?? cmd.match(/^make\s+([A-Za-z0-9:_.\-]+)/);
  if (!m) return false;
  const name = m[1]!;
  if (["install", "add", "remove", "test", "exec", "dlx", "x", "create", "init", "why", "ls", "list", "outdated", "audit", "info", "view"].includes(name)) return false;
  return UNSAFE_SCRIPT.test(name);
}

// ---------------------------------------------------------------- jin's own secrets

/**
 * What an agent never reads or touches, whatever it was asked: jin's credentials (the daemon's
 * token, other machines' tokens, the Composio settings), its database, and SSH private keys.
 * With the token an agent could call jin's API and approve its own actions; content it reads
 * from outside (a Slack message, an email, a web page) could ask it to. Agents run as you, so
 * this is a guardrail for a model being misled, not a sandbox.
 */
let guarded: { home: string; paths: string[]; words: RegExp; wholeHome: RegExp } | null = null;

/** jin's home on this machine: what under it is off limits to agents. */
export function protectJinHome(home: string, userHome = process.env.HOME ?? "") {
  const h = home.replace(/\/+$/, "");
  const names = ["daemon.json", "token", "machines", "composio.json", "jin.db"];
  const paths = [...names.map((n) => `${h}/${n}`), ...(userHome ? [`${userHome.replace(/\/+$/, "")}/.ssh/id_`] : [])];
  // How a command line may name them: the path itself, ~/.jin/<name>, $JIN_HOME/<name>.
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = names.map(esc).join("|");
  const words = new RegExp(`(${paths.map(esc).join("|")}|(~|\\$HOME|\\$\\{HOME\\})/\\.jin/(${tail})|\\$\\{?JIN_HOME\\}?/(${tail})|\\.ssh/id_|/api/approvals)`);
  // jin's home as a whole (a search through all of it reads the secrets too): the folder itself,
  // not a folder in it that agents use (chats' notes, logs, workspace configs).
  const wholeHome = new RegExp(`(${esc(h)}|(~|\\$HOME|\\$\\{HOME\\})/\\.jin|\\$\\{?JIN_HOME\\}?)/?(?=$|[\\s'"*;|&)])`);
  guarded = { home: h, paths, words, wholeHome };
}

const PATH_FIELDS = ["file_path", "path", "notebook_path", "pattern"] as const;

/** Why an agent may not do this (it reaches jin's secrets or its approvals), else null. */
export function jinSecretsReason(tool: string, input: Record<string, unknown>): string | null {
  if (!guarded) return null;
  const { paths, words } = guarded;
  if (tool === "Bash" || tool === "bash" || tool === "shell") {
    const command = String(input.command ?? "");
    if (/\/api\/approvals/.test(command)) return "approvals are decided by the user in jin, never by an agent";
    return words.test(command) || guarded.wholeHome.test(command) ? "it reaches jin's credentials, database or SSH keys, which agents never touch" : null;
  }
  for (const f of PATH_FIELDS) {
    const v = input[f];
    if (typeof v !== "string") continue;
    if (v.replace(/\/+$/, "") === guarded.home || guarded.wholeHome.test(v)) return "it searches all of jin's home, credentials included, which agents never touch";
    if (paths.some((p) => v === p || v.startsWith(p.endsWith("id_") ? p : `${p}`)) || words.test(v)) return "it reaches jin's credentials, database or SSH keys, which agents never touch";
  }
  return null;
}

export function evaluate(tool: string, input: Record<string, unknown>, rules: PolicyRules = { deny: [], ask: [] }): Verdict {
  const secret = jinSecretsReason(tool, input);
  if (secret) return { decision: "deny", reason: `${tool}: ${secret}` };
  if (tool === "Bash" || tool === "bash" || tool === "shell") {
    const command = String(input.command ?? "");
    let ask: Verdict | undefined;
    for (const cmd of simpleCommands(command)) {
      for (const r of [...DENY, ...rules.deny]) if (r.pattern.test(cmd)) return { decision: "deny", reason: `\`${cmd}\` ${r.why}; jin never runs it` };
      if (unsafeScript(cmd)) return { decision: "deny", reason: `\`${cmd}\` looks like a deploy or release step; jin never runs it` };
      for (const r of [...ASK, ...rules.ask]) if (!ask && r.pattern.test(cmd)) ask = { decision: "ask", reason: `\`${cmd}\` ${r.why}` };
      const to = uploadTarget(cmd);
      if (!ask && to) ask = { decision: "ask", reason: `\`${cmd.slice(0, 120)}\` sends data to ${to}` };
    }
    return ask ?? { decision: "allow", reason: "no rule matched" };
  }
  // Jin's own tools act on this machine only: the feed, tasks, and starting agents whose
  // own tool calls are gated in turn.
  // Except removing a task: its worktrees and branches go, so you say yes first.
  if (tool === "mcp__jin__jin_remove_task") return { decision: "ask", reason: "removes the task's worktrees and local branches" };
  if (tool.startsWith("mcp__jin__")) return { decision: "allow", reason: "jin's own tool" };
  if (OUTWARD_TOOL.test(tool)) return { decision: "ask", reason: `${tool} sends or changes something outside this machine` };
  return { decision: "allow", reason: "no rule matched" };
}
