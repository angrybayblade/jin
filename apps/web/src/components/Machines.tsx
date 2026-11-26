"use client";
import { AgentPanel, AgentSelector, SidePanel, useMachineAgents } from "@/components/MachineAgents";
import { Empty } from "@/components/States";
import { Check, ChevronDown, ChevronRight, Circle, Copy, ExternalLink, LoaderCircle, Monitor, Plus, RefreshCw, Server, Trash2, Wrench, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  addMachine,
  cancelMachineSignIn,
  checkMachineAuth,
  hubKey,
  connectHomeToMachines,
  setMachineHome,
  detectMachineWorkspaces,
  getMachine,
  removeMachine,
  rerunMachineSetup,
  setMachineToolToken,
  setupMachineWorkspace,
  startMachineSignIn,
  submitMachineSignInCode,
  cancelSetupSignIn,
  checkSetupAuth,
  getLocalStatus,
  getSetup,
  startSetupSignIn,
  submitSetupSignInCode,
  adoptSetupWorkspace,
  installSetupWorkspace,
} from "@/lib/actions";
import { AddPortPanel, PortList, PortPanel } from "@/components/MachinePorts";
import { AddWorkspacePanel, useWorkspaceList, WorkspaceList, WorkspacePanel, type WorkspaceCtl, type WorkspaceRow } from "@/components/MachineWorkspaces";
import type { HomeMoved, Machine, MachineAuth, MachineStep, SetupState, WorkspaceProviderView } from "@/lib/daemon";
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
          <span className="meta machine-auth-state" title={auth.state === "signed-out" ? auth.why : undefined}>
            {signedIn
              ? auth.providers
                ? `Signed in to ${auth.account ?? "a provider"}`
                : `Signed in${auth.account ? ` as ${auth.account}` : ""}`
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
          auth.state !== "unknown" &&
          !auth.signInHint && (
            <button type="button" className={`button small ${signedIn ? "quiet" : ""}`} onClick={() => act(actions.start(auth.tool))}>
              {signedIn ? "Sign in again" : "Sign in"}
            </button>
          )
        )}
      </div>
      {auth.signInHint && auth.state !== "missing" && auth.state !== "unknown" && <p className="meta machine-auth-body">{auth.signInHint}</p>}
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

/** What the side panel shows: the picked coding agent, a workspace to manage or adding one, a forwarded port or forwarding one. */
type Side = { kind: "agent" } | { kind: "workspace"; id: string } | { kind: "add" } | { kind: "port"; id: string } | { kind: "add-port" };

/** The side panel's choice, and after adding, the new workspace picked once it shows in the list. */
function useSide(list: WorkspaceRow[] | null) {
  const [side, setSide] = useState<Side>({ kind: "agent" });
  const [before, setBefore] = useState<string[] | null>(null);
  useEffect(() => {
    if (!before || !list) return;
    const fresh = list.find((w) => !before.includes(w.id));
    if (fresh) {
      setBefore(null);
      setSide({ kind: "workspace", id: fresh.id });
    }
  }, [list, before]);
  // A workspace that is gone (forgotten elsewhere) gives the panel back to the agent.
  useEffect(() => {
    if (side.kind === "workspace" && list && !list.some((w) => w.id === side.id)) setSide({ kind: "agent" });
  }, [list, side]);
  return { side, setSide, added: () => setBefore((list ?? []).map((w) => w.id)) };
}

function SideFor({ side, ctl, onSide, added, agent }: { side: Side; ctl: WorkspaceCtl; onSide: (s: Side) => void; added: () => void; agent: React.ReactNode }) {
  if (side.kind === "add") return <AddWorkspacePanel ctl={ctl} onAdded={added} />;
  const row = side.kind === "workspace" ? ctl.list?.find((w) => w.id === side.id) : undefined;
  if (row) return <WorkspacePanel key={row.id} ctl={ctl} row={row} onGone={() => (onSide({ kind: "agent" }), ctl.refresh())} />;
  return <>{agent}</>;
}

/**
 * The workspaces jin can install: a button each, or a field and a button for one installed
 * from something the user names (a repo to clone).
 */
