"use client";
import { Check, FolderGit2, LoaderCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cancelSetupSignIn, checkSetupAuth, getSetup, installSetupWorkspace, startSetupSignIn, submitSetupSignInCode, adoptSetupWorkspace } from "@/app/actions";
import type { SetupState } from "@/lib/daemon";
import { SignIn, type SignInActions, Steps } from "./Machines";

const actions: SignInActions = {
  where: "this machine",
  start: startSetupSignIn,
  cancel: cancelSetupSignIn,
  code: submitSetupSignInCode,
};

/** First-run setup for this machine: a workspace, and gh and Claude Code signed in. */
export function Setup({ initial }: { initial: SetupState }) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void getSetup().then(setS, () => {});
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 1500);
    return () => clearInterval(t);
  }, []);
  const use = (p: string) =>
    void adoptSetupWorkspace(p).then((r) => {
      setError(r?.error ?? null);
      refresh();
      router.refresh();
    });
  const gh = s.auth.find((a) => a.tool === "gh");
  const installing = s.install?.state === "running";
  return (
    <div className="machines">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-name">Set up jin</span>
          <span className="meta">on this machine</span>
        </div>
        {s.ready && (
          <Link href="/" className="button small primary">
            Open jin
          </Link>
        )}
      </header>
      <div className="machines-body is-single" data-scroll="y">
        <main className="machines-main">
          <article className="machine-detail">
            <section className="md-card">
              <div className="md-card-head is-static">
                <h3>Workspace</h3>
                <span className="meta">where jin's coding agents work: every platform repo and the cws tooling</span>
              </div>
              <div className="md-card-body">
              {s.workspaces.map((w) => (
                <p key={w.id} className="setup-done">
                  <Check size={14} className="step-done" /> {w.id} at {w.root}
                </p>
              ))}
              {s.install && <Steps steps={[s.install]} />}
              {s.workspaces.length === 0 && !installing && (
                <div className="setup-options">
                  {s.candidates.map((c) => (
                    <div key={c} className="setup-option">
                      <FolderGit2 size={14} />
                      <span className="setup-option-path">{c}</span>
              {c === s.cws && <span className="meta setup-option-hint">cws uses this one</span>}
                      <button type="button" className="button small primary" onClick={() => use(c)}>
                        Use this one
                      </button>
                    </div>
                  ))}
                  <form
                    className="machine-inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      use(path);
                    }}
                  >
                    <input className="machine-input" value={path} onChange={(e) => setPath(e.target.value)} placeholder={s.candidates.length ? "or another folder: ~/somewhere/composio-workspace" : "~/composio-workspace"} spellCheck={false} />
                    <button type="submit" className="button small" disabled={!path.trim()}>
                      Use
                    </button>
                  </form>
                  <div className="machine-workspace-actions">
                    <button
                      type="button"
                      className="button small"
                      disabled={gh?.state !== "signed-in"}
                      onClick={() =>
                        void installSetupWorkspace().then((r) => {
                          setError(r?.error ?? null);
                          refresh();
                        })
                      }
                    >
                      Install it into ~/composio-workspace
                    </button>
                    {gh?.state !== "signed-in" && <span className="meta">Sign in to GitHub first: its repos are private.</span>}
                  </div>
                </div>
              )}
              {error && <p className="machine-error">{error}</p>}
              </div>
            </section>
            <section className="md-card">
              <div className="md-card-head is-static">
                <h3>Sign-ins</h3>
                <span className="meta">signing in opens your browser; any code shows here</span>
                <button type="button" className="button small quiet md-card-action" onClick={() => void checkSetupAuth().then(refresh)} title="Check again">
                  <RefreshCw size={12} />
                </button>
              </div>
              <ul className="machine-auths">
                {s.auth.map((a) => (
                  <SignIn key={a.tool} actions={actions} auth={a} refresh={refresh} />
                ))}
              </ul>
            </section>
            {s.ready ? (
              <p className="setup-done">
                <Check size={14} className="step-done" /> jin is ready.{" "}
                <Link href="/" className="machine-link">
                  Open it
                </Link>
              </p>
            ) : (
              <p className="meta setup-done">
                {installing ? <LoaderCircle size={12} className="spin" /> : null}
                {s.workspaces.length === 0 ? "Pick a workspace" : "Sign in to GitHub and Claude Code"} to finish.
              </p>
            )}
          </article>
        </main>
      </div>
    </div>
  );
}
