import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config, WorkspaceConfig } from "./config";
import { body, HttpError, json, type Router } from "./http";

/**
 * Remote machines: another computer you reach with `ssh <host>` (a dev VM) that runs its own
 * jin daemon. Onboarding installs what jin needs there, ships this jin's daemon, starts it
 * as a user service, and keeps an SSH tunnel to it; the web app then talks to that daemon
 * the same way it talks to this one. Sign-ins (gh, Claude Code, Doppler) run on the machine
 * and hand you their links and codes; jin never copies a credential across.
 *
 * Each machine is a file in $JIN_HOME/machines (mode 0600, it holds the remote daemon's
 * token), which the web server reads to reach the machine through its tunnel.
 */
export interface MachineRecord {
  id: string;
  /** What you type after `ssh`: a host, user@host, or a Host from ~/.ssh/config. */
  host: string;
  label: string;
  /** The remote daemon's port, on the machine's loopback. */
  remotePort: number;
  /** This end of the tunnel, on this machine's loopback. */
  localPort: number | null;
  token: string | null;
  createdAt: string;
  /** The jin commit running there. */
  version: string | null;
  /** The workspace the remote daemon was given, if any. */
  workspace: string | null;
  system: string | null;
}

export type StepId = "connect" | "tools" | "jin" | "daemon" | "tunnel";
export interface Step {
  id: StepId | "workspace";
  label: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  log: string[];
  error: string | null;
}

export type AuthTool = "gh" | "claude" | "doppler";
export interface AuthState {
  tool: AuthTool;
  state: "unknown" | "signed-in" | "signed-out" | "missing" | "waiting" | "failed";
  /** Who is signed in, when the tool says. */
  account: string | null;
  /** While signing in: where to go, and the code to enter there (or that the page gives back). */
  url: string | null;
  code: string | null;
  /** Claude Code: the sign-in page shows a code you paste back here. */
  needsCode: boolean;
  error: string | null;
}

export interface MachineView extends Omit<MachineRecord, "token"> {
  connected: boolean;
  tunnel: "up" | "connecting" | "down" | "off";
  busy: boolean;
  /** The machine runs a different jin than this one: "Update jin there" brings it level. */
  outdated: boolean;
  steps: Step[];
  workspaceStep: Step | null;
  /** composio workspaces found on the machine (null: not looked yet). */
  workspaceCandidates: string[] | null;
  auth: AuthState[];
}

const STEPS: { id: StepId; label: string }[] = [
  { id: "connect", label: "Connect over SSH" },
  { id: "tools", label: "Install git, Bun, gh and Claude Code" },
  { id: "jin", label: "Copy jin's daemon" },
  { id: "daemon", label: "Start jin's daemon" },
  { id: "tunnel", label: "Open the tunnel" },
];
const LOG_LINES = 300;

let headCache: { at: number; sha: string | null } | null = null;
/** This jin's commit (short), as onboarding records it on a machine; cached for a few seconds. */
function localVersion(): string | null {
  if (headCache && Date.now() - headCache.at < 5000) return headCache.sha;
  const r = Bun.spawnSync(["git", "-C", resolve(import.meta.dir, "../../.."), "rev-parse", "--short", "HEAD"]);
  headCache = { at: Date.now(), sha: r.exitCode === 0 ? r.stdout.toString().trim() || null : null };
  return headCache.sha;
}
const REPO = resolve(import.meta.dir, "../../..");
// Non-interactive ssh sessions often lack XDG_RUNTIME_DIR, which systemctl --user needs.
export const PATH_LINE = 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"; [ -n "$XDG_RUNTIME_DIR" ] || [ ! -d "/run/user/$(id -u)" ] || export XDG_RUNTIME_DIR="/run/user/$(id -u)"';

/** The usual places a composio workspace lives, under a home folder (its installer defaults to ~/composio-workspace). */
export const WORKSPACE_PLACES = ["composio-workspace", "Workspace/composio-workspace", "workspace/composio-workspace", "code/composio-workspace", "src/composio-workspace", "dev/composio-workspace"];

/** Lists composio workspaces in the usual places (`WS <path>`), and the one jin there already uses (`USING <path>`). */
export const DETECT_SCRIPT = `
for d in ${WORKSPACE_PLACES.join(" ")}; do
  p="$HOME/$d"
  # One line per folder: two spellings of one folder (case-insensitive disks) share an inode.
  if [ -f "$p/workspace.yaml" ] && [ -e "$p/bin/cws" ]; then echo "$(ls -di "$p" | awk '{print $1}') WS $(cd "$p" && pwd -P)"; fi
done | awk '!seen[$1]++ { $1 = ""; sub(/^ /, ""); print }'
if [ -f ~/.jin/workspaces/composio.yaml ]; then echo "USING $(sed -n 's/^root: *//p' ~/.jin/workspaces/composio.yaml | head -1)"; fi
true
`;

/** What the detection script found. */
export function readDetected(out: string): { found: string[]; using: string | null } {
  const found: string[] = [];
  let using: string | null = null;
  for (const line of stripAnsi(out).split("\n").map((l) => l.trim())) {
    if (line.startsWith("WS ")) found.push(line.slice(3).trim());
    else if (line.startsWith("USING ")) using = line.slice(6).trim() || null;
  }
  return { found: [...new Set(found)], using };
}

