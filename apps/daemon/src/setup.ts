import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Detected, detectionScript, isWorkspaceAt, provider, PROVIDERS, type ProviderView, providerViews, readDetections, workspaceYaml } from "./adapters";
import type { Config, WorkspaceConfig } from "./config";
import { body, HttpError, json, type Router } from "./http";
import { AUTH_STATUS_SCRIPT, type AuthState, type AuthTool, authTools, defaultSpawn, describeTool, driveSignIn, lines, PATH_LINE, readAuthStatus, signInCommand, type SignIn, type Spawn, type Step } from "./machines";

/** What jin needs on this machine before it is useful, and how far along it is. */
export interface SetupView {
  workspaces: { id: string; root: string; adapter: string }[];
  /** Workspaces found on this machine that jin does not use yet (the ones their tooling points at first). */
  candidates: Detected[];
  /** The kinds of workspace jin can use, and which it can install. */
  providers: ProviderView[];
  auth: AuthState[];
  install: Step | null;
  /** A workspace, and gh and Claude Code signed in. */
  ready: boolean;
}

const LOG_LINES = 300;


// realpath: macOS folders are case-insensitive, so two spellings can be one folder.
const real = (d: string) => {
  try {
    return realpathSync(d);
  } catch {
    return resolve(d);
  }
};

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

  /** Workspaces of every kind jin knows, found on this machine, that jin does not use yet. */
  candidates(): Detected[] {
    // A home other than the user's (tests): only that home's tools, not the user's PATH.
    const path = this.home === homedir() ? process.env.PATH : `${join(this.home, ".local", "bin")}:/usr/bin:/bin`;
    const r = spawnSync("sh", ["-c", `${PATH_LINE}\n${detectionScript()}`], { env: { ...process.env, HOME: this.home, PATH: path }, encoding: "utf8" });
    const seen = new Set(this.workspaces.map((w) => real(w.root)));
    return readDetections(r.stdout ?? "").found.filter((d) => {
      if (seen.has(real(d.root))) return false;
      seen.add(real(d.root));
      return true;
    });
  }

  private authOf(tool: AuthTool): AuthState {
    return this.auth.get(tool) ?? { tool, state: "unknown", account: null, url: null, code: null, needsCode: false, error: null };
  }

  private setAuth(tool: AuthTool, patch: Partial<AuthState>) {
    this.auth.set(tool, { ...this.authOf(tool), ...patch });
  }

  async view(): Promise<SetupView> {
    if (!this.checked) await this.checkAuth().catch(() => {});
    const auth = authTools().map((t) => ({ ...this.authOf(t), ...describeTool(t) }));
    const signedIn = (t: AuthTool) => auth.find((a) => a.tool === t)?.state === "signed-in";
    return {
      workspaces: this.workspaces.map((w) => ({ id: w.id, root: w.root, adapter: w.adapter })),
      candidates: this.candidates(),
      providers: providerViews(),
      auth,
      install: this.installStep,
      ready: this.workspaces.length > 0 && signedIn("gh") && signedIn("claude"),
    };
  }

  /** Ask gh, Claude Code and the workspaces' tools who is signed in. */
  async checkAuth() {
    const proc = this.spawn(["bash", "-s"], { stdin: new Blob([AUTH_STATUS_SCRIPT()]) });
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
    const cmd = `${PATH_LINE}; ${signInCommand(tool)}`;
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

  /** Use the workspace at `path` (of the given kind, or whichever kind it is): writes its config and starts using it. */
  useWorkspace(path: string, providerId?: string): WorkspaceConfig {
    const root = expand(path.trim());
    const p = providerId ? provider(providerId) : PROVIDERS.find((x) => isWorkspaceAt(x, root));
    if (!p || !isWorkspaceAt(p, root)) throw new HttpError(400, `${root} is not a workspace jin can use (${PROVIDERS.map((x) => x.label).join(", ")})`);
    if (this.workspaces.some((w) => real(w.root) === real(root))) throw new HttpError(409, `jin already uses the workspace at ${root}`);
    const taken = new Set(this.workspaces.map((w) => w.id));
    let id = p.defaultId;
    for (let n = 2; taken.has(id); n++) id = `${p.defaultId}-${n}`;
    const w: WorkspaceConfig = { id, adapter: p.id, root, github: { owners: p.owners(root) }, profile: {} };
    const dir = join(this.config.home, "workspaces");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.yaml`), workspaceYaml({ id, adapter: p.id, root, owners: w.github.owners }));
    this.addWorkspace(w);
    return w;
  }

  /** Install a workspace of this kind with its provider's installer, then use it. */
  install(providerId?: string) {
    if (this.installStep?.state === "running") throw new HttpError(409, "a workspace is already being installed");
    const p = providerId ? provider(providerId) : PROVIDERS.find((x) => x.install);
    if (!p?.install) throw new HttpError(400, `jin cannot install a ${p?.label ?? "workspace"}; point it at one instead`);
    const root = join(this.home, p.install.defaultRoot);
    const step: Step = { id: "workspace", label: `Install ${p.label}`, state: "running", log: [], error: null };
    this.installStep = step;
    const say = (l: string) => {
      step.log.push(l);
      if (step.log.length > LOG_LINES) step.log.splice(0, step.log.length - LOG_LINES);
    };
    const script = `set -e\n${PATH_LINE}\nROOT=${JSON.stringify(root)}\n${p.install.script}`;
    void (async () => {
      try {
        const proc = this.spawn(["bash", "-s"], { stdin: new Blob([script]) });
        await Promise.all([lines(proc.stdout, say), lines(proc.stderr, say)]);
        if ((await proc.exited) !== 0) throw new Error("the installer failed; see the log");
        this.useWorkspace(root, p.id);
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
  if (!t || !authTools().includes(t)) throw new HttpError(400, `sign-ins are for ${authTools().join(", ")}`);
  return t;
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
      const { path, provider: kind } = await body<{ path?: string; provider?: string }>(req);
      if (!path) throw new HttpError(400, "path is required");
      setup.useWorkspace(path, kind);
      return json(await setup.view(), 201);
    })
    .on("POST", "/api/setup/install", async (req) => {
      setup.install((await body<{ provider?: string }>(req).catch(() => ({}) as { provider?: string })).provider);
      return json(await setup.view(), 202);
    });
}
