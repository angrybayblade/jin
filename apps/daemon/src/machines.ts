import { problems } from "./problems";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Detected, detectionScript, installPlan, provider, PROVIDERS, providerTools, type ProviderView, providerViews, readDetections, workspaceYaml } from "./adapters";
import { machineSetup, type MachineSetup } from "./config";
import type { Config, WorkspaceConfig } from "./config";
import { body, HttpError, json, type Router } from "./http";
import type { ForwardView } from "./forwards";

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
  /** This machine's jin uses it as its home (the always-on hub): chats, feed and approvals live there. */
  home?: boolean;
  /** On the hub's side of a home link: the port the hub reaches this jin back through. */
  reversePort?: number | null;
  /** On the hub: a machine that connected to us (a laptop behind NAT), reached over its reverse tunnel. */
  attached?: boolean;
}

export type StepId = "connect" | "tools" | "jin" | "daemon" | "tunnel";
export interface Step {
  id: StepId | "workspace";
  label: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  log: string[];
  error: string | null;
}

/** gh and Claude Code (jin's own), or a tool a workspace provider declares (cws: doppler). */
export type AuthTool = string;
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
  /** Workspaces found on the machine, of every kind jin knows (null: not looked yet); the ones their tooling points at first. */
  workspaceCandidates: Detected[] | null;
  /** The kinds of workspace jin can set up there. */
  providers: ProviderView[];
  auth: AuthState[];
  /** Its ports reached here (`localhost:<local>` → its `localhost:<remote>`). */
  forwards: ForwardView[];
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
/** This jin's version (`git describe`: v0.1.0 on a tag, v0.1.0-3-gabc1234 after it), as onboarding records it on a machine; cached for a few seconds. */
export function localVersion(): string | null {
  if (headCache && Date.now() - headCache.at < 5000) return headCache.sha;
  const root = resolve(import.meta.dir, "../../..");
  const r = Bun.spawnSync(["git", "-C", root, "describe", "--tags", "--always", "--abbrev=7", "HEAD"]);
  // A jin copied to a machine has no git: onboarding left its commit in VERSION.
  const fromFile = () => {
    try {
      return readFileSync(join(root, "VERSION"), "utf8").trim() || null;
    } catch {
      return null;
    }
  };
  headCache = { at: Date.now(), sha: r.exitCode === 0 ? r.stdout.toString().trim() || null : fromFile() };
  return headCache.sha;
}
const REPO = resolve(import.meta.dir, "../../..");
// Non-interactive ssh sessions often lack XDG_RUNTIME_DIR, which systemctl --user needs.
/** The real jin's place on a machine (a development copy sets its own in config.yaml). */
const DEFAULT_SETUP: MachineSetup = machineSetup(undefined);

export const PATH_LINE = 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"; [ -n "$XDG_RUNTIME_DIR" ] || [ ! -d "/run/user/$(id -u)" ] || export XDG_RUNTIME_DIR="/run/user/$(id -u)"';

/** A port on the home for this jin's line back: the same every time (two laptops get different ones); `n` moves past ones still held. */
export function reversePortFor(id: string, n = 0): number {
  return 20000 + ((Number.parseInt(Bun.hash(id).toString(16).slice(-4), 16) + n * 7919) % 20000);
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
  if (tool === "opencode") {
    // `opencode auth login openai --method chatgpt-headless`: a device link and code.
    const url = text.match(/https:\/\/auth\.openai\.com\/codex\/device\S*/)?.[0] ?? null;
    const code = text.match(/Enter code:\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})/)?.[1] ?? null;
    return { url, code, needsCode: false, done: /Login successful|logged in|Added credential/i.test(text), answer: null, account: null };
  }
  if (tool === "codex") {
    // `codex login --device-auth`: a link and a one-time code; it finishes once you approve.
    const url = text.match(/https:\/\/auth\.openai\.com\/codex\/device\S*/)?.[0] ?? null;
    const code = text.match(/one-time code[^\n]*\n\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})/)?.[1] ?? null;
    return { url, code, needsCode: false, done: /Successfully logged in/i.test(text), answer: null, account: null };
  }
  if (tool === "claude") {
    const url = text.match(/https:\/\/\S*oauth\S*authorize\S+/)?.[0] ?? null;
    const done = /Login successful/i.test(text);
    return { url, code: null, needsCode: Boolean(url) && /Paste code/i.test(text) && !done, done, answer: null, account: null };
  }
  // A workspace's tool: read as its provider says.
  const s = providerTools().find((t) => t.id === tool)?.signIn;
  const url = s?.url ? (text.match(s.url)?.[0] ?? null) : null;
  const code = s?.code ? (text.match(s.code)?.[1] ?? null) : null;
  const a = s?.answers?.find((x) => x.when.test(text));
  return { url, code, needsCode: false, done: Boolean(s?.done?.test(text)), answer: a ? { prompt: a.prompt, keys: a.keys } : null, account: null };
}

/** The tools a machine signs in to: jin's own, then the ones workspace providers declare. */
export const authTools = (): AuthTool[] => ["gh", "claude", "codex", "pi", "opencode", ...providerTools().map((t) => t.id)];

/**
 * How a tool shows in the sign-ins list. `providers`: it signs in to model providers (its
 * account is the providers it holds credentials for). `signInHint`: it signs in only in its
 * own terminal, so the list says how instead of offering a sign-in.
 */
