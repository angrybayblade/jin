"use client";
import { Check, ChevronDown, ChevronRight, Circle, Copy, ExternalLink, FolderGit2, LoaderCircle, Monitor, Plus, RefreshCw, Server, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  addMachine,
  cancelMachineSignIn,
  checkMachineAuth,
  hubKey,
  moveToHome,
  setMachineHome,
  detectMachineWorkspaces,
  getMachine,
  removeMachine,
  rerunMachineSetup,
  setMachineToolToken,
  setupMachineWorkspace,
  startMachineSignIn,
  submitMachineSignInCode,
  switchMachine,
} from "@/app/actions";
import type { Machine, MachineAuth, MachineStep } from "@/lib/daemon";
import { useArmedConfirm } from "@/lib/confirm";


/** Where a machine is, in a word. */
export function machineState(m: Machine): { label: string; tone: "ok" | "busy" | "bad" | "idle" } {
  if (m.busy && m.steps.some((s) => s.state === "running")) return { label: "Setting up", tone: "busy" };
  if (m.steps.some((s) => s.state === "failed")) return { label: "Setup failed", tone: "bad" };
  if (m.connected && m.outdated) return { label: "Update available", tone: "busy" };
  if (m.connected) return { label: "Connected", tone: "ok" };
  if (m.tunnel === "connecting") return { label: "Connecting", tone: "busy" };
  if (m.tunnel === "down") return { label: "Offline", tone: "bad" };
  return { label: "Not set up", tone: "idle" };
}

function StepIcon({ state }: { state: MachineStep["state"] }) {
  if (state === "done") return <Check size={14} className="step-done" />;
  if (state === "running") return <LoaderCircle size={14} className="spin" />;
  if (state === "failed") return <X size={14} className="step-failed" />;
  return <Circle size={14} className="step-pending" />;
}

