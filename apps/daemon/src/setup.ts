import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Config, WorkspaceConfig } from "./config";
import { body, HttpError, json, type Router } from "./http";
import { AUTH_STATUS_SCRIPT, type AuthState, type AuthTool, defaultSpawn, driveSignIn, lines, PATH_LINE, readAuthStatus, SIGN_IN, type SignIn, type Spawn, type Step } from "./machines";

/** What jin needs on this machine before it is useful, and how far along it is. */
export interface SetupView {
  workspaces: { id: string; root: string }[];
  /** composio workspaces found on this machine that jin does not use yet. */
  candidates: string[];
  auth: AuthState[];
  install: Step | null;
  /** A workspace, and gh and Claude Code signed in. */
  ready: boolean;
}

const LOG_LINES = 300;
const TOOLS: AuthTool[] = ["gh", "claude", "doppler"];

/** The usual places a composio workspace lives (its installer defaults to ~/composio-workspace). */
const PLACES = ["composio-workspace", "Workspace/composio-workspace", "workspace/composio-workspace", "code/composio-workspace", "src/composio-workspace", "dev/composio-workspace"];

export const isComposioWorkspace = (dir: string) => existsSync(join(dir, "workspace.yaml")) && existsSync(join(dir, "bin", "cws"));

const expand = (p: string) => resolve(p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * First-run setup for this machine: find or install the workspace, and sign in to gh and
 * Claude Code. A workspace added here is live at once (no daemon restart). Sign-ins run here
 * in a terminal, open your browser, and show the code they ask for.
 */
export class LocalSetup {
  private auth = new Map<AuthTool, AuthState>();
  private signIns = new Map<AuthTool, SignIn>();
  private installStep: Step | null = null;
  private checked = false;

  constructor(
    private config: Config,
    private workspaces: WorkspaceConfig[],
    private addWorkspace: (w: WorkspaceConfig) => void,
    private spawn: Spawn = defaultSpawn,
    private home = homedir(),
  ) {}

  candidates(): string[] {
    // realpath: macOS folders are case-insensitive, so two spellings can be one folder.
    const real = (d: string) => {
      try {
        return realpathSync(d);
      } catch {
        return resolve(d);
      }
    };
    const seen = new Set(this.workspaces.map((w) => real(w.root)));
    const out: string[] = [];
    for (const d of PLACES.map((p) => join(this.home, p))) {
      if (!isComposioWorkspace(d) || seen.has(real(d))) continue;
      seen.add(real(d));
      out.push(d);
    }
    return out;
  }

  private authOf(tool: AuthTool): AuthState {
    return this.auth.get(tool) ?? { tool, state: "unknown", account: null, url: null, code: null, needsCode: false, error: null };
  }

  private setAuth(tool: AuthTool, patch: Partial<AuthState>) {
    this.auth.set(tool, { ...this.authOf(tool), ...patch });
  }

  async view(): Promise<SetupView> {
    if (!this.checked) await this.checkAuth().catch(() => {});
    const auth = TOOLS.map((t) => this.authOf(t));
    const signedIn = (t: AuthTool) => auth.find((a) => a.tool === t)?.state === "signed-in";
    return {
      workspaces: this.workspaces.map((w) => ({ id: w.id, root: w.root })),
      candidates: this.candidates(),
      auth,
      install: this.installStep,
      ready: this.workspaces.length > 0 && signedIn("gh") && signedIn("claude"),
    };
  }

  /** Ask gh, Claude Code and Doppler who is signed in. */
  async checkAuth() {
    const proc = this.spawn(["bash", "-s"], { stdin: new Blob([AUTH_STATUS_SCRIPT]) });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    this.checked = true;
    for (const [tool, s] of Object.entries(readAuthStatus(out)) as [AuthTool, { state: AuthState["state"]; account: string | null }][]) {
      if (this.signIns.has(tool)) continue;
      this.setAuth(tool, { state: s.state, account: s.account, url: null, code: null, needsCode: false, error: null });
    }
  }

  /** Sign in here, in a terminal (`script` gives the tool one), so it can open your browser. */
  signIn(tool: AuthTool) {
    this.signIns.get(tool)?.proc.kill();
    const cmd = `${PATH_LINE}; ${SIGN_IN[tool]}`;
    const argv = process.platform === "darwin" ? ["script", "-q", "/dev/null", "/bin/bash", "-c", cmd] : ["script", "-qfec", cmd, "/dev/null"];
    const proc = this.spawn(argv, { stdin: "pipe" });
    this.setAuth(tool, { state: "waiting", url: null, code: null, needsCode: false, error: null });
    const s = driveSignIn(proc, tool, (patch) => this.setAuth(tool, patch), async (ok) => {
      if (this.signIns.get(tool) !== s) return;
      this.signIns.delete(tool);
      if (ok) await this.checkAuth().catch(() => {});
    });
    this.signIns.set(tool, s);
  }

  submitCode(tool: AuthTool, code: string) {
    const s = this.signIns.get(tool);
    if (!s) throw new HttpError(409, `no ${tool} sign-in is waiting`);
    if (!/^[\w#.~+/=-]{8,400}$/.test(code.trim())) throw new HttpError(400, "that does not look like a sign-in code");
    s.proc.stdin?.write(`${code.trim()}\r`);
    s.proc.stdin?.flush?.();
    this.setAuth(tool, { needsCode: false });
  }

  cancelSignIn(tool: AuthTool) {
    const s = this.signIns.get(tool);
    this.signIns.delete(tool);
    s?.proc.kill();
    void this.checkAuth().catch(() => {});
  }

  /** Use the composio workspace at `path`: writes $JIN_HOME/workspaces/composio.yaml and starts using it. */
  useWorkspace(path: string): WorkspaceConfig {
    const root = expand(path.trim());
    if (!isComposioWorkspace(root)) throw new HttpError(400, `no composio workspace at ${root} (workspace.yaml and bin/cws are missing)`);
    if (this.workspaces.some((w) => w.adapter === "composio")) throw new HttpError(409, "jin already has a composio workspace");
    const w: WorkspaceConfig = { id: "composio", adapter: "composio", root, github: { owners: ["ComposioHQ"] }, profile: {} };
    const dir = join(this.config.home, "workspaces");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "composio.yaml"), ["id: composio", "adapter: composio", `root: ${root}`, "github:", "  owners: [ComposioHQ]", ""].join("\n"));
    this.addWorkspace(w);
    return w;
  }

  /** Install the composio workspace into ~/composio-workspace with its own installer (needs gh), then use it. */
  install() {
    if (this.installStep?.state === "running") throw new HttpError(409, "the workspace is already being installed");
    if (this.workspaces.some((w) => w.adapter === "composio")) throw new HttpError(409, "jin already has a composio workspace");
    const root = join(this.home, "composio-workspace");
    const step: Step = { id: "workspace", label: "Install the composio workspace", state: "running", log: [], error: null };
    this.installStep = step;
    const say = (l: string) => {
      step.log.push(l);
      if (step.log.length > LOG_LINES) step.log.splice(0, step.log.length - LOG_LINES);
    };
    const script = `
set -e
${PATH_LINE}
gh auth status >/dev/null 2>&1 || { echo "sign in to GitHub first: the workspace's repos are private"; exit 1; }
gh api repos/ComposioHQ/workspace/contents/install.sh -H 'Accept: application/vnd.github.raw' | bash -s -- --yes --dir "${root}"
`;
    void (async () => {
      try {
        const proc = this.spawn(["bash", "-s"], { stdin: new Blob([script]) });
        await Promise.all([lines(proc.stdout, say), lines(proc.stderr, say)]);
        if ((await proc.exited) !== 0) throw new Error("the installer failed; see the log");
        this.useWorkspace(root);
        say(`jin now uses the workspace at ${root}`);
        step.state = "done";
      } catch (err) {
        step.state = "failed";
        step.error = err instanceof Error ? err.message : String(err);
      }
    })();
  }

  stopAll() {
    for (const s of this.signIns.values()) s.proc.kill();
  }
}

const tool = (t: string | undefined): AuthTool => {
  if (!t || !TOOLS.includes(t as AuthTool)) throw new HttpError(400, "sign-ins are for gh, claude and doppler");
  return t as AuthTool;
};

export function setupRoutes(router: Router, setup: LocalSetup) {
  router
    .on("GET", "/api/setup", async () => json(await setup.view()))
    .on("POST", "/api/setup/auth", async () => {
      await setup.checkAuth();
      return json(await setup.view());
    })
    .on("POST", "/api/setup/auth/:tool", async (_req, p) => {
      setup.signIn(tool(p.tool));
      return json(await setup.view(), 202);
    })
    .on("DELETE", "/api/setup/auth/:tool", async (_req, p) => {
      setup.cancelSignIn(tool(p.tool));
      return json(await setup.view());
    })
    .on("POST", "/api/setup/auth/:tool/code", async (req, p) => {
      const { code } = await body<{ code?: string }>(req);
      setup.submitCode(tool(p.tool), code ?? "");
      return json(await setup.view());
    })
    .on("POST", "/api/setup/workspace", async (req) => {
      const { path } = await body<{ path?: string }>(req);
      if (!path) throw new HttpError(400, "path is required");
      setup.useWorkspace(path);
      return json(await setup.view(), 201);
    })
    .on("POST", "/api/setup/install", async () => {
      setup.install();
      return json(await setup.view(), 202);
    });
}