export const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

/** A short id from what you typed: `me@dev-box.example.com` → `dev-box`. */
export function machineId(host: string, taken: Set<string> = new Set()): string {
  const base =
    host
      .replace(/^.*@/, "")
      .split(".")[0]!
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "machine";
  let id = base;
  for (let i = 2; taken.has(id) || id === "local"; i++) id = `${base}-${i}`;
  return id;
}

/** ssh's host argument: a host name, user@host, or an ssh_config alias; never an option. */
export function validHost(host: string): boolean {
  return /^(?:\w[\w.-]*@)?\w[\w.-]*$/.test(host);
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/**
 * What a sign-in printed so far: the link, the code, and whether it waits for something.
 * `answer` is what to type at a prompt it is showing (and the prompt, so it's answered once).
 */
export function readSignIn(tool: AuthTool, out: string): { url: string | null; code: string | null; needsCode: boolean; done: boolean; answer: { prompt: string; keys: string } | null; account: string | null } {
  const text = stripAnsi(out);
  if (tool === "gh") {
    const code = text.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1] ?? null;
    const answer = /Press Enter to open/.test(text) ? { prompt: "enter", keys: "\r" } : /Authenticate Git with your GitHub credentials\?/.test(text) ? { prompt: "git", keys: "Y\r" } : null;
    const account = text.match(/Logged in as (\S+)/)?.[1] ?? null;
    return { url: code ? "https://github.com/login/device" : null, code, needsCode: false, done: Boolean(account), answer, account };
  }
  if (tool === "claude") {
    const url = text.match(/https:\/\/\S*oauth\S*authorize\S+/)?.[0] ?? null;
    const done = /Login successful/i.test(text);
    return { url, code: null, needsCode: Boolean(url) && /Paste code/i.test(text) && !done, done, answer: null, account: null };
  }
  const url = text.match(/https:\/\/dashboard\.doppler\.com\S+/)?.[0] ?? null;
  const code = text.match(/Your auth code is:\s*([a-z0-9_-]+)/i)?.[1] ?? null;
  const answer = /Open the authorization page in your browser\?/.test(text) ? { prompt: "open", keys: "n\r" } : null;
  return { url, code, needsCode: false, done: /Welcome|logged in|Authenticated/i.test(text), answer, account: null };
}

/** `gh yes angrybayblade` / `claude no` / `doppler missing`, one per line, from the status probe. */
export function readAuthStatus(out: string): Partial<Record<AuthTool, { state: AuthState["state"]; account: string | null }>> {
  const res: Partial<Record<AuthTool, { state: AuthState["state"]; account: string | null }>> = {};
  for (const line of stripAnsi(out).split("\n")) {
    const m = line.trim().match(/^(gh|claude|doppler) (yes|no|missing)(?: (.+))?$/);
    if (m) res[m[1] as AuthTool] = { state: m[2] === "yes" ? "signed-in" : m[2] === "no" ? "signed-out" : "missing", account: m[3]?.trim() || null };
  }
  return res;
}

const TOOLS_SCRIPT = `
set -e
${PATH_LINE}
have() { command -v "$1" >/dev/null 2>&1; }
SUDO=""
if [ "$(id -u)" = 0 ]; then SUDO=" "; elif sudo -n true 2>/dev/null; then SUDO="sudo -n"; fi
pkg() {
  if [ -z "$SUDO" ]; then echo "cannot install $* without passwordless sudo; install it yourself"; return 1; fi
  if have apt-get; then $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  elif have dnf; then $SUDO dnf install -y -q "$@" >/dev/null
  else echo "no apt-get or dnf to install $*"; return 1; fi
}
missing=""
for t in git curl tar unzip; do have $t || missing="$missing $t"; done
if [ -n "$missing" ]; then
  echo "installing$missing"
  if have apt-get && [ -n "$SUDO" ]; then $SUDO apt-get update -qq >/dev/null || true; fi
  pkg $missing
fi
have bun || { echo "installing Bun"; curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1; }
have gh || { echo "installing gh"; pkg gh || echo "gh: not installed"; }
have claude || { echo "installing Claude Code"; curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 || echo "Claude Code: not installed"; }
have doppler || [ -z "$SUDO" ] || { echo "installing Doppler (optional)"; curl -Ls --tlsv1.2 --proto "=https" https://cli.doppler.com/install.sh | $SUDO sh >/dev/null 2>&1 || echo "doppler: not installed (only cws up needs it)"; }
echo "bun $(bun --version)"
have gh && echo "$(gh --version | head -1)"
have claude && echo "claude $(claude --version 2>/dev/null | head -1)"
have doppler && echo "doppler $(doppler --version)"
true
`;