export function Steps({ steps }: { steps: MachineStep[] }) {
  return (
    <ol className="machine-steps">
      {steps.map((s) => {
        const last = s.log.at(-1);
        const line = (
          <>
            <StepIcon state={s.state} />
            <span className="machine-step-label">{s.label}</span>
            {last && s.state !== "running" && s.state !== "failed" && <span className="machine-step-detail">{last}</span>}
          </>
        );
        return (
          <li key={s.id} className={`machine-step is-${s.state}`}>
            {s.state === "done" && s.log.length > 1 ? (
              <details>
                <summary className="machine-step-line">{line}</summary>
                <pre className="machine-log">{s.log.join("\n")}</pre>
              </details>
            ) : (
              <div className="machine-step-line">{line}</div>
            )}
            {s.error && <p className="machine-error">{s.error}</p>}
            {s.log.length > 0 && (s.state === "running" || s.state === "failed") && <pre className="machine-log">{s.log.slice(-8).join("\n")}</pre>}
          </li>
        );
      })}
    </ol>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="button small quiet"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/** What a sign-in row can do: on a remote machine, or on this one. */
export interface SignInActions {
  /** Where the sign-in runs, for "Starting the sign-in on …". */
  where: string;
  start: (tool: string) => Promise<unknown>;
  cancel: (tool: string) => Promise<unknown>;
  code: (tool: string, code: string) => Promise<{ error: string } | null>;
  token?: (tool: string, token: string) => Promise<{ error: string } | null>;
}

export function SignIn({ actions, auth, refresh }: { actions: SignInActions; auth: MachineAuth; refresh: () => void }) {
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (p: Promise<unknown>) => void p.then(refresh, (e) => setError(String(e)));
  const signedIn = auth.state === "signed-in";
  return (
    <li className={`machine-auth is-${auth.state}`}>
      <div className="machine-auth-head">
        <span className={`machine-dot is-${signedIn ? "ok" : auth.state === "waiting" ? "busy" : auth.state === "failed" ? "bad" : "idle"}`} />
        <div className="machine-auth-name">
          <span className="machine-auth-tool">{auth.label}</span>
          <span className="meta machine-auth-state">
            {signedIn
              ? `Signed in${auth.account ? ` as ${auth.account}` : ""}`
              : auth.state === "missing"
                ? "Not installed"
                : auth.state === "waiting"
                  ? "Waiting for you"
                  : auth.state === "unknown"
                    ? "Checking…"
                    : auth.state === "failed"
                      ? "Sign-in failed"
                      : auth.why}
          </span>
        </div>
        {auth.tokenHint && actions.token && !signedIn && auth.state !== "missing" && auth.state !== "waiting" && !showToken && (
          <button type="button" className="button small quiet" onClick={() => setShowToken(true)} title={`Set a ${auth.label} token instead of signing in`}>
            Use a token
          </button>
        )}
        {auth.state === "waiting" ? (
          <button type="button" className="button small quiet" onClick={() => act(actions.cancel(auth.tool))}>
            Cancel
          </button>
        ) : (
          auth.state !== "missing" &&
          auth.state !== "unknown" && (
            <button type="button" className={`button small ${signedIn ? "quiet" : ""}`} onClick={() => act(actions.start(auth.tool))}>
              {signedIn ? "Sign in again" : "Sign in"}
            </button>
          )
        )}
      </div>
      {auth.state === "waiting" && !auth.url && (
        <p className="meta machine-auth-body">
          <LoaderCircle size={12} className="spin" /> Starting the sign-in on {actions.where}…
        </p>
      )}
      {auth.state === "waiting" && auth.url && (
        <div className="machine-auth-body">
          <ol className="machine-auth-steps">
            <li>
              Open{" "}
              <a href={auth.url} target="_blank" rel="noreferrer noopener" className="machine-link">
                {auth.url.length > 60 ? `${new URL(auth.url).host}/…` : auth.url}
                <ExternalLink size={11} />
              </a>
            </li>
            {auth.code && (
              <li>
                Enter <code className="machine-code">{auth.code}</code> <CopyButton text={auth.code} />
              </li>
            )}
            {auth.tool === "claude" && <li>Approve, then paste the code the page shows:</li>}
          </ol>
          {auth.tool === "claude" && (
            <form
              className="machine-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void actions.code(auth.tool, code).then((r) => {
                  if (r) setError(r.error);
                  else setCode("");
                  refresh();
                });
              }}
            >
              <input className="machine-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code from the sign-in page" autoComplete="off" spellCheck={false} />
              <button type="submit" className="button small primary" disabled={!code.trim()}>
                Submit
              </button>
            </form>
          )}
          {auth.tool !== "claude" && <p className="meta">It finishes here on its own once you approve.</p>}
        </div>
      )}
      {auth.state === "failed" && auth.error && <p className="machine-error machine-auth-body">{auth.error}</p>}
      {auth.tokenHint && actions.token && showToken && (
        <div className="machine-auth-body">
          <form
            className="machine-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void actions.token?.(auth.tool, token).then((r) => {
                if (r) setError(r.error);
                else {
                  setToken("");
                  setShowToken(false);
                }
                refresh();
              });
            }}
          >
            <input className="machine-input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={auth.tokenHint ?? ""} autoComplete="off" autoFocus />
            <button type="submit" className="button small primary" disabled={!token.trim()}>
              Save
            </button>
            <button type="button" className="button small quiet" onClick={() => setShowToken(false)}>
              Cancel
            </button>
          </form>
        </div>
      )}
      {error && <p className="machine-error machine-auth-body">{error}</p>}
    </li>
  );
}

function Workspace({ machine, refresh }: { machine: Machine; refresh: () => void }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const step = machine.workspaceStep;
  const found = machine.workspaceCandidates ?? [];
  const looking = machine.workspaceCandidates === null;
  const label = (id: string) => machine.providers.find((p) => p.id === id)?.label ?? id;
  const [kind, setKind] = useState(machine.providers[0]?.id ?? "");
  const go = (provider: string, p?: string) =>
    void setupMachineWorkspace(machine.id, { provider, path: p }).then((r) => {
      setError(r?.error ?? null);
      refresh();
    });
  const pathForm = (
    <form
      className="machine-inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        go(kind, path);
      }}
    >
      {machine.providers.length > 1 && (
        <select className="machine-input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind of workspace">
          {machine.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      )}
      <input className="machine-input" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/path/to/workspace" spellCheck={false} />
      <button type="submit" className="button small" disabled={!path.trim() || machine.busy}>
        Use
      </button>
    </form>
  );
  return (
    <section className="md-card">
      <div className="md-card-head is-static">
        <h3>Workspace</h3>
        {!machine.workspace && <span className="meta">jin's tasks there run in it</span>}
        {!machine.workspace && step?.state !== "running" && (
          <button type="button" className="button small quiet md-card-action" onClick={() => void detectMachineWorkspaces(machine.id).then(refresh)} title="Look again">
            <RefreshCw size={12} />
          </button>
        )}
      </div>
      <div className="md-card-body">
      {machine.workspace && step?.state !== "running" && (
        <p className="setup-done">
          <Check size={14} className="step-done" /> workspace at {machine.workspace}
        </p>
      )}
      {step && <Steps steps={[step]} />}
      {!machine.workspace && step?.state !== "running" && (
        <div className="setup-options">
          {looking && (
            <p className="meta setup-done">
              <LoaderCircle size={12} className="spin" /> Looking for a workspace on {machine.label}…
            </p>
          )}
          {found.map((c) => (
            <div key={c.root} className="setup-option">
              <FolderGit2 size={14} />
              <span className="setup-option-path">{c.root}</span>
              <span className="meta setup-option-hint">{label(c.provider)}{c.preferred ? " · its tooling uses this one" : ""}</span>
              <button type="button" className="button small primary" disabled={machine.busy} onClick={() => go(c.provider, c.root)}>
                Use this one
              </button>
            </div>
          ))}
          {!looking &&
            found.length === 0 &&
            machine.providers
              .filter((p) => p.installsTo)
              .map((p) => (
                <div key={p.id} className="machine-workspace-actions">
                  <button type="button" className="button small primary" disabled={machine.busy} onClick={() => go(p.id)}>
                    Install {p.label} into {p.installsTo}
                  </button>
                  <span className="meta">None found in the usual places.</span>
                </div>
              ))}
          {!looking && (other || found.length === 0 ? pathForm : (
            <button type="button" className="button small quiet setup-other" onClick={() => setOther(true)}>
              Somewhere else…
            </button>
          ))}
        </div>
      )}
      {error && <p className="machine-error">{error}</p>}
      </div>
    </section>
  );
}

