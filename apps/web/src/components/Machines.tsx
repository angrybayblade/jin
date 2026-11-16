"use client";
import { Check, Circle, Copy, ExternalLink, LoaderCircle, Monitor, Plus, RefreshCw, Server, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  addMachine,
  cancelMachineSignIn,
  checkMachineAuth,
  getMachine,
  removeMachine,
  rerunMachineSetup,
  setMachineDopplerToken,
  setupMachineWorkspace,
  startMachineSignIn,
  submitMachineSignInCode,
  switchMachine,
} from "@/app/actions";
import type { Machine, MachineAuth, MachineStep } from "@/lib/daemon";
import { useArmedConfirm } from "@/lib/confirm";

const TOOL_NAME: Record<MachineAuth["tool"], string> = { gh: "GitHub (gh)", claude: "Claude Code", doppler: "Doppler" };
const TOOL_WHY: Record<MachineAuth["tool"], string> = {
  gh: "Clones the workspace's private repos; PRs and checks.",
  claude: "Runs Claude Code and jin's chats there.",
  doppler: "Optional: only cws up (the local stack) needs it.",
};

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

function Steps({ steps }: { steps: MachineStep[] }) {
  return (
    <ol className="machine-steps">
      {steps.map((s) => (
        <li key={s.id} className={`machine-step is-${s.state}`}>
          <StepIcon state={s.state} />
          <div className="machine-step-body">
            <span>{s.label}</span>
            {s.error && <p className="machine-error">{s.error}</p>}
            {s.log.length > 0 && (s.state === "running" || s.state === "failed") && <pre className="machine-log">{s.log.slice(-8).join("\n")}</pre>}
            {s.log.length > 0 && s.state === "done" && (
              <details>
                <summary className="meta">{s.log.at(-1)}</summary>
                <pre className="machine-log">{s.log.join("\n")}</pre>
              </details>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function CopyButton({ text }: { text: string }) {
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

function SignIn({ machine, auth, refresh }: { machine: Machine; auth: MachineAuth; refresh: () => void }) {
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
          <span>{TOOL_NAME[auth.tool]}</span>
          <span className="meta">
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
                      : TOOL_WHY[auth.tool]}
          </span>
        </div>
        {auth.state === "waiting" ? (
          <button type="button" className="button small quiet" onClick={() => act(cancelMachineSignIn(machine.id, auth.tool))}>
            Cancel
          </button>
        ) : (
          auth.state !== "missing" &&
          auth.state !== "unknown" && (
            <button type="button" className={`button small ${signedIn ? "quiet" : ""}`} onClick={() => act(startMachineSignIn(machine.id, auth.tool))}>
              {signedIn ? "Sign in again" : "Sign in"}
            </button>
          )
        )}
      </div>
      {auth.state === "waiting" && !auth.url && (
        <p className="meta machine-auth-body">
          <LoaderCircle size={12} className="spin" /> Starting the sign-in on {machine.label}…
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
                void submitMachineSignInCode(machine.id, auth.tool, code).then((r) => {
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
      {auth.tool === "doppler" && !signedIn && auth.state !== "missing" && (
        <div className="machine-auth-body">
          {showToken ? (
            <form
              className="machine-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void setMachineDopplerToken(machine.id, token).then((r) => {
                  if (r) setError(r.error);
                  else {
                    setToken("");
                    setShowToken(false);
                  }
                  refresh();
                });
              }}
            >
              <input className="machine-input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="dp.st.dev.…" autoComplete="off" />
              <button type="submit" className="button small primary" disabled={!token.trim()}>
                Save
              </button>
            </form>
          ) : (
            <button type="button" className="button small quiet" onClick={() => setShowToken(true)}>
              Use a service token instead
            </button>
          )}
        </div>
      )}
      {error && <p className="machine-error machine-auth-body">{error}</p>}
    </li>
  );
}

function Workspace({ machine, refresh }: { machine: Machine; refresh: () => void }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const step = machine.workspaceStep;
  const gh = machine.auth.find((a) => a.tool === "gh");
  const go = (p?: string) =>
    void setupMachineWorkspace(machine.id, p).then((r) => {
      setError(r?.error ?? null);
      refresh();
    });
  return (
    <section className="machine-section">
      <h3>Workspace</h3>
      {machine.workspace && step?.state !== "running" && <p className="meta">composio workspace at {machine.workspace}</p>}
      {step && <Steps steps={[step]} />}
      {!machine.workspace && step?.state !== "running" && (
        <div className="machine-workspace-actions">
          <button type="button" className="button small primary" disabled={machine.busy || gh?.state !== "signed-in"} onClick={() => go()} title={gh?.state !== "signed-in" ? "Sign in to GitHub first: the repos are private" : undefined}>
            Install the composio workspace
          </button>
          <span className="meta">or use one already there:</span>
          <form
            className="machine-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              go(path);
            }}
          >
            <input className="machine-input" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/composio-workspace" spellCheck={false} />
            <button type="submit" className="button small" disabled={!path.trim() || machine.busy}>
              Use
            </button>
          </form>
        </div>
      )}
      {!machine.workspace && gh?.state !== "signed-in" && <p className="meta">Sign in to GitHub first: the workspace's repos are private.</p>}
      {error && <p className="machine-error">{error}</p>}
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
  return (
    <article className="machine-detail">
      <header className="machine-detail-head">
        <Server size={18} />
        <div className="machine-detail-title">
          <h2>{m.label}</h2>
          <span className="meta">
            ssh {m.host}
            {m.system ? ` · ${m.system}` : ""}
            {m.version ? ` · jin ${m.version}` : ""}
          </span>
        </div>
        <span className={`machine-pill is-${state.tone}`}>{state.label}</span>
      </header>
      <div className="machine-actions">
        {m.connected && !current && (
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
            Open {m.label}
          </button>
        )}
        {current && <span className="meta">You're on this machine</span>}
        <button type="button" className="button small" disabled={m.busy} onClick={() => void rerunMachineSetup(m.id).then(refresh)} title="Runs every step again; also updates jin there to this jin's commit">
          <RefreshCw size={12} /> {ready ? "Update jin there" : "Run setup again"}
        </button>
        <button type="button" className={`button small quiet ${remove.armed ? "is-armed" : ""}`} onClick={remove.onClick}>
          <Trash2 size={12} /> {remove.armed ? "Stop jin there and forget it?" : "Forget"}
        </button>
      </div>
      {m.outdated && !m.busy && (
        <p className="machine-notice">
          {m.label} runs jin {m.version}; this machine runs a newer one. <strong>Update jin there</strong> copies it over and restarts it (Claude Code sessions there resume).
        </p>
      )}
      <section className="machine-section">
        <h3>Setup</h3>
        <Steps steps={m.steps} />
      </section>
      {ready && (
        <>
          <section className="machine-section">
            <div className="machine-section-head">
              <h3>Sign-ins</h3>
              <button type="button" className="button small quiet" onClick={() => void checkMachineAuth(m.id).then(refresh)}>
                <RefreshCw size={12} /> Check
              </button>
            </div>
            <p className="meta">Each runs on {m.label} and gives you a link and a code for your browser. jin copies no credentials across.</p>
            <ul className="machine-auths">
              {m.auth.map((a) => (
                <SignIn key={a.tool} machine={m} auth={a} refresh={refresh} />
              ))}
            </ul>
          </section>
          <Workspace machine={m} refresh={refresh} />
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