export function InstallOptions({ providers, disabled, onInstall }: { providers: WorkspaceProviderView[]; disabled?: boolean; onInstall: (provider: string, source?: string) => void }) {
  const [sources, setSources] = useState<Record<string, string>>({});
  return (
    <>
      {providers
        .filter((p) => p.installsTo)
        .map((p) =>
          p.source ? (
            <form
              key={p.id}
              className="machine-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                onInstall(p.id, sources[p.id]?.trim());
              }}
            >
              <input className="machine-input" value={sources[p.id] ?? ""} onChange={(e) => setSources((s) => ({ ...s, [p.id]: e.target.value }))} placeholder={`${p.label}: ${p.source.hint}`} aria-label={p.source.label} spellCheck={false} />
              <button type="submit" className="button small" disabled={disabled || !sources[p.id]?.trim()} title={`Clones it into ${p.installsTo}/<name> and uses it`}>
                Clone
              </button>
            </form>
          ) : (
            <div key={p.id} className="machine-workspace-actions">
              <button type="button" className="button small" disabled={disabled} onClick={() => onInstall(p.id)}>
                Install {p.label} into {p.installsTo}
              </button>
              <span className="meta">{p.description}</span>
            </div>
          ),
        )}
    </>
  );
}

/** What moved with the home, in a line. */
const movedLine = (m: HomeMoved) =>
  [`${m.sessions} chat${m.sessions === 1 ? "" : "s"}${m.transcripts ? ` (${m.transcripts} keep Claude's memory)` : ""}`, `${m.feed} desk item${m.feed === 1 ? "" : "s"}`, `${m.docs} doc${m.docs === 1 ? "" : "s"}`, `${m.memory} memor${m.memory === 1 ? "y" : "ies"}`, `${m.files} settings file${m.files === 1 ? "" : "s"}`].join(", ");

/**
 * Using a machine as jin's always-on home (the hub). Switching moves everything the home holds
 * from where it is now (the old home, or this machine); stopping brings it back here.
 */
function Home({ machine, current, refresh }: { machine: Machine; current: string; refresh: () => void }) {
  const router = useRouter();
  const [key, setKey] = useState<string | null>(null);
  const [connected, setConnected] = useState<{ id: string; ok: boolean; error?: string }[] | null>(null);
  const [moved, setMoved] = useState<HomeMoved | null>(null);
  const [busy, setBusy] = useState<"switch" | "stop" | "key" | "connect" | null>(null);
  const [armed, setArmed] = useState<"switch" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(what: NonNullable<typeof busy>, p: Promise<T | { error: string }>, done: (v: T) => void) => {
    setBusy(what);
    setError(null);
    const r = await p;
    setBusy(null);
    if (r && typeof r === "object" && "error" in r) setError((r as { error: string }).error);
    else done(r as T);
    refresh();
    router.refresh();
  };
  const last = moved ?? machine.lastMove?.moved ?? null;
  if (!machine.home) {
    return (
      <section className="md-card">
        <div className="md-card-head is-static">
          <h3>Home</h3>
          <span className="meta">run jin's main daemon here, always on</span>
          <button
            type="button"
            className={`button small md-card-action ${armed === "switch" ? "primary" : ""}`}
            disabled={busy !== null || !machine.connected}
            onClick={() => (armed === "switch" ? (setArmed(null), void run("switch", setMachineHome(machine.id, true), (r) => setMoved(r.moved))) : setArmed("switch"))}
          >
            {busy === "switch" ? (
              <>
                <LoaderCircle size={12} className="spin" /> Moving the home…
              </>
            ) : armed === "switch" ? (
              `Make ${machine.label} the home`
            ) : (
              "Use as home"
            )}
          </button>
        </div>
        <div className="md-card-body">
          {armed === "switch" && (
            <p className="machine-notice">
              Your chats, the desk, docs, memory and their settings move from {current} to {machine.label}, and the app switches to it. {current === "this machine" ? "This machine" : current} stops running the desk. Click again to confirm.
            </p>
          )}
          {busy === "switch" && <p className="meta">Moving everything from {current}; this can take a minute with long chats.</p>}
          <p className="meta">
            jin&apos;s chat, the desks, the feed, docs and approvals move to {machine.label} and keep going while this machine sleeps. This machine stays one of its machines: its tasks and Claude
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
        <span className="meta">jin&apos;s always-on home; this machine is attached to it</span>
        <button
          type="button"
          className={`button small quiet md-card-action ${armed === "stop" ? "is-armed" : ""}`}
          disabled={busy !== null}
          onClick={() => (armed === "stop" ? (setArmed(null), void run("stop", setMachineHome(machine.id, false), () => {})) : setArmed("stop"))}
          title="Bring the home back to this machine"
        >
          {busy === "stop" ? <LoaderCircle size={12} className="spin" /> : null} {armed === "stop" ? "Click again to bring it here" : "Stop"}
        </button>
      </div>
      {armed === "stop" && <p className="machine-notice home-error">Your chats, the desk, docs and memory move back to this machine, and {machine.label} stops running the desk.</p>}
      <ul className="home-steps">
        <li className="home-step">
          <span className="home-step-icon">{last ? <Check size={14} className="step-done" /> : <Circle size={14} className="step-pending" />}</span>
          <div className="home-step-text">
            <span>{last ? `Moved here${machine.lastMove ? ` from ${machine.lastMove.from}` : ""}` : "Chats and the desk live here"}</span>
            <span className="meta">{last ? movedLine(last) : "moved over when it became the home"}</span>
          </div>
          {last?.needs?.includes("composio") && (
            <div className="home-step-detail">
              <p className="machine-notice">
                Sign in to Composio on the <Link href="/live">Live</Link> page: the desk&apos;s Slack, Linear, Notion and Gmail events wait until then, and pick up where the old home left off.
              </p>
            </div>
          )}
        </li>
        <li className="home-step">
          <span className="home-step-icon">{key ? <Check size={14} className="step-done" /> : <Circle size={14} className="step-pending" />}</span>
          <div className="home-step-text">
            <span>Give {machine.label} its own key</span>
            <span className="meta">so it can reach your other machines while this one sleeps</span>
          </div>
          {!key && (
            <button type="button" className="button small" disabled={busy !== null} onClick={() => void run("key", hubKey(machine.id), (r) => setKey(r.publicKey))}>
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
          <span className="home-step-icon">{connected ? <Check size={14} className="step-done" /> : <Circle size={14} className="step-pending" />}</span>
          <div className="home-step-text">
            <span>Connect {machine.label} to your other machines</span>
            <span className="meta">with its own key, once that is on them</span>
          </div>
          <button type="button" className="button small" disabled={busy !== null} onClick={() => void run("connect", connectHomeToMachines(machine.id), (r) => setConnected(r.machines))}>
            {busy === "connect" ? <LoaderCircle size={12} className="spin" /> : null} {connected ? "Again" : "Connect"}
          </button>
          {connected && (
            <div className="home-step-detail">
              {connected.map((r) => (
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

function MachineDetail({ initial, onRemoved, homeLabel }: { initial: Machine; onRemoved: () => void; homeLabel: string }) {
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
  const ag = useMachineAgents(m.id, ready && m.connected);
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
  const ws = useWorkspaceList(m.id, ready && m.connected, `${m.workspace}:${m.workspaceStep?.state}`);
  const ctl: WorkspaceCtl = {
    machine: m.id,
    where: m.label,
    list: ws.list,
    candidates: m.workspaceCandidates,
    providers: m.providers,
    step: m.workspaceStep,
    busy: m.busy,
    use: (provider, path) => setupMachineWorkspace(m.id, { provider, path }),
    install: (provider, source) => setupMachineWorkspace(m.id, { provider, source }),
    detect: () => void detectMachineWorkspaces(m.id).then(refresh),
    refresh: () => (refresh(), ws.reload()),
  };
  const { side, setSide, added } = useSide(ws.list);
  const forwards = m.forwards ?? [];
  const picked = side.kind === "port" ? forwards.find((f) => f.id === side.id) : undefined;
  const portSide =
    side.kind === "add-port" ? (
      <AddPortPanel machine={m.id} where={m.label} forwards={forwards} onAdded={(f) => (setM((x) => ({ ...x, forwards: [...(x.forwards ?? []).filter((y) => y.id !== f.id), f].sort((p, q) => p.remotePort - q.remotePort) })), setSide({ kind: "port", id: f.id }))} />
    ) : picked ? (
      <PortPanel key={picked.id} machine={m.id} where={m.label} forward={picked} onGone={() => (setSide({ kind: "agent" }), refresh())} />
    ) : null;
  return (
    <div className="machine-page">
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
            <dd title={m.system ?? undefined}>{m.system ?? "—"}</dd>
          </div>
          <div>
            <dt>jin</dt>
            <dd className="mono" title={m.version ?? undefined}>
              {m.version ?? "—"}
            </dd>
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
          <WorkspaceList ctl={ctl} picked={side.kind === "workspace" ? side.id : null} adding={side.kind === "add"} onPick={(id) => setSide({ kind: "workspace", id })} onAdd={() => (setSide({ kind: "add" }), ctl.detect?.())} />
          {!m.attached && <PortList where={m.label} forwards={forwards} picked={side.kind === "port" ? side.id : null} adding={side.kind === "add-port"} onPick={(id) => setSide({ kind: "port", id })} onAdd={() => setSide({ kind: "add-port" })} />}
          <AgentSelector agents={ag.agents} error={ag.error} pick={side.kind === "agent" ? ag.pick : null} onPick={(id) => (ag.setPick(id), setSide({ kind: "agent" }))} name={m.label} />
          <Home machine={m} current={homeLabel} refresh={refresh} />
        </>
      )}
    </article>
    {/* Beside it on a wide screen: the picked coding agent's settings, a workspace or a port to manage, or adding one. */}
    {ready && (portSide ?? <SideFor side={side} ctl={ctl} onSide={setSide} added={added} agent={<AgentSide ag={ag} machine={m.id} name={m.label} />} />)}
    </div>
  );
}

/** The side panel for a machine's page: the agent picked in its main column, configured. */
function AgentSide({ ag, machine, name }: { ag: ReturnType<typeof useMachineAgents>; machine: string; name: string }) {
  const agent = ag.agents?.agents.find((a) => a.id === ag.pick);
  if (!agent || !ag.agents)
    return (
      <SidePanel title="Coding agent" meta={ag.error ? `could not read ${name}'s agents` : `looking for agents on ${name}…`}>
        {ag.error && <p className="machine-error">{ag.error}</p>}
      </SidePanel>
    );
  return <AgentPanel agent={agent} isDefault={ag.agents.default === agent.id} machine={machine} name={name} makeDefault={ag.makeDefault} />;
}

const localSignIns: SignInActions = { where: "this machine", start: startSetupSignIn, cancel: cancelSetupSignIn, code: submitSetupSignInCode };

/** This machine, laid out as a remote machine is: what it is, its sign-ins and workspaces, and its coding agents beside them. */
function LocalMachine() {
  const router = useRouter();
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [status, setStatus] = useState<{ version: string | null; system: string | null } | null>(null);
  const refresh = useCallback(() => {
    void getSetup().then((s) => (s && "auth" in s ? setSetup(s) : null));
    void getLocalStatus().then((s) => ("error" in s ? null : setStatus(s)));
  }, []);
  useEffect(() => refresh(), [refresh]);
  // A sign-in in progress reports its link and code as it goes; so does a workspace being installed.
  const waiting = (setup?.auth.some((a) => a.state === "waiting") ?? false) || setup?.install?.state === "running";
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [waiting, refresh]);
  const workspace = setup?.workspaces[0]?.root ?? null;
  const ag = useMachineAgents("local");
  const ctl: WorkspaceCtl = {
    machine: "local",
    where: "this machine",
    list: setup ? setup.workspaces : null,
    candidates: setup ? setup.candidates : null,
    providers: setup?.providers ?? [],
    step: setup?.install ?? null,
    busy: false,
    use: (provider, path) => adoptSetupWorkspace(path, provider),
    install: (provider, source) => installSetupWorkspace(provider, source),
    refresh,
  };
  const { side, setSide, added } = useSide(ctl.list);
  return (
    <div className="machine-page">
      <article className="machine-detail">
        <header className="md-head">
          <span className="md-icon">
            <Monitor size={16} />
          </span>
          <div className="md-title">
            <div className="md-name">
              <h2>This machine</h2>
            </div>
            <span className="meta">where this app and its daemon run</span>
          </div>
          <div className="md-actions">
            <button type="button" className="button small" onClick={() => router.push("/setup")}>
              <Wrench size={12} /> Set up jin
            </button>
          </div>
        </header>
        <dl className="md-facts">
          <div>
            <dt>System</dt>
            <dd>{status?.system ?? "—"}</dd>
          </div>
          <div>
            <dt>jin</dt>
            <dd className="mono">{status?.version ?? "—"}</dd>
          </div>
          <div>
            <dt>Daemon</dt>
            <dd>
              <span className={`machine-dot is-${status ? "ok" : "busy"}`} /> {status ? "running here" : "…"}
            </dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd className="md-ellipsis" title={workspace ?? undefined}>
              {setup ? (workspace ?? "none yet") : "—"}
            </dd>
          </div>
        </dl>
        <section className="md-card">
          <div className="md-card-head is-static">
            <h3>Sign-ins</h3>
            <span className="meta">on this machine</span>
            <button type="button" className="button small quiet md-card-action" onClick={() => void checkSetupAuth().then(refresh)} title="Check again">
              <RefreshCw size={12} />
            </button>
          </div>
          <ul className="machine-auths">
            {(setup?.auth ?? []).map((a) => (
              <SignIn key={a.tool} actions={localSignIns} auth={a} refresh={refresh} />
            ))}
          </ul>
        </section>
        <WorkspaceList ctl={ctl} picked={side.kind === "workspace" ? side.id : null} adding={side.kind === "add"} onPick={(id) => setSide({ kind: "workspace", id })} onAdd={() => setSide({ kind: "add" })} />
        <AgentSelector agents={ag.agents} error={ag.error} pick={side.kind === "agent" ? ag.pick : null} onPick={(id) => (ag.setPick(id), setSide({ kind: "agent" }))} name="this machine" />
      </article>
      <SideFor side={side} ctl={ctl} onSide={setSide} added={added} agent={<AgentSide ag={ag} machine="local" name="this machine" />} />
    </div>
  );
}

/** Remote machines: add one by its ssh host, watch it set up, sign in, and open it. */
export function Machines({ machines, selected }: { machines: Machine[]; selected: string | null }) {
  const router = useRouter();
  const [host, setHost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // "local": this machine (its own page: its coding agents and their settings).
  const [pick, setPick] = useState<string | null>(selected ?? machines[0]?.id ?? "local");
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
          <button type="button" className={`machines-item ${pick === "local" ? "is-selected" : ""}`} onClick={() => setPick("local")}>
            <Monitor size={14} />
            <span className="machines-item-name">This machine</span>
          </button>
          {machines.map((m) => {
            const s = machineState(m);
            return (
              <button key={m.id} type="button" className={`machines-item ${pick === m.id ? "is-selected" : ""}`} onClick={() => setPick(m.id)}>
                <span className={`machine-dot is-${s.tone}`} />
                <span className="machines-item-name">{m.label}</span>
                {m.home && <span className="machine-pill is-home">home</span>}
                <span className="meta">{s.label}</span>
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
          {pick === "local" ? (
            <LocalMachine />
          ) : chosen ? (
            <MachineDetail key={chosen.id} initial={chosen} homeLabel={machines.find((x) => x.home)?.label ?? "this machine"} onRemoved={() => (setPick(null), router.refresh())} />
          ) : (
            <Empty place="pane" icon={Server} title="Add a machine you reach with ssh">
              <p>A dev VM, a box under your desk: its tasks, Claude Code sessions and terminals run there, and keep running when this machine sleeps.</p>
            </Empty>
          )}
        </main>
      </div>
    </div>
  );
}