export interface ToolView {
  label: string;
  why: string;
  optional: boolean;
  tokenHint: string | null;
  providers?: boolean;
  signInHint?: string | null;
}

export function describeTool(tool: AuthTool): ToolView {
  if (tool === "gh") return { label: "GitHub (gh)", why: "Clones the workspace's repos; PRs and checks.", optional: false, tokenHint: null };
  if (tool === "claude") return { label: "Claude Code", why: "Runs Claude Code and jin's chats there.", optional: false, tokenHint: null };
  if (tool === "codex") return { label: "Codex", why: "Runs Codex there, when it is the machine's coding agent.", optional: true, tokenHint: null };
  if (tool === "pi")
    return { label: "pi", why: "Runs pi there, when it is the machine's coding agent.", optional: true, tokenHint: null, providers: true, signInHint: "pi signs in in its own terminal: open a pi tab on this machine and run /login." };
  if (tool === "opencode") return { label: "opencode", why: "Runs opencode there, when it is the machine's coding agent. Signs in with ChatGPT.", optional: true, tokenHint: null, providers: true };
  const t = providerTools().find((x) => x.id === tool);
  return { label: t?.label ?? tool, why: t?.why ?? "", optional: t?.optional ?? true, tokenHint: t?.token?.hint ?? null };
}

export const signInCommand = (tool: AuthTool): string => (tool === "gh" ? "gh auth login --hostname github.com --git-protocol https --web" : tool === "claude" ? "claude auth login" : tool === "codex" ? "codex login --device-auth" : tool === "opencode" ? "opencode auth login openai --method chatgpt-headless --standalone" : (providerTools().find((t) => t.id === tool)?.signIn?.command ?? ""));

/** `gh yes angrybayblade` / `claude no` / `<tool> missing`, one per line, from the status probe. */
export function readAuthStatus(out: string): Partial<Record<AuthTool, { state: AuthState["state"]; account: string | null }>> {
  const res: Partial<Record<AuthTool, { state: AuthState["state"]; account: string | null }>> = {};
  for (const line of stripAnsi(out).split("\n")) {
    const m = line.trim().match(/^([\w-]+) (yes|no|missing)(?: (.+))?$/);
    if (m && authTools().includes(m[1]!)) res[m[1] as AuthTool] = { state: m[2] === "yes" ? "signed-in" : m[2] === "no" ? "signed-out" : "missing", account: m[3]?.trim() || null };
  }
  return res;
}

const TOOLS_SCRIPT = () => `
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
# Tools the workspaces jin knows need (their providers say how to install them).
${providerTools()
  .map((t) => t.install ?? "")
  .filter(Boolean)
  .join("\n")}
echo "bun $(bun --version)"
have gh && echo "$(gh --version | head -1)"
have claude && echo "claude $(claude --version 2>/dev/null | head -1)"
${providerTools()
  .map((t) => `have ${t.id} && echo "${t.id} $(${t.id} --version 2>/dev/null | head -1)"`)
  .join("\n")}
true
`;

/** The machine's daemon: jin's config pointed at this web app, a user service (systemd when there is one), and its token. */
export const daemonScript = (port: number, origin: string, setup: MachineSetup = DEFAULT_SETUP) => `
set -e
${PATH_LINE}
H="$HOME/${setup.home}"; export JIN_HOME="$H"
mkdir -p "$H/workspaces" && chmod 700 "$H"
CFG="$H/config.yaml"
[ -f $CFG ] || printf 'mode: vm\\n' > $CFG
# Keep the jin apps already allowed here, and add this one.
ORIGINS=$( { grep -E '^webOrigins?:' $CFG | grep -oE 'https?://[^] ,"]+' ; echo '${origin}'; } | awk '!seen[$0]++' | paste -sd, - | sed 's/,/, /g')
grep -v -E '^(webOrigins?|port):' $CFG > $CFG.tmp || true
printf 'webOrigins: [%s]\\nport: %s\\n' "$ORIGINS" '${port}' >> $CFG.tmp && mv $CFG.tmp $CFG
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"; MAIN="$H/app/apps/daemon/src/main.ts"
detach() { if command -v setsid >/dev/null; then nohup setsid "$@"; else nohup "$@"; fi; }
if systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p ~/.config/systemd/user
  cat > ~/.config/systemd/user/${setup.service}.service <<EOF
[Unit]
Description=jin daemon
[Service]
ExecStart=$BUN $MAIN
Environment=PATH=$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=JIN_HOME=$H
Restart=always
RestartSec=2
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  pkill -f "$MAIN" 2>/dev/null || true # one started without systemd would hold the port
  systemctl --user enable ${setup.service} >/dev/null 2>&1 || true
  systemctl --user restart ${setup.service}
  echo "running as a systemd user service (${setup.service})"
  if loginctl enable-linger "$(id -un)" 2>/dev/null || sudo -n loginctl enable-linger "$(id -un)" 2>/dev/null; then echo "keeps running after you log out"; else echo "note: it stops when you log out (could not enable linger)"; fi
else
  pkill -f "$MAIN" 2>/dev/null || true
  detach "$BUN" "$MAIN" > "$H/daemon.log" 2>&1 < /dev/null &
  echo "running in the background (no systemd user session)"
fi
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1 && break; sleep 0.5; done
if ! curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
  echo "the daemon did not answer; its last lines:"
  journalctl --user -u ${setup.service} -n 20 --no-pager 2>/dev/null || tail -20 "$H/daemon.log" 2>/dev/null
  exit 1
fi
echo "daemon answering on 127.0.0.1:${port}"
echo "JIN-TOKEN $(cat "$H/token")"
`;