/** The machine's daemon: jin's config pointed at this web app, a user service (systemd when there is one), and its token. */
export const daemonScript = (port: number, origin: string) => `
set -e
${PATH_LINE}
mkdir -p ~/.jin/workspaces && chmod 700 ~/.jin
CFG=~/.jin/config.yaml
[ -f $CFG ] || printf 'mode: vm\\n' > $CFG
# Keep the jin apps already allowed here, and add this one.
ORIGINS=$( { grep -E '^webOrigins?:' $CFG | grep -oE 'https?://[^] ,"]+' ; echo '${origin}'; } | awk '!seen[$0]++' | paste -sd, - | sed 's/,/, /g')
grep -v -E '^(webOrigins?|port):' $CFG > $CFG.tmp || true
printf 'webOrigins: [%s]\\nport: %s\\n' "$ORIGINS" '${port}' >> $CFG.tmp && mv $CFG.tmp $CFG
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"; MAIN="$HOME/.jin/app/apps/daemon/src/main.ts"
detach() { if command -v setsid >/dev/null; then nohup setsid "$@"; else nohup "$@"; fi; }
if systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p ~/.config/systemd/user
  cat > ~/.config/systemd/user/jin-daemon.service <<EOF
[Unit]
Description=jin daemon
[Service]
ExecStart=$BUN $MAIN
Environment=PATH=$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=2
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  pkill -f "$MAIN" 2>/dev/null || true # one started without systemd would hold the port
  systemctl --user enable jin-daemon >/dev/null 2>&1 || true
  systemctl --user restart jin-daemon
  echo "running as a systemd user service (jin-daemon)"
  if loginctl enable-linger "$(id -un)" 2>/dev/null || sudo -n loginctl enable-linger "$(id -un)" 2>/dev/null; then echo "keeps running after you log out"; else echo "note: it stops when you log out (could not enable linger)"; fi
else
  pkill -f "$MAIN" 2>/dev/null || true
  detach "$BUN" "$MAIN" > ~/.jin/daemon.log 2>&1 < /dev/null &
  echo "running in the background (no systemd user session)"
fi
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1 && break; sleep 0.5; done
if ! curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
  echo "the daemon did not answer; its last lines:"
  journalctl --user -u jin-daemon -n 20 --no-pager 2>/dev/null || tail -20 ~/.jin/daemon.log 2>/dev/null
  exit 1
fi
echo "daemon answering on 127.0.0.1:${port}"
echo "JIN-TOKEN $(cat ~/.jin/token)"
`;

const RESTART_SCRIPT = `
${PATH_LINE}
if systemctl --user show-environment >/dev/null 2>&1; then systemctl --user restart jin-daemon; else
  MAIN="$HOME/.jin/app/apps/daemon/src/main.ts"; pkill -f "$MAIN" 2>/dev/null || true; sleep 1
  BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
  if command -v setsid >/dev/null; then nohup setsid "$BUN" "$MAIN" > ~/.jin/daemon.log 2>&1 < /dev/null & else nohup "$BUN" "$MAIN" > ~/.jin/daemon.log 2>&1 < /dev/null & fi
fi
`;

export const AUTH_STATUS_SCRIPT = `
${PATH_LINE}
if command -v gh >/dev/null; then if gh auth status >/dev/null 2>&1; then echo "gh yes $(gh api user -q .login 2>/dev/null)"; else echo "gh no"; fi; else echo "gh missing"; fi
if command -v claude >/dev/null; then
  s=$(claude auth status 2>/dev/null || true)
  if echo "$s" | grep -q '"loggedIn": *true'; then echo "claude yes $(echo "$s" | sed -n 's/.*"email": *"\\([^"]*\\)".*/\\1/p' | head -1)"; else echo "claude no"; fi
else echo "claude missing"; fi
if command -v doppler >/dev/null; then if doppler me --json >/dev/null 2>&1; then echo "doppler yes $(doppler me --json 2>/dev/null | sed -n 's/.*"workplace":{[^}]*"name":"\\([^"]*\\)".*/\\1/p' | head -1)"; else echo "doppler no"; fi; else echo "doppler missing"; fi
`;

export const SIGN_IN: Record<AuthTool, string> = {
  gh: "gh auth login --hostname github.com --git-protocol https --web",
  claude: "claude auth login",
  doppler: "doppler login",
};

export type Proc = { stdin: { write(d: string | Uint8Array): unknown; end(): unknown; flush?(): unknown } | null; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void };
export type Spawn = (cmd: string[], opts?: { stdin?: "pipe" | "ignore" | Blob }) => Proc;
export const defaultSpawn: Spawn = (cmd, opts = {}) => Bun.spawn(cmd, { stdin: opts.stdin ?? "ignore", stdout: "pipe", stderr: "pipe" }) as unknown as Proc;

export async function lines(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void, onChunk?: (all: string) => void) {
  const decoder = new TextDecoder();
  let buf = "";
  let all = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk, { stream: true });
    all += text;
    onChunk?.(all);
    buf += text;
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const p of parts) {
      const l = stripAnsi(p).trimEnd();
      if (l) onLine(l);
    }
  }
  const rest = stripAnsi(buf).trimEnd();
  if (rest) onLine(rest);
}