/** Using a machine as jin's always-on home (the hub), and moving to it. */
function Home({ machine, refresh }: { machine: Machine; refresh: () => void }) {
  const router = useRouter();
  const [key, setKey] = useState<string | null>(null);
  const [moved, setMoved] = useState<{ history: { sessions: number; events: number; feed: number; transcripts?: number }; machines: { id: string; ok: boolean; error?: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(p: Promise<T | { error: string }>, done: (v: T) => void) => {
    setBusy(true);
    setError(null);
    const r = await p;
    setBusy(false);
    if (r && typeof r === "object" && "error" in r) setError((r as { error: string }).error);
    else done(r as T);
    refresh();
    router.refresh();
  };
  if (!machine.home) {
    return (
      <section className="md-card">
        <div className="md-card-head is-static">
          <h3>Home</h3>
          <span className="meta">run jin's main daemon here, always on</span>
          <button
            type="button"
            className={`button small md-card-action ${armed ? "primary" : ""}`}
            disabled={busy || !machine.connected}
            onClick={() => (armed ? (setArmed(false), void run(setMachineHome(machine.id, true).then((r) => r ?? {}), () => {})) : setArmed(true))}
          >
            {busy ? (
              <>
                <LoaderCircle size={12} className="spin" /> Switching…
              </>
            ) : armed ? (
              `Make ${machine.label} the home`
            ) : (
              "Use as home"
            )}
          </button>
        </div>
        <div className="md-card-body">
          {armed && <p className="machine-notice">The app switches to {machine.label} for chats, desks, the feed and approvals. Click again to confirm.</p>}
          <p className="meta">
            jin's chat, the desks, the GitHub feed and approvals move to {machine.label} and keep going while this machine sleeps. This machine stays one of its machines: its tasks and Claude
            Code sessions run here, and the app keeps working from here.
          </p>
          {error && <p className="machine-error">{error}</p>}
        </div>
      </section>
    );
  }
  return (
    <section className="md-card">
      <div className="md-card-head is-static">
        <h3>Home</h3>
        <span className="meta">jin's always-on home; this machine is attached to it</span>
        <button type="button" className="button small quiet md-card-action" disabled={busy} onClick={() => void run(setMachineHome(machine.id, false).then((r) => r ?? {}), () => {})}>
          Stop
        </button>
      </div>
      <ul className="home-steps">
        <li className="home-step">
          <span className="home-step-icon">{key ? <Check size={14} className="step-done" /> : <Circle size={14} className="step-pending" />}</span>
          <div className="home-step-text">
            <span>Give {machine.label} its own key</span>
            <span className="meta">so it can reach your other machines while this one sleeps</span>
          </div>
          {!key && (
            <button type="button" className="button small" disabled={busy} onClick={() => void run(hubKey(machine.id), (r) => setKey(r.publicKey))}>
              Show key
            </button>
          )}
          {key && (
            <div className="home-step-detail">
              <div className="home-key">
                <code className="home-key-text">{key}</code>
                <CopyButton text={key} />
              </div>
              <p className="meta">Add it to your exe.dev account's SSH keys (or each machine's ~/.ssh/authorized_keys). It was made on {machine.label} and never leaves it.</p>
            </div>
          )}
        </li>
        <li className="home-step">
          <span className="home-step-icon">{moved ? <Check size={14} className="step-done" /> : <Circle size={14} className="step-pending" />}</span>
          <div className="home-step-text">
            <span>Move chats and feed to {machine.label}</span>
            <span className="meta">and have it connect to your other machines</span>
          </div>
          <button type="button" className={`button small ${moved ? "" : "primary"}`} disabled={busy} onClick={() => void run(moveToHome(machine.id), setMoved)}>
            {busy ? <LoaderCircle size={12} className="spin" /> : null} {moved ? "Move again" : "Move"}
          </button>
          {moved && (
            <div className="home-step-detail">
              <p className="meta">
                {moved.history.sessions} chats ({moved.history.transcripts ?? 0} keep Claude's memory) and {moved.history.feed} feed items moved.
              </p>
              {moved.machines.map((r) => (
                <p key={r.id} className={r.ok ? "meta" : "machine-error"}>
                  {r.id}: {r.ok ? `${machine.label} is connecting to it` : r.error}
                </p>
              ))}
            </div>
          )}
        </li>
      </ul>
      {error && <p className="machine-error home-error">{error}</p>}
    </section>
  );
}

function MachineDetail({ initial, current, onRemoved }: { initial: Machine; current: boolean; onRemoved: () => void }) {
  const router = useRouter();
  const [m, setM] = useState(initial);
  const refresh = () => void getMachine(m.id).then(setM, () => {});
  useEffect(() => setM(initial), [initial]);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id]);
  const confirm = useArmedConfirm();
  const remove = { armed: confirm.armed === "forget", onClick: () => confirm.ask("forget") && void removeMachine(m.id).then(onRemoved) };
  const state = machineState(m);
  const ready = m.steps.every((s) => s.state === "done");
  const signInActions: SignInActions = {
    where: m.label,
    start: (t) => startMachineSignIn(m.id, t),
    cancel: (t) => cancelMachineSignIn(m.id, t),
    code: (t, c) => submitMachineSignInCode(m.id, t, c),
    token: (tool, tok) => setMachineToolToken(m.id, tool, tok),
  };
  const [showSteps, setShowSteps] = useState(!ready);
  // Onboarding shows its steps; once everything is done they fold into one line.
  useEffect(() => setShowSteps(!ready), [ready]);
  const doneSteps = m.steps.filter((x) => x.state === "done").length;
  const tunnelPort = m.localPort ? `127.0.0.1:${m.localPort}` : null;
  return (
    <article className="machine-detail">
      <header className="md-head">
        <span className="md-icon">
          <Server size={16} />
        </span>
        <div className="md-title">
          <div className="md-name">
            <h2>{m.label}</h2>
            <span className={`machine-pill is-${state.tone}`}>{state.label}</span>
            {m.home && <span className="machine-pill is-home">home</span>}
          </div>
          <span className="meta">ssh {m.host}</span>
        </div>
        <div className="md-actions">
          {current ? (
            <span className="meta">Showing this machine</span>
          ) : (
            m.connected && (
              <button
                type="button"
                className="button small primary"
                onClick={() =>
                  void switchMachine(m.id).then(() => {
                    router.push("/");
                    router.refresh();
                  })
                }
              >
                Open
              </button>
            )
          )}
          <button type="button" className="button small" disabled={m.busy} onClick={() => void rerunMachineSetup(m.id).then(refresh)} title="Runs every step again; also updates jin there to this jin's commit">
            <RefreshCw size={12} /> {ready ? "Update jin" : "Retry setup"}
          </button>
          <button type="button" className={`button small quiet icon-only ${remove.armed ? "is-armed" : ""}`} onClick={remove.onClick} title={remove.armed ? "Click again: stop jin there and forget this machine" : "Forget this machine"} aria-label="Forget this machine">
            <Trash2 size={13} />
          </button>
        </div>
      </header>
      {remove.armed && <p className="machine-notice is-danger">Click the bin again to stop jin on {m.label} and forget it. Its files stay in ~/.jin there.</p>}
      {m.outdated && !m.busy && (
        <p className="machine-notice">
          {m.label} runs jin {m.version}; this machine runs a newer one. <strong>Update jin</strong> copies it over and restarts it (Claude Code sessions there resume).
        </p>
      )}

      {ready && (
        <dl className="md-facts">
          <div>
            <dt>System</dt>
            <dd>{m.system ?? "—"}</dd>
          </div>
          <div>
            <dt>jin</dt>
            <dd className="mono">{m.version ?? "—"}</dd>
          </div>
          <div>
            <dt>Tunnel</dt>
            <dd>
              <span className={`machine-dot is-${m.tunnel === "up" ? "ok" : m.tunnel === "connecting" ? "busy" : "bad"}`} /> {m.tunnel === "up" ? tunnelPort : m.tunnel}
            </dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd className="md-ellipsis" title={m.workspace ?? undefined}>
              {m.workspace ?? "none yet"}
            </dd>
          </div>
        </dl>
      )}

      <section className="md-card">
        <button type="button" className="md-card-head" onClick={() => setShowSteps((v) => !v)} aria-expanded={showSteps}>
          {showSteps ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <h3>Setup</h3>
          <span className="meta">
            {ready ? "done" : m.busy ? `step ${Math.min(doneSteps + 1, m.steps.length)} of ${m.steps.length}` : m.steps.some((x) => x.state === "failed") ? "stopped" : `${doneSteps} of ${m.steps.length}`}
          </span>
        </button>
        {(showSteps || !ready) && <Steps steps={m.steps} />}
      </section>

      {ready && (
        <>
          <section className="md-card">
            <div className="md-card-head is-static">
              <h3>Sign-ins</h3>
              <span className="meta">run on {m.label}; no credentials are copied</span>
              <button type="button" className="button small quiet md-card-action" onClick={() => void checkMachineAuth(m.id).then(refresh)} title="Check again">
                <RefreshCw size={12} />
              </button>
            </div>
            <ul className="machine-auths">
              {m.auth.map((a) => (
                <SignIn key={a.tool} actions={signInActions} auth={a} refresh={refresh} />
              ))}
            </ul>
          </section>
          <Workspace machine={m} refresh={refresh} />
          <Home machine={m} refresh={refresh} />
        </>
      )}
    </article>
  );
}

/** Remote machines: add one by its ssh host, watch it set up, sign in, and open it. */
export function Machines({ machines, current, selected }: { machines: Machine[]; current: string; selected: string | null }) {
  const router = useRouter();
  const [host, setHost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState<string | null>(selected ?? machines[0]?.id ?? null);
  const chosen = machines.find((m) => m.id === pick) ?? null;
  return (
    <div className="machines">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-name">Machines</span>
          <span className="meta">jin on other computers you reach over SSH</span>
        </div>
      </header>
      <div className="machines-body" data-scroll="y">
        <aside className="machines-list">
          <button
            type="button"
            className={`machines-item ${current === "local" ? "is-current" : ""}`}
            onClick={() =>
              void switchMachine("local").then(() => {
                router.push("/");
                router.refresh();
              })
            }
            title="Show this machine's jin"
          >
            <Monitor size={14} />
            <span className="machines-item-name">This machine</span>
            {current === "local" && <span className="meta">current</span>}
          </button>
          {machines.map((m) => {
            const s = machineState(m);
            return (
              <button key={m.id} type="button" className={`machines-item ${pick === m.id ? "is-selected" : ""} ${current === m.id ? "is-current" : ""}`} onClick={() => setPick(m.id)}>
                <span className={`machine-dot is-${s.tone}`} />
                <span className="machines-item-name">{m.label}</span>
                {m.home && <span className="machine-pill is-home">home</span>}
                <span className="meta">{current === m.id ? "current" : s.label}</span>
              </button>
            );
          })}
          <form
            className="machines-add"
            onSubmit={(e) => {
              e.preventDefault();
              setAdding(true);
              void addMachine(host).then((r) => {
                setAdding(false);
                if ("error" in r) return setError(r.error);
                setError(null);
                setHost("");
                setPick(r.id);
                router.refresh();
              });
            }}
          >
            <label className="field">
              Add a machine
              <span className="machine-inline-form">
                <span className="machine-ssh">ssh</span>
                <input className="machine-input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="dev-box.example.com" spellCheck={false} autoCapitalize="off" />
                <button type="submit" className="button small primary" disabled={!host.trim() || adding} aria-label="Add machine">
                  {adding ? <LoaderCircle size={12} className="spin" /> : <Plus size={12} />}
                </button>
              </span>
            </label>
            <p className="meta">Uses your SSH keys and ~/.ssh/config. jin installs Bun, gh and Claude Code there and runs its own daemon.</p>
            {error && <p className="machine-error">{error}</p>}
          </form>
        </aside>
        <main className="machines-main">
          {chosen ? (
            <MachineDetail key={chosen.id} initial={chosen} current={current === chosen.id} onRemoved={() => (setPick(null), router.refresh())} />
          ) : (
            <div className="machines-empty">
              <Server size={28} />
              <p>Add a machine you reach with ssh: a dev VM, a box under your desk.</p>
              <p className="meta">Its tasks, Claude Code sessions and terminals run there, and keep running when this machine sleeps.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