/** Restart jin's daemon on the machine (after its workspaces changed). */
const restartScript = (setup: MachineSetup) => `
${PATH_LINE}
H="$HOME/${setup.home}"; export JIN_HOME="$H"
if systemctl --user show-environment >/dev/null 2>&1; then systemctl --user restart ${setup.service}; else
  MAIN="$H/app/apps/daemon/src/main.ts"; pkill -f "$MAIN" 2>/dev/null || true; sleep 1
  BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
  if command -v setsid >/dev/null; then nohup setsid "$BUN" "$MAIN" > "$H/daemon.log" 2>&1 < /dev/null & else nohup "$BUN" "$MAIN" > "$H/daemon.log" 2>&1 < /dev/null & fi
fi
`;

export const AUTH_STATUS_SCRIPT = () => `
${PATH_LINE}
# A tool that hangs (waiting for a terminal, a keychain, the network) must not hang the check:
# each question gets twenty seconds and no input (the script itself may be arriving on stdin).
lim() { "$@" </dev/null & p=$!; ( sleep 20; kill -9 $p 2>/dev/null ) >/dev/null 2>&1 & w=$!; wait $p 2>/dev/null; r=$?; kill $w 2>/dev/null; return $r; }
if command -v gh >/dev/null; then if lim gh auth status >/dev/null 2>&1; then echo "gh yes $(lim gh api user -q .login 2>/dev/null)"; else echo "gh no"; fi; else echo "gh missing"; fi
if command -v claude >/dev/null; then
  s=$(lim claude auth status 2>/dev/null || true)
  if echo "$s" | grep -q '"loggedIn": *true'; then echo "claude yes $(echo "$s" | sed -n 's/.*"email": *"\\([^"]*\\)".*/\\1/p' | head -1)"; else echo "claude no"; fi
else echo "claude missing"; fi
if command -v codex >/dev/null; then
  s=$(lim codex login status 2>&1 || true)
  if echo "$s" | grep -q '^Logged in'; then echo "codex yes $(echo "$s" | sed -n 's/^Logged in using //p' | head -1)"; else echo "codex no"; fi
else echo "codex missing"; fi
# pi and opencode sign in to model providers: the providers they keep a credential for.
providers() { lim bun -e 'try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(Object.keys(j).join(", ")) } catch {}' "$1" 2>/dev/null; }
if command -v pi >/dev/null; then p=$(providers "\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json"); if [ -n "$p" ]; then echo "pi yes $p"; else echo "pi no"; fi; else echo "pi missing"; fi
# opencode 2 lists its connected integrations as JSON (--standalone: no shared background server is started for it).
if command -v opencode >/dev/null; then o=$(lim opencode auth list --standalone --format json 2>/dev/null); p=$(printf '%s' "$o" | bun -e 'try { const j = JSON.parse(await Bun.stdin.text()); console.log(j.map((i) => i.id).join(", ")) } catch {}' 2>/dev/null); if [ -n "$p" ]; then echo "opencode yes $p"; else echo "opencode no"; fi; else echo "opencode missing"; fi
${providerTools()
  .map((t) => t.status)
  .join("\n")}
`;