interface Tunnel {
  proc: Proc | null;
  state: "up" | "connecting" | "down";
  stopped: boolean;
  backoff: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface SignIn {
  proc: Proc;
  out: string;
  answered: Set<string>;
  /** Cursor-position queries answered so far (prompt libraries ask, and wait for the reply). */
  cursorReplies: number;
  answerTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Drive a sign-in running in a terminal: answer its terminal queries and prompts, and report
 * its link, code and outcome through `update`. `onExit(ok)` runs once it ends.
 */
export function driveSignIn(proc: Proc, tool: AuthTool, update: (patch: Partial<AuthState>) => void, onExit: (ok: boolean) => void | Promise<void>): SignIn {
  const s: SignIn = { proc, out: "", answered: new Set(), cursorReplies: 0, answerTimer: null };
  const onChunk = (all: string) => {
    s.out = all;
    // Answer "where is the cursor?" (ESC[6n) as a terminal would, or the prompt waits forever.
    const asked = all.split("\x1b[6n").length - 1;
    for (; s.cursorReplies < asked; s.cursorReplies++) proc.stdin?.write("\x1b[24;80R");
    proc.stdin?.flush?.();
    const r = readSignIn(tool, all);
    // Answer a prompt once the tool has gone quiet: it may still be asking the terminal things.
    if (s.answerTimer) clearTimeout(s.answerTimer);
    if (r.answer && !s.answered.has(r.answer.prompt)) {
      const { prompt, keys } = r.answer;
      s.answerTimer = setTimeout(() => {
        if (s.answered.has(prompt)) return;
        s.answered.add(prompt);
        proc.stdin?.write(keys);
        proc.stdin?.flush?.();
      }, 400);
    }
    update({ url: r.url, code: r.code, needsCode: r.needsCode, ...(r.account ? { account: r.account } : {}) });
  };
  void Promise.all([lines(proc.stdout, () => {}, onChunk), lines(proc.stderr, () => {})]);
  void proc.exited.then(async (code) => {
    const r = readSignIn(tool, s.out);
    const ok = code === 0 || r.done;
    if (ok) update({ state: "signed-in", url: null, code: null, needsCode: false, error: null });
    else {
      const last = stripAnsi(s.out).split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" ");
      update({ state: "failed", url: null, code: null, needsCode: false, error: last || `exited with ${code}` });
    }
    await onExit(ok);
  });
  return s;
}

export class Machines {
  private dir: string;
  private steps = new Map<string, Step[]>();
  private workspaceSteps = new Map<string, Step>();
  private candidates = new Map<string, string[]>();
  private busy = new Set<string>();
  private tunnels = new Map<string, Tunnel>();
  private auth = new Map<string, Map<AuthTool, AuthState>>();
  private signIns = new Map<string, SignIn>();
  private health: ReturnType<typeof setInterval> | null = null;
  private relay: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: Config,
    private workspaces: WorkspaceConfig[],
    private spawn: Spawn = defaultSpawn,
  ) {
    this.dir = join(config.home, "machines");
  }

  // ---------------------------------------------------------------- records

  private file(id: string) {
    return join(this.dir, `${id}.json`);
  }