export type Proc = { stdin: { write(d: string | Uint8Array): unknown; end(): unknown; flush?(): unknown } | null; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(signal?: number): void };
export type Spawn = (cmd: string[], opts?: { stdin?: "pipe" | "ignore" | Blob; cwd?: string }) => Proc;
export const defaultSpawn: Spawn = (cmd, opts = {}) => Bun.spawn(cmd, { stdin: opts.stdin ?? "ignore", stdout: "pipe", stderr: "pipe", cwd: opts.cwd }) as unknown as Proc;

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
  /** An attached machine has no ssh of ours: its own connection forwards the port. */
  attached?: boolean;
  proc: Proc | null;
  state: "up" | "connecting" | "down";
  stopped: boolean;
  backoff: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Health checks failed in a row while ssh still runs (a dead line ssh has not noticed yet). */
  misses?: number;
  /** To the home: the line back (-R), on an ssh connection of its own so the line there never waits on it. */
  rev?: { proc: Proc | null; backoff: number; timer: ReturnType<typeof setTimeout> | null; tries: number };
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
  private candidates = new Map<string, Detected[]>();
  private busy = new Set<string>();
  private tunnels = new Map<string, Tunnel>();
  private auth = new Map<string, Map<AuthTool, AuthState>>();
  private signIns = new Map<string, SignIn>();
  private health: ReturnType<typeof setInterval> | null = null;
  private relay: ReturnType<typeof setInterval> | null = null;
  /** This jin, as a hub sees it when this machine attaches to its home. */
  identity: { id: string; label: string; port: number; token: string } | null = null;
  /** The machines' port forwards (shown in each one's view, dropped with it). */
  forwards: { list(machine: string): ForwardView[]; forget(machine: string): void } | null = null;

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
      outdated: Boolean(token && m.version && localVersion() && m.version !== this.stampFor(localVersion())),
      steps,
      workspaceStep: this.workspaceSteps.get(id) ?? null,
      workspaceCandidates: this.candidates.get(id) ?? null,
      providers: providerViews(),
      auth: authTools().map((t) => ({ ...this.authOf(id, t), ...describeTool(t) })),
      forwards: this.forwards?.list(id) ?? [],
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
    this.save({ id, host, label: label?.trim() || id, remotePort: opts.remotePort ?? this.config.machines.port, localPort: null, token: null, createdAt: new Date().toISOString(), version: null, workspace: null, system: null });
    void this.setup(id);
    return this.view(id);
  }

  /** Run (or rerun: it also updates jin there) every onboarding step, in order. */
  async setup(id: string): Promise<void> {
    if (this.busy.has(id)) throw new HttpError(409, "this machine is already being set up");
    if (this.record(id).attached) throw new HttpError(400, "this machine connects to this jin by itself; set it up from that machine");
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
      void this.checkAuth(id).catch(problems.catch(`checking sign-ins on ${id}`));
      void this.detectWorkspaces(id).catch(problems.catch(`finding workspaces on ${id}`));
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
      const { code } = await this.ssh(m.host, TOOLS_SCRIPT(), say);
      if (code !== 0) throw new Error("installing the tools failed; see the log");
      return;
    }
    if (step === "jin") {
      // This checkout's committed daemon (with the root manifest for its dependencies); no web app.
      const version = localVersion();
      const files = ["package.json", "bun.lock", "tsconfig.base.json", "apps/daemon"].filter((f) => existsSync(join(REPO, f)));
      // A checkout sends its committed daemon (git archive); a jin that was itself copied to a
      // machine (the hub) has no git and sends its own files.
      const hasGit = existsSync(join(REPO, ".git"));
      // A development copy (machines.source: worktree) sends its files as they are, uncommitted changes included.
      const worktree = this.config.machines.source === "worktree";
      const archive =
        hasGit && !worktree
          ? Bun.spawnSync(["git", "-C", REPO, "archive", "--format=tar", "HEAD", "--", ...files])
          : Bun.spawnSync(["tar", "-c", "--exclude=node_modules", "--exclude=.DS_Store", "-C", REPO, ...files], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
      if (archive.exitCode !== 0) throw new Error(`packing jin failed: ${archive.stderr.toString().trim()}`);
      // A working tree's copy says so in its version, so a machine never passes it off as a commit.
      const stamp = this.stampFor(version) ?? "";
      say(`copying jin ${stamp} (${Math.round(archive.stdout.length / 1024)} KB)${worktree ? " from the working tree" : ""}`);
      const proc = this.spawn(["ssh", ...SSH_OPTS, m.host, `set -e; ${PATH_LINE}; H="$HOME/${this.config.machines.home}"; mkdir -p "$H"; rm -rf "$H/app.new"; mkdir -p "$H/app.new"; tar -x -C "$H/app.new" 2>/dev/null; echo '${stamp}' > "$H/app.new/VERSION"; cd "$H/app.new" && bun install --production 2>&1 | tail -2; rm -rf "$H/app"; mv "$H/app.new" "$H/app"`], { stdin: new Blob([new Uint8Array(archive.stdout)]) });
      await Promise.all([lines(proc.stdout, say), lines(proc.stderr, say)]);
      if ((await proc.exited) !== 0) throw new Error("copying jin failed; see the log");
      this.update(id, { version: stamp });
      return;
    }
    if (step === "daemon") {
      const { code, out } = await this.ssh(m.host, daemonScript(m.remotePort, this.config.webOrigin, this.config.machines), say, { quiet: /^JIN-TOKEN / });
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
    if (m.attached) {
      // It forwarded its daemon to our loopback itself; we only watch that it answers.
      this.tunnels.set(id, this.tunnels.get(id) ?? { attached: true, proc: null, state: "connecting", stopped: false, backoff: 1000, timer: null });
      void this.probe(id);
      this.health ??= setInterval(() => {
        for (const mid of this.tunnels.keys()) void this.probe(mid);
      }, 10_000);
      return;
    }
    const existing = this.tunnels.get(id);
    if (existing && !existing.stopped && existing.proc) return;
    const t: Tunnel = existing ?? { proc: null, state: "connecting", stopped: false, backoff: 1000, timer: null };
    t.stopped = false;
    this.tunnels.set(id, t);
    const port = await this.freePort(m.localPort);
    // Closed (the machine removed) while a port was found: opening now would bring it back.
    if (t.stopped || this.tunnels.get(id) !== t) return;
    if (port !== m.localPort) this.update(id, { localPort: port });
    t.state = "connecting";
    const proc = this.spawn(["ssh", ...SSH_OPTS, "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${port}:127.0.0.1:${m.remotePort}`, m.host]);
    // To the home (hub), a second connection lets the hub reach this jin back (-R): a laptop
    // behind NAT cannot be dialled, so it keeps the line open itself.
    if (m.reversePort && this.identity) this.openReverse(id, t);
    t.proc = proc;
    void this.probe(id);
    void proc.exited.then((code) => {
      if (t.proc !== proc) return;
      t.proc = null;
      t.state = "down";
      if (t.stopped) return;
      console.error(`tunnel to ${m.label}: ssh exited (${code}); reopening in ${t.backoff / 1000}s`);
      t.timer = setTimeout(() => void this.openTunnel(id).catch(problems.catch(`tunnel to ${m.label}`)), t.backoff);
      t.backoff = Math.min(t.backoff * 2, 30_000);
    });
    // Health checks every 5s: a dead line is found (and reconnected) within about 10s.
    this.health ??= setInterval(() => {
      for (const mid of this.tunnels.keys()) void this.probe(mid);
    }, 5_000);
  }

  /**
   * The line back from the home. Its own ssh: when the home still holds the port from a line
   * that died (after sleep or a network change, some ssh servers keep a dead client's forward
   * for a long time), only this fails, and it moves to another port and tells the home.
   */
  private openReverse(id: string, t: Tunnel) {
    const m = this.record(id);
    if (!m.reversePort || !this.identity || t.stopped) return;
    const rev = (t.rev ??= { proc: null, backoff: 1000, timer: null, tries: 0 });
    if (rev.proc) return;
    const port = m.reversePort;
    const proc = this.spawn(["ssh", ...SSH_OPTS, "-N", "-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${port}:127.0.0.1:${this.identity.port}`, m.host]);
    rev.proc = proc;
    const err = new Response(proc.stderr).text().catch(() => "");
    // Up for a few seconds: the forward took. Tell the home where to reach this jin.
    const settled = setTimeout(() => {
      if (rev.proc !== proc) return;
      rev.backoff = 1000;
      rev.tries = 0;
      void this.attachToHome(id).catch((e) => console.error(`attaching to ${m.label}: ${e}`));
    }, 3000);
    void proc.exited.then(async (code) => {
      clearTimeout(settled);
      if (rev.proc !== proc) return;
      rev.proc = null;
      if (t.stopped || this.tunnels.get(id) !== t) return;
      const why = (await err).trim();
      if (/remote port forwarding failed/i.test(why)) {
        // The home still holds this port: take the next one (and tell the home once it is up).
        rev.tries += 1;
        const next = reversePortFor(this.identity?.id ?? "jin", rev.tries);
        console.error(`line back from ${m.label}: port ${port} is still held there; moving to ${next}`);
        this.update(id, { reversePort: next });
        rev.timer = setTimeout(() => this.openReverse(id, t), 500);
        return;
      }
      console.error(`line back from ${m.label}: ssh exited (${code}); reopening in ${rev.backoff / 1000}s`);
      rev.timer = setTimeout(() => this.openReverse(id, t), rev.backoff);
      rev.backoff = Math.min(rev.backoff * 2, 30_000);
    });
  }

  private async probe(id: string) {
    const t = this.tunnels.get(id);
    if (!t || (!t.proc && !t.attached)) return;
    // Forgotten behind the tunnel's back (its record gone): drop the line, never throw from a timer.
    if (!existsSync(this.file(id))) return this.closeTunnel(id);
    const m = this.record(id);
    const wasUp = t.state === "up";
    for (let i = 0; i < (t.state === "connecting" ? 20 : 1); i++) {
      const ok = await fetch(`http://127.0.0.1:${m.localPort}/health`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) {
        if (!wasUp && t.misses) console.error(`tunnel to ${m.label}: up again`);
        t.state = "up";
        t.backoff = 1000;
        t.misses = 0;
        // Each time the line to the home comes up, tell the hub how to reach this jin (once the line back is up too).
        if (m.home && !wasUp && t.rev?.proc) void this.attachToHome(id).catch((err) => console.error(`attaching to ${m.label}: ${err}`));
        // And learn which jin it runs now (it may have been deployed to since).
        if (!wasUp && !m.attached) void this.refreshVersion(id);
        return;
      }
      if (t.state === "connecting") await Bun.sleep(300);
    }
    if (t.proc || t.attached) t.state = t.state === "up" || t.attached ? "down" : t.state;
    // ssh still runs but nothing answers through it: after sleep or a network change it can take
    // ssh a minute to notice the line is dead. Two misses in a row: end it and reconnect now.
    t.misses = (t.misses ?? 0) + 1;
    if (t.proc && !t.stopped && t.misses >= 2 && t.state !== "connecting") {
      console.error(`tunnel to ${m.label}: not answering through ssh; reconnecting`);
      t.misses = 0;
      t.backoff = 1000;
      t.proc.kill(9); // a hung ssh may not take a polite signal
    }
  }

  // ---------------------------------------------------------------- home (hub)

  /**
   * Make a machine this jin's home (the always-on hub), or stop. Its tunnel reopens with the
   * reverse line, and this returns only once it is up and this jin is attached there, so the
   * app does not switch to a home it cannot reach yet.
   */
  async setHome(id: string, home: boolean) {
    const m = this.record(id);
    if (m.attached) throw new HttpError(400, "an attached machine cannot be a home");
    if (home) {
      if (!m.token || this.tunnels.get(id)?.state !== "up") throw new HttpError(409, `${m.label} is not connected`);
      // A home must accept this jin attaching itself: an older jin there cannot.
      const theirs = await fetch(`http://127.0.0.1:${m.localPort}/api/machines/attach`, { method: "POST", headers: { authorization: `Bearer ${m.token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) })
        .then((r) => r.status)
        .catch(() => 0);
      if (theirs === 404 || theirs === 0) throw new HttpError(409, `${m.label} runs a jin too old to be a home (${m.version ?? "unknown"}); update jin there first`);
    }
    // Only one home: the old one loses its reverse line.
    for (const other of this.records()) {
      if (other.id === id || !other.home) continue;
      this.update(other.id, { home: false, reversePort: null });
      this.closeTunnel(other.id);
      void this.openTunnel(other.id);
    }
    // A port on the hub for this jin, the same every time (two laptops get different ones).
    const reversePort = home ? reversePortFor(this.identity?.id ?? "jin") : null;
    this.update(id, { home: false, reversePort });
    this.closeTunnel(id);
    await this.openTunnel(id);
    if (!home) return;
    for (let i = 0; i < 60 && this.tunnels.get(id)?.state !== "up"; i++) await Bun.sleep(250);
    if (this.tunnels.get(id)?.state !== "up") throw new HttpError(504, `the line to ${m.label} did not come back up; try again`);
    try {
      await this.attachToHome(id, true);
    } catch (err) {
      throw new HttpError(502, `${m.label} did not take this jin's attach: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Only now is it the home (the app switches to it).
    this.update(id, { home: true });
  }

  /**
   * Move to the home: this jin's chats and feed are copied there, and the home is asked to
   * reach this jin's other machines itself (with its own key, which must be on them first).
   */
  async moveToHome(id: string, history: unknown): Promise<{ history: unknown; machines: { id: string; ok: boolean; error?: string }[] }> {
    const m = this.record(id);
    if (!m.home) throw new HttpError(400, `${m.label} is not this jin's home`);
    const moved = await this.call(id, "POST", "/api/history/import", history);
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const other of this.records()) {
      if (other.id === id || other.attached || !other.token) continue;
      try {
        await this.call(id, "POST", "/api/machines", { host: other.host, label: other.label, remotePort: other.remotePort });
        results.push({ id: other.id, ok: true });
      } catch (err) {
        results.push({ id: other.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { history: moved, machines: results };
  }

  /** Tell the home how to reach this jin back over the reverse line (the hub records it as an attached machine). */
  async attachToHome(id: string, force = false) {
    const m = this.record(id);
    if (!this.identity || !m.reversePort || (!m.home && !force)) return;
    await this.call(id, "POST", "/api/machines/attach", { id: this.identity.id, label: this.identity.label, port: m.reversePort, token: this.identity.token, version: localVersion() });
  }

  /** On the hub: a machine attached itself (its reverse line forwards `port` here). */
  attach(a: { id: string; label: string; port: number; token: string; version?: string | null }): MachineView {
    if (!/^[a-z0-9-]+$/.test(a.id)) throw new HttpError(400, "machine id must be lowercase letters, digits and dashes");
    if (!(Number.isInteger(a.port) && a.port > 1024 && a.port < 65536)) throw new HttpError(400, "port must be above 1024");
    if (!a.token) throw new HttpError(400, "token is required");
    const existing = existsSync(this.file(a.id)) ? this.record(a.id) : null;
    if (existing && !existing.attached) throw new HttpError(409, `${a.id} is already a machine this jin reaches over ssh`);
    // The same machine attached before under another name (its hostname changed): same line back, so drop the old record.
    for (const other of this.records()) if (other.id !== a.id && other.attached && other.remotePort === a.port) void this.remove(other.id, { stop: false });
    this.save({
      id: a.id,
      host: a.label,
      label: a.label,
      remotePort: a.port,
      localPort: a.port,
      token: a.token,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      version: a.version ?? null,
      workspace: existing?.workspace ?? null,
      system: existing?.system ?? null,
      attached: true,
    });
    this.closeTunnel(a.id);
    void this.openTunnel(a.id);
    return this.view(a.id);
  }

  /**
   * An SSH key for this jin to reach other machines with (on the hub: add its public half to
   * your exe.dev account once). Made here if there is none; the private half never leaves.
   */
  async sshKey(): Promise<{ publicKey: string; created: boolean }> {
    const dir = join(process.env.HOME ?? "", ".ssh");
    for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
      if (existsSync(join(dir, `${name}.pub`))) return { publicKey: readFileSync(join(dir, `${name}.pub`), "utf8").trim(), created: false };
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const label = `jin@${(await Bun.$`hostname`.text()).trim()}`;
    const p = Bun.spawnSync(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", label, "-f", join(dir, "id_ed25519")], { stdout: "ignore", stderr: "pipe" });
    if (p.exitCode !== 0) throw new HttpError(500, `ssh-keygen failed: ${p.stderr.toString().trim()}`);
    return { publicKey: readFileSync(join(dir, "id_ed25519.pub"), "utf8").trim(), created: true };
  }

  private async refreshVersion(id: string) {
    const m = this.record(id);
    const v = await fetch(`http://127.0.0.1:${m.localPort}/api/status`, { headers: { authorization: `Bearer ${m.token}` }, signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? (r.json() as Promise<{ version?: string | null }>) : null))
      .catch(() => null);
    if (v?.version && v.version !== m.version) this.update(id, { version: v.version });
  }

  closeTunnel(id: string) {
    const t = this.tunnels.get(id);
    if (!t) return;
    t.stopped = true;
    if (t.timer) clearTimeout(t.timer);
    t.proc?.kill();
    if (t.rev?.timer) clearTimeout(t.rev.timer);
    t.rev?.proc?.kill();
    this.tunnels.delete(id);
  }

  /**
   * Collect each connected machine's notices (it has no desktop; it keeps them, after its own
   * on-screen and repeat checks) and hand them to `show`, every few seconds.
   */
  relayNotices(show: (m: MachineRecord, n: { key: string; title: string; subtitle?: string; body: string; path: string; chat?: string; terminal?: string; url?: string }) => void) {
    const last = new Map<string, number>();
    const tick = async () => {
      for (const m of this.records()) {
        if (!m.token || this.tunnels.get(m.id)?.state !== "up") continue;
        try {
          const first = !last.has(m.id);
          const res = await fetch(`http://127.0.0.1:${m.localPort}/api/notifications/outbox?after=${last.get(m.id) ?? 0}`, { headers: { authorization: `Bearer ${m.token}` }, signal: AbortSignal.timeout(3000) });
          if (!res.ok) continue; // an older jin there has no outbox
          const { seq, notices } = (await res.json()) as { seq: number; notices: { seq: number; at?: number; key: string; title: string; subtitle?: string; body: string; path: string; chat?: string; terminal?: string; url?: string }[] };
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

  /** Call a connected machine's daemon through its tunnel (jin's chat acts on other machines this way). */
  async call<T>(id: string, method: string, path: string, payload?: unknown): Promise<T> {
    const m = this.record(id);
    if (!m.token || !m.localPort || this.tunnels.get(id)?.state !== "up") throw new HttpError(409, `${m.label} is not connected`);
    const res = await fetch(`http://127.0.0.1:${m.localPort}${path}`, {
      method,
      headers: { authorization: `Bearer ${m.token}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, `${m.label}: ${(JSON.parse(text || "{}") as { error?: string }).error ?? `answered ${res.status}`}`);
    return JSON.parse(text) as T;
  }

  /** Reopen tunnels to machines that finished onboarding (at start). */
  resume() {
    // A reverse line belongs only to the home (a switch that did not finish leaves none).
    for (const m of this.records()) if (!m.home && m.reversePort) this.update(m.id, { reversePort: null });
    for (const m of this.records()) if (m.token) void this.openTunnel(m.id).catch(problems.catch(`tunnel to ${m.label}`));
  }

  stopAll() {
    if (this.health) clearInterval(this.health);
    if (this.relay) clearInterval(this.relay);
    for (const id of [...this.tunnels.keys()]) this.closeTunnel(id);
    for (const s of this.signIns.values()) s.proc.kill();
  }

  /** The version a machine set up from here reports: this jin's, marked when it came from the working tree. */
  private stampFor(version: string | null): string | null {
    return version && this.config.machines.source === "worktree" ? `${version}-worktree` : version;
  }

  /** Forget a machine; with `stop`, also stop jin's daemon there (its files stay in ~/.jin on the machine). */
  async remove(id: string, opts: { stop?: boolean } = {}) {
    const m = this.record(id);
    this.closeTunnel(id);
    // An attached machine reached this jin itself (no ssh from here): forgetting it never stops it.
    if (opts.stop && m.token && !m.attached) {
      await this.ssh(m.host, `${PATH_LINE}
if systemctl --user show-environment >/dev/null 2>&1; then systemctl --user disable --now ${this.config.machines.service} >/dev/null 2>&1 || true; fi
pkill -f "$HOME/${this.config.machines.home}/app/apps/daemon/src/main.ts" 2>/dev/null || true`, () => {}).catch(() => {});
    }
    for (const t of authTools()) this.signIns.get(`${id}:${t}`)?.proc.kill();
    rmSync(this.file(id), { force: true });
    this.forwards?.forget(id);
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
    const { out } = await this.ssh(m.host, AUTH_STATUS_SCRIPT(), () => {});
    const found = readAuthStatus(out);
    for (const [tool, s] of Object.entries(found) as [AuthTool, { state: AuthState["state"]; account: string | null }][]) {
      if (this.signIns.has(`${id}:${tool}`)) continue; // a sign-in in progress keeps its link and code
      this.setAuth(id, tool, { state: s.state, account: s.account, url: null, code: null, needsCode: false, error: null });
    }
  }

  /** Start a sign-in on the machine; its link and code show up in the machine's view. */
  signIn(id: string, tool: AuthTool) {
    const hint = describeTool(tool).signInHint;
    if (hint) throw new HttpError(400, hint);
    const m = this.record(id);
    const key = `${id}:${tool}`;
    this.signIns.get(key)?.proc.kill();
    // A terminal on the far end (-tt) so the tools print their prompts; BROWSER=false: there is none there.
    const proc = this.spawn(["ssh", ...SSH_OPTS, "-tt", m.host, `${PATH_LINE}; BROWSER=false ${signInCommand(tool)}`], { stdin: "pipe" });
    this.setAuth(id, tool, { state: "waiting", url: null, code: null, needsCode: false, error: null });
    const s = driveSignIn(proc, tool, (patch) => this.setAuth(id, tool, patch), async (ok) => {
      if (this.signIns.get(key) !== s) return;
      this.signIns.delete(key);
      if (ok) await this.checkAuth(id).catch(problems.catch(`checking sign-ins on ${id}`));
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
    void this.checkAuth(id).catch(problems.catch(`checking sign-ins on ${id}`));
  }

  /** A tool without the browser: a token, set on the machine (sent over ssh's stdin, never on a command line). */
  async setToken(id: string, tool: AuthTool, token: string) {
    const spec = providerTools().find((t) => t.id === tool)?.token;
    if (!spec) throw new HttpError(400, `${tool} takes no token`);
    if (!spec.pattern.test(token.trim())) throw new HttpError(400, `that does not look like a ${describeTool(tool).label} token (${spec.hint})`);
    const m = this.record(id);
    const proc = this.spawn(["ssh", ...SSH_OPTS, m.host, `${PATH_LINE}; read -r t; ${spec.set} && echo ok`], { stdin: new Blob([`${token.trim()}\n`]) });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0 || !out.includes("ok")) throw new HttpError(502, `setting the ${describeTool(tool).label} token on the machine failed`);
    await this.checkAuth(id);
  }

  // ---------------------------------------------------------------- workspace

  /**
   * Look for workspaces of every kind jin knows on the machine. One that jin there already uses
   * is taken as the machine's workspace (a machine set up before, or by hand); the rest are offered.
   */
  async detectWorkspaces(id: string): Promise<Detected[]> {
    const m = this.record(id);
    const { out } = await this.ssh(m.host, `${PATH_LINE}\n${detectionScript()}`, () => {});
    const { found, using } = readDetections(out);
    const current = using[0] ?? null;
    if (current !== m.workspace) this.update(id, { workspace: current });
    this.candidates.set(id, found.filter((d) => !using.includes(d.root)));
    return found;
  }

  /**
   * Give the machine's jin a workspace: one already on the machine (at `path`), or a new one
   * installed with the provider's own installer (with the machine's gh and tools).
   */
  setupWorkspace(id: string, opts: { provider: string; path?: string; source?: string }) {
    const m = this.record(id);
    if (!m.token) throw new HttpError(409, "finish setting up the machine first");
    if (this.busy.has(id)) throw new HttpError(409, "this machine is busy");
    const p = provider(opts.provider);
    const path = opts.path?.trim();
    if (path && !/^[\w~./-]+$/.test(path)) throw new HttpError(400, "a workspace path is plain: letters, digits, ~ . / - _");
    if (!path && !p.install) throw new HttpError(400, `jin cannot install a ${p.label}; give the path of one on the machine`);
    // The same GitHub owners as this machine's workspace of that kind, when it has one; else the machine's jin reads them.
    const owners = this.workspaces.find((w) => w.adapter === p.id)?.github.owners ?? [];
    // Installing: where, from what (a repo to clone) and under which id, as its provider says.
    let plan: ReturnType<typeof installPlan> | null = null;
    try {
      plan = path ? null : installPlan(p, opts.source);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    const root = path ? (path.startsWith("~/") ? `$HOME/${path.slice(2)}` : path) : `$HOME/${plan!.root}`;
    const wid = plan?.id ?? p.defaultId;
    const yaml = workspaceYaml({ id: wid, adapter: p.id, root: "$ROOT", owners: plan?.source ? [] : owners });
    const script = `
set -e
${PATH_LINE}
ROOT="${root}"
SOURCE="${plan?.source ?? ""}"
if [ -n "${path ?? ""}" ]; then
  ( ${p.check} ) || { echo "no ${p.label} at $ROOT"; exit 1; }
  echo "using the workspace at $ROOT"
else
${p.install?.script ?? ""}
fi
mkdir -p "$HOME/${this.config.machines.home}/workspaces"
cat > "$HOME/${this.config.machines.home}/workspaces/${wid}.yaml" <<EOF
${yaml}EOF
echo "jin's daemon there now has the workspace; restarting it"
${restartScript(this.config.machines)}
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
        await this.detectWorkspaces(id).catch(problems.catch(`finding workspaces on ${id}`));
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

const tool = (t: string | undefined): AuthTool => {
  if (!t || !authTools().includes(t)) throw new HttpError(400, `sign-ins are for ${authTools().join(", ")}`);
  return t;
};

export function machineRoutes(router: Router, machines: Machines, exportHistory?: () => unknown) {
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
      // Its steps say what failed, on the machine's page; the log keeps it too.
      void machines.setup(p.id!).catch(problems.catch(`setting up ${p.id}`));
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
    .on("POST", "/api/machines/:id/auth/:tool/token", async (req, p) => {
      const { token } = await body<{ token?: string }>(req);
      await machines.setToken(p.id!, tool(p.tool), token ?? "");
      return json(machines.view(p.id!));
    })
    .on("POST", "/api/machines/attach", async (req) => {
      const a = await body<{ id?: string; label?: string; port?: number; token?: string; version?: string | null }>(req);
      return json(machines.attach({ id: a.id ?? "", label: a.label ?? a.id ?? "", port: Number(a.port), token: a.token ?? "", version: a.version }), 201);
    })
    .on("POST", "/api/machines/key", async () => json(await machines.sshKey()))
    // The hub's own key, asked of the hub through its tunnel.
    .on("POST", "/api/machines/:id/hub-key", async (_req, p) => json(await machines.call(p.id!, "POST", "/api/machines/key")))
    .on("POST", "/api/machines/:id/move", async (_req, p) => json(await machines.moveToHome(p.id!, exportHistory?.() ?? { sessions: [], events: [], approvals: [], feed: [] })))
    .on("POST", "/api/machines/:id/home", async (req, p) => {
      const { home } = await body<{ home?: boolean }>(req);
      await machines.setHome(p.id!, home !== false);
      return json(machines.view(p.id!));
    })
    .on("POST", "/api/machines/:id/workspaces/detect", async (_req, p) => {
      await machines.detectWorkspaces(p.id!);
      return json(machines.view(p.id!));
    })
    .on("POST", "/api/machines/:id/workspace", async (req, p) => {
      const { path, provider: kind, source } = await body<{ path?: string; provider?: string; source?: string }>(req);
      machines.setupWorkspace(p.id!, { provider: kind ?? PROVIDERS[0]!.id, path, source });
      return json(machines.view(p.id!), 202);
    });
}