  records(): MachineRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as MachineRecord)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  record(id: string): MachineRecord {
    if (!/^[a-z0-9-]+$/.test(id) || !existsSync(this.file(id))) throw new HttpError(404, `unknown machine ${id}`);
    return JSON.parse(readFileSync(this.file(id), "utf8")) as MachineRecord;
  }

  private save(m: MachineRecord) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file(m.id), JSON.stringify(m, null, 2), { mode: 0o600 });
    chmodSync(this.file(m.id), 0o600);
  }

  private update(id: string, patch: Partial<MachineRecord>): MachineRecord {
    const next = { ...this.record(id), ...patch };
    this.save(next);
    return next;
  }

  view(id: string): MachineView {
    const { token, ...m } = this.record(id);
    const tunnel = this.tunnels.get(id);
    const steps = this.steps.get(id) ?? STEPS.map((s) => ({ ...s, state: token ? "done" : "pending", log: [], error: null }) as Step);
    return {
      ...m,
      connected: Boolean(token) && tunnel?.state === "up",
      tunnel: tunnel ? tunnel.state : "off",
      busy: this.busy.has(id),
      outdated: Boolean(token && m.version && localVersion() && m.version !== localVersion()),
      steps,
      workspaceStep: this.workspaceSteps.get(id) ?? null,
      workspaceCandidates: this.candidates.get(id) ?? null,
      auth: (["gh", "claude", "doppler"] as AuthTool[]).map((t) => this.authOf(id, t)),
    };
  }

  list(): MachineView[] {
    return this.records().map((m) => this.view(m.id));
  }

  // ---------------------------------------------------------------- ssh

  /** Run a script on the machine (bash, from stdin); each output line goes to `say`. */
  private async ssh(host: string, script: string, say: (l: string) => void, opts: { quiet?: RegExp } = {}): Promise<{ code: number; out: string }> {
    const proc = this.spawn(["ssh", ...SSH_OPTS, host, "bash -s"], { stdin: new Blob([script]) });
    let out = "";
    const keep = (l: string) => {
      out += `${l}\n`;
      if (!opts.quiet?.test(l)) say(l);
    };
    await Promise.all([lines(proc.stdout, keep), lines(proc.stderr, keep)]);
    return { code: await proc.exited, out };
  }

  // ---------------------------------------------------------------- onboarding

  /** Add a machine and start onboarding it. */
  add(host: string, label?: string, opts: { remotePort?: number } = {}): MachineView {
    host = host.trim().replace(/^ssh\s+/, "");
    if (!validHost(host)) throw new HttpError(400, "give the host as you'd type it after ssh: a host name, user@host, or a Host from ~/.ssh/config");
    const existing = this.records().find((m) => m.host === host);
    if (existing) {
      if (!this.busy.has(existing.id) && !existing.token) void this.setup(existing.id);
      return this.view(existing.id);
    }
    const id = machineId(host, new Set(this.records().map((m) => m.id)));
    this.save({ id, host, label: label?.trim() || id, remotePort: opts.remotePort ?? 7317, localPort: null, token: null, createdAt: new Date().toISOString(), version: null, workspace: null, system: null });
    void this.setup(id);
    return this.view(id);
  }

  /** Run (or rerun: it also updates jin there) every onboarding step, in order. */
  async setup(id: string): Promise<void> {
    if (this.busy.has(id)) throw new HttpError(409, "this machine is already being set up");
    this.busy.add(id);
    const steps: Step[] = STEPS.map((s) => ({ ...s, state: "pending", log: [], error: null }));
    this.steps.set(id, steps);
    try {
      for (const step of steps) {
        step.state = "running";
        const say = (l: string) => {
          step.log.push(l);
          if (step.log.length > LOG_LINES) step.log.splice(0, step.log.length - LOG_LINES);
        };
        try {
          await this.run(id, step.id as StepId, say);
          step.state = "done";
        } catch (err) {
          step.state = "failed";
          step.error = err instanceof Error ? err.message : String(err);
          for (const s of steps) if (s.state === "pending") s.state = "skipped";
          return;
        }
      }
      void this.checkAuth(id).catch(() => {});
      void this.detectWorkspaces(id).catch(() => {});
    } finally {
      this.busy.delete(id);
    }
  }

  private async run(id: string, step: StepId, say: (l: string) => void) {
    const m = this.record(id);
    if (step === "connect") {
      const { code, out } = await this.ssh(m.host, 'echo JIN-OK; uname -sm; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"); id -un', say, { quiet: /^JIN-OK$/ });
      if (code !== 0 || !out.includes("JIN-OK")) {
        throw new Error(`could not log in with \`ssh ${m.host}\`. jin uses your SSH keys and ~/.ssh/config without prompting: check that \`ssh ${m.host}\` works in a terminal with no password prompt.`);
      }
      const [, uname, os, user] = out.trim().split("\n");
      this.update(id, { system: [os, uname].filter(Boolean).join(" · ") + (user ? ` · ${user}` : "") });
      return;
    }
    if (step === "tools") {
      const { code } = await this.ssh(m.host, TOOLS_SCRIPT, say);
      if (code !== 0) throw new Error("installing the tools failed; see the log");
      return;
    }
    if (step === "jin") {
      // This checkout's committed daemon (with the root manifest for its dependencies); no web app.
      const git = (args: string[]) => Bun.spawnSync(["git", "-C", REPO, ...args]);
      const version = git(["rev-parse", "--short", "HEAD"]).stdout.toString().trim() || null;
      const files = ["package.json", "bun.lock", "tsconfig.base.json", "apps/daemon"].filter((f) => existsSync(join(REPO, f)));
      const archive = git(["archive", "--format=tar", "HEAD", "--", ...files]);
      if (archive.exitCode !== 0) throw new Error(`git archive failed: ${archive.stderr.toString().trim()}`);
      say(`copying jin ${version ?? ""} (${Math.round(archive.stdout.length / 1024)} KB)`);
      const proc = this.spawn(["ssh", ...SSH_OPTS, m.host, `set -e; ${PATH_LINE}; rm -rf ~/.jin/app.new; mkdir -p ~/.jin/app.new; tar -x -C ~/.jin/app.new; echo '${version ?? ""}' > ~/.jin/app.new/VERSION; cd ~/.jin/app.new && bun install --production 2>&1 | tail -2; rm -rf ~/.jin/app; mv ~/.jin/app.new ~/.jin/app`], { stdin: new Blob([new Uint8Array(archive.stdout)]) });
      await Promise.all([lines(proc.stdout, say), lines(proc.stderr, say)]);
      if ((await proc.exited) !== 0) throw new Error("copying jin failed; see the log");
      this.update(id, { version });
      return;
    }
    if (step === "daemon") {
      const { code, out } = await this.ssh(m.host, daemonScript(m.remotePort, this.config.webOrigin), say, { quiet: /^JIN-TOKEN / });
      const token = out.match(/^JIN-TOKEN (\S+)$/m)?.[1];
      if (code !== 0 || !token) throw new Error("jin's daemon did not start there; see the log");
      this.update(id, { token });
      return;
    }
    say("forwarding a local port to the machine's daemon");
    await this.openTunnel(id);
    for (let i = 0; i < 40; i++) {
      if (this.tunnels.get(id)?.state === "up") {
        say(`connected through 127.0.0.1:${this.record(id).localPort}`);
        return;
      }
      await Bun.sleep(250);
    }
    throw new Error("the tunnel did not come up");
  }

  // ---------------------------------------------------------------- tunnels

  private async freePort(prefer: number | null): Promise<number> {
    const tryPort = (p: number) => {
      try {
        const s = Bun.serve({ hostname: "127.0.0.1", port: p, fetch: () => new Response() });
        const port = s.port;
        s.stop(true);
        return port;
      } catch {
        return null;
      }
    };
    return (prefer && tryPort(prefer)) || tryPort(0)!;
  }

  /** Keep an SSH tunnel to the machine's daemon, reopening it when it drops. */
  async openTunnel(id: string) {
    const m = this.record(id);
    if (!m.token) return;
    const existing = this.tunnels.get(id);
    if (existing && !existing.stopped && existing.proc) return;
    const t: Tunnel = existing ?? { proc: null, state: "connecting", stopped: false, backoff: 1000, timer: null };
    t.stopped = false;
    this.tunnels.set(id, t);
    const port = await this.freePort(m.localPort);
    if (port !== m.localPort) this.update(id, { localPort: port });
    t.state = "connecting";
    const proc = this.spawn(["ssh", ...SSH_OPTS, "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${port}:127.0.0.1:${m.remotePort}`, m.host]);
    t.proc = proc;
    void this.probe(id);
    void proc.exited.then(() => {
      if (t.proc !== proc) return;
      t.proc = null;
      t.state = "down";
      if (t.stopped) return;
      t.timer = setTimeout(() => void this.openTunnel(id).catch(() => {}), t.backoff);
      t.backoff = Math.min(t.backoff * 2, 30_000);
    });
    this.health ??= setInterval(() => {
      for (const mid of this.tunnels.keys()) void this.probe(mid);
    }, 10_000);
  }

  private async probe(id: string) {
    const t = this.tunnels.get(id);
    if (!t?.proc) return;
    const m = this.record(id);
    for (let i = 0; i < (t.state === "connecting" ? 20 : 1); i++) {
      const ok = await fetch(`http://127.0.0.1:${m.localPort}/health`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) {
        t.state = "up";
        t.backoff = 1000;
        return;
      }
      if (t.state === "connecting") await Bun.sleep(300);
    }
    if (t.proc) t.state = t.state === "up" ? "down" : t.state;
  }

  closeTunnel(id: string) {
    const t = this.tunnels.get(id);
    if (!t) return;
    t.stopped = true;
    if (t.timer) clearTimeout(t.timer);
    t.proc?.kill();
    this.tunnels.delete(id);
  }

  /**
   * Collect each connected machine's notices (it has no desktop; it keeps them, after its own
   * on-screen and repeat checks) and hand them to `show`, every few seconds.
   */
  relayNotices(show: (m: MachineRecord, n: { key: string; title: string; subtitle?: string; body: string; path: string; chat?: string; terminal?: string }) => void) {
    const last = new Map<string, number>();
    const tick = async () => {
      for (const m of this.records()) {
        if (!m.token || this.tunnels.get(m.id)?.state !== "up") continue;
        try {
          const first = !last.has(m.id);
          const res = await fetch(`http://127.0.0.1:${m.localPort}/api/notifications/outbox?after=${last.get(m.id) ?? 0}`, { headers: { authorization: `Bearer ${m.token}` }, signal: AbortSignal.timeout(3000) });
          if (!res.ok) continue; // an older jin there has no outbox
          const { seq, notices } = (await res.json()) as { seq: number; notices: { seq: number; at?: number; key: string; title: string; subtitle?: string; body: string; path: string }[] };
          // A restarted machine starts counting again: start over with it.
          if (seq < (last.get(m.id) ?? 0)) {
            last.delete(m.id);
            continue;
          }
          // The first time round, only what is recent: not a backlog from before this jin started.
          for (const n of notices) if (!first || (n.at ?? 0) > Date.now() - 30_000) show(m, n);
          last.set(m.id, seq);
        } catch {
          // offline for now; the tunnel reconnects
        }
      }
    };
    this.relay ??= setInterval(() => void tick(), 3000);
  }

  /** Reopen tunnels to machines that finished onboarding (at start). */
  resume() {
    for (const m of this.records()) if (m.token) void this.openTunnel(m.id).catch(() => {});
  }

  stopAll() {
    if (this.health) clearInterval(this.health);
    if (this.relay) clearInterval(this.relay);
    for (const id of [...this.tunnels.keys()]) this.closeTunnel(id);
    for (const s of this.signIns.values()) s.proc.kill();
  }

  /** Forget a machine; with `stop`, also stop jin's daemon there (its files stay in ~/.jin on the machine). */
  async remove(id: string, opts: { stop?: boolean } = {}) {
    const m = this.record(id);
    this.closeTunnel(id);
    if (opts.stop && m.token) {
      await this.ssh(m.host, `${PATH_LINE}
if systemctl --user show-environment >/dev/null 2>&1; then systemctl --user disable --now jin-daemon >/dev/null 2>&1 || true; fi
pkill -f "$HOME/.jin/app/apps/daemon/src/main.ts" 2>/dev/null || true`, () => {}).catch(() => {});
    }
    for (const t of ["gh", "claude", "doppler"] as AuthTool[]) this.signIns.get(`${id}:${t}`)?.proc.kill();
    rmSync(this.file(id), { force: true });
    this.steps.delete(id);
    this.auth.delete(id);
  }

  // ---------------------------------------------------------------- sign-ins

  private authOf(id: string, tool: AuthTool): AuthState {
    return this.auth.get(id)?.get(tool) ?? { tool, state: "unknown", account: null, url: null, code: null, needsCode: false, error: null };
  }

  private setAuth(id: string, tool: AuthTool, patch: Partial<AuthState>) {
    const all = this.auth.get(id) ?? new Map<AuthTool, AuthState>();
    all.set(tool, { ...this.authOf(id, tool), ...patch });
    this.auth.set(id, all);
  }

  /** Ask the machine who is signed in to gh, Claude Code and Doppler. */
  async checkAuth(id: string) {
    const m = this.record(id);
    const { out } = await this.ssh(m.host, AUTH_STATUS_SCRIPT, () => {});
    const found = readAuthStatus(out);
    for (const [tool, s] of Object.entries(found) as [AuthTool, { state: AuthState["state"]; account: string | null }][]) {
      if (this.signIns.has(`${id}:${tool}`)) continue; // a sign-in in progress keeps its link and code
      this.setAuth(id, tool, { state: s.state, account: s.account, url: null, code: null, needsCode: false, error: null });
    }
  }

  /** Start a sign-in on the machine; its link and code show up in the machine's view. */
  signIn(id: string, tool: AuthTool) {
    const m = this.record(id);
    const key = `${id}:${tool}`;
    this.signIns.get(key)?.proc.kill();
    // A terminal on the far end (-tt) so the tools print their prompts; BROWSER=false: there is none there.
    const proc = this.spawn(["ssh", ...SSH_OPTS, "-tt", m.host, `${PATH_LINE}; BROWSER=false ${SIGN_IN[tool]}`], { stdin: "pipe" });
    this.setAuth(id, tool, { state: "waiting", url: null, code: null, needsCode: false, error: null });
    const s = driveSignIn(proc, tool, (patch) => this.setAuth(id, tool, patch), async (ok) => {
      if (this.signIns.get(key) !== s) return;
      this.signIns.delete(key);
      if (ok) await this.checkAuth(id).catch(() => {});
    });
    this.signIns.set(key, s);
  }

  /** Claude Code's sign-in page gives back a code: type it into the waiting sign-in. */
  submitCode(id: string, tool: AuthTool, code: string) {
    const s = this.signIns.get(`${id}:${tool}`);
    if (!s) throw new HttpError(409, `no ${tool} sign-in is waiting on this machine`);
    if (!/^[\w#.~+/=-]{8,400}$/.test(code.trim())) throw new HttpError(400, "that does not look like a sign-in code");
    s.proc.stdin?.write(`${code.trim()}\r`);
    s.proc.stdin?.flush?.();
    this.setAuth(id, tool, { needsCode: false });
  }

  cancelSignIn(id: string, tool: AuthTool) {
    const key = `${id}:${tool}`;
    const s = this.signIns.get(key);
    this.signIns.delete(key);
    s?.proc.kill();
    void this.checkAuth(id).catch(() => {});
  }

  /** Doppler without the browser: a service token, set on the machine (sent over ssh's stdin, never on a command line). */
  async dopplerToken(id: string, token: string) {
    if (!/^dp\.[a-z]+\.[\w-]{20,}$/i.test(token.trim())) throw new HttpError(400, "a Doppler token starts with dp. (for example dp.st.dev.…)");
    const m = this.record(id);
    const proc = this.spawn(["ssh", ...SSH_OPTS, m.host, `${PATH_LINE}; read -r t; doppler configure set token "$t" --scope / >/dev/null && echo ok`], { stdin: new Blob([`${token.trim()}\n`]) });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0 || !out.includes("ok")) throw new HttpError(502, "setting the Doppler token on the machine failed");
    await this.checkAuth(id);
  }

  // ---------------------------------------------------------------- workspace

  /**
   * Look for composio workspaces on the machine. One that jin there already uses is taken as
   * the machine's workspace (a machine set up before, or by hand); the rest are offered.
   */
  async detectWorkspaces(id: string): Promise<string[]> {
    const m = this.record(id);
    const { out } = await this.ssh(m.host, DETECT_SCRIPT, () => {});
    const { found, using } = readDetected(out);
    if (using && using !== m.workspace) this.update(id, { workspace: using });
    this.candidates.set(id, found.filter((p) => p !== using));
    return found;
  }

  /**
   * Give the machine's jin a workspace: install the composio workspace there (its own
   * install.sh, with the machine's gh), or use one already on the machine.
   */
  setupWorkspace(id: string, opts: { kind: "composio"; path?: string }) {
    const m = this.record(id);
    if (!m.token) throw new HttpError(409, "finish setting up the machine first");
    if (this.busy.has(id)) throw new HttpError(409, "this machine is busy");
    const path = opts.path?.trim();
    if (path && !/^[\w~./-]+$/.test(path)) throw new HttpError(400, "a workspace path is plain: letters, digits, ~ . / - _");
    const local = this.workspaces.find((w) => w.adapter === "composio");
    const owners = local?.github.owners.length ? local.github.owners : ["ComposioHQ"];
    const root = path ? (path.startsWith("~/") ? `$HOME/${path.slice(2)}` : path) : "$HOME/composio-workspace";
    const script = `
set -e
${PATH_LINE}
ROOT="${root}"
if [ -n "${path ?? ""}" ]; then
  [ -f "$ROOT/workspace.yaml" ] || { echo "no composio workspace at $ROOT (workspace.yaml is missing)"; exit 1; }
  echo "using the workspace at $ROOT"
elif [ -d "$ROOT/.git" ]; then
  echo "updating the workspace at $ROOT"
  cd "$ROOT" && git pull --ff-only -q || true
  ./setup.sh --yes
else
  gh auth status >/dev/null 2>&1 || { echo "sign in to gh on the machine first: the workspace's repos are private"; exit 1; }
  echo "installing the composio workspace into $ROOT"
  gh api repos/ComposioHQ/workspace/contents/install.sh -H 'Accept: application/vnd.github.raw' | bash -s -- --yes --dir "$ROOT"
fi
cat > ~/.jin/workspaces/composio.yaml <<EOF
id: composio
adapter: composio
root: $ROOT
github:
  owners: [${owners.join(", ")}]
EOF
echo "jin's daemon there now has the workspace; restarting it"
${RESTART_SCRIPT}
echo "JIN-ROOT $ROOT"
`;
    const step: Step = { id: "workspace", label: "Set up the workspace", state: "running", log: [], error: null };
    this.workspaceSteps.set(id, step);
    this.busy.add(id);
    void (async () => {
      try {
        const { code, out } = await this.ssh(m.host, script, (l) => {
          step.log.push(l);
          if (step.log.length > LOG_LINES) step.log.splice(0, step.log.length - LOG_LINES);
        }, { quiet: /^JIN-ROOT / });
        if (code !== 0) throw new Error("setting up the workspace failed; see the log");
        this.update(id, { workspace: out.match(/^JIN-ROOT (.+)$/m)?.[1]?.trim() ?? null });
        await this.detectWorkspaces(id).catch(() => {});
        step.state = "done";
      } catch (err) {
        step.state = "failed";
        step.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.busy.delete(id);
      }
    })();
  }
}

const TOOLS = new Set<AuthTool>(["gh", "claude", "doppler"]);
const tool = (t: string | undefined): AuthTool => {
  if (!t || !TOOLS.has(t as AuthTool)) throw new HttpError(400, "sign-ins are for gh, claude and doppler");
  return t as AuthTool;
};

export function machineRoutes(router: Router, machines: Machines) {
  router
    .on("GET", "/api/machines", () => json(machines.list()))
    .on("POST", "/api/machines", async (req) => {
      const { host, label, remotePort } = await body<{ host?: string; label?: string; remotePort?: number }>(req);
      if (!host) throw new HttpError(400, "host is required");
      if (remotePort !== undefined && !(Number.isInteger(remotePort) && remotePort > 1024 && remotePort < 65536)) throw new HttpError(400, "remotePort must be a port above 1024");
      return json(machines.add(host, label, { remotePort }), 201);
    })
    .on("GET", "/api/machines/:id", (_req, p) => json(machines.view(p.id!)))
    .on("DELETE", "/api/machines/:id", async (_req, p, url) => {
      await machines.remove(p.id!, { stop: url.searchParams.get("stop") !== "0" });
      return json({ removed: true });
    })
    .on("POST", "/api/machines/:id/setup", (_req, p) => {
      machines.record(p.id!);
      void machines.setup(p.id!).catch(() => {});
      return json(machines.view(p.id!), 202);
    })
    .on("POST", "/api/machines/:id/auth", async (_req, p) => {
      await machines.checkAuth(p.id!);
      return json(machines.view(p.id!));
    })
    .on("POST", "/api/machines/:id/auth/:tool", (_req, p) => {
      machines.signIn(p.id!, tool(p.tool));
      return json(machines.view(p.id!), 202);
    })
    .on("DELETE", "/api/machines/:id/auth/:tool", (_req, p) => {
      machines.cancelSignIn(p.id!, tool(p.tool));
      return json(machines.view(p.id!));
    })
    .on("POST", "/api/machines/:id/auth/:tool/code", async (req, p) => {
      const { code } = await body<{ code?: string }>(req);
      machines.submitCode(p.id!, tool(p.tool), code ?? "");
      return json(machines.view(p.id!));
    })
    .on("POST", "/api/machines/:id/doppler-token", async (req, p) => {
      const { token } = await body<{ token?: string }>(req);
      await machines.dopplerToken(p.id!, token ?? "");
      return json(machines.view(p.id!));
    })
    .on("POST", "/api/machines/:id/workspaces/detect", async (_req, p) => {
      await machines.detectWorkspaces(p.id!);
      return json(machines.view(p.id!));
    })
    .on("POST", "/api/machines/:id/workspace", async (req, p) => {
      const { path } = await body<{ path?: string }>(req);
      machines.setupWorkspace(p.id!, { kind: "composio", path });
      return json(machines.view(p.id!), 202);
    });
}
