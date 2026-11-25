"use client";

import { SidePanel } from "@/components/MachineAgents";
import { InstallOptions, Steps } from "@/components/Machines";
import { Boxes, ChevronRight, FolderGit2, GitBranch, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { forgetWorkspace, listWorkspaces, workspaceRepos } from "@/lib/actions";
import type { DetectedWorkspace, MachineStep, Repo, WorkspaceProviderView } from "@/lib/daemon";

export type WorkspaceRow = { id: string; root: string; adapter: string };

/** What a machine's page knows of its workspaces, and how to add one, for this machine or a remote one alike. */
export interface WorkspaceCtl {
  /** "local" or a machine's id. */
  machine: string;
  /** How the machine is named in text ("this machine", "d-jin"). */
  where: string;
  list: WorkspaceRow[] | null;
  candidates: DetectedWorkspace[] | null;
  providers: WorkspaceProviderView[];
  step: MachineStep | null;
  busy: boolean;
  use: (provider: string, path: string) => Promise<{ error: string } | null>;
  install: (provider: string, source?: string) => Promise<{ error: string } | null>;
  detect?: () => void;
  refresh: () => void;
}

/** A machine's workspaces, read from its daemon, again whenever `key` changes (a workspace added or forgotten). */
export function useWorkspaceList(machine: string, enabled: boolean, key: unknown): { list: WorkspaceRow[] | null; reload: () => void } {
  const [list, setList] = useState<WorkspaceRow[] | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void listWorkspaces(machine).then((r) => live && setList("error" in r ? [] : r));
    return () => {
      live = false;
    };
  }, [machine, enabled, key, n]);
  return { list, reload: () => setN((x) => x + 1) };
}

const isRepo = (w: { adapter: string }) => w.adapter === "git";
const kindLabel = (ctl: WorkspaceCtl, adapter: string) => ctl.providers.find((p) => p.id === adapter)?.label ?? adapter;

/** The main column's list: each workspace and git repo, picked to manage it in the side panel; Add opens adding one there. */
export function WorkspaceList({ ctl, picked, onPick, onAdd, adding }: { ctl: WorkspaceCtl; picked: string | null; onPick: (id: string) => void; onAdd: () => void; adding: boolean }) {
  const running = ctl.step?.state === "running";
  const list = ctl.list ?? [];
  return (
    <section className="md-card">
      <div className="md-card-head is-static">
        <h3>Workspaces</h3>
        <span className="meta">{list.length ? "pick one to manage it" : `jin's tasks on ${ctl.where} run in one`}</span>
        <button type="button" className={`button small quiet md-card-action ${adding ? "is-picked" : ""}`} onClick={onAdd} title="Add a workspace or git repo">
          <Plus size={12} /> Add
        </button>
      </div>
      <div className="md-card-body">
        {ctl.list === null && (
          <p className="meta">
            <LoaderCircle size={12} className="spin" /> Reading {ctl.where}&apos;s workspaces…
          </p>
        )}
        {ctl.list !== null && !list.length && !running && (
          <button type="button" className="ws-empty" onClick={onAdd}>
            No workspace yet. Add a workspace, or a git repo, to run tasks in.
          </button>
        )}
        {list.length > 0 && (
          <ul className="ws-list">
            {list.map((w) => {
              const Icon = isRepo(w) ? FolderGit2 : Boxes;
              return (
                <li key={w.id}>
                  <button type="button" className={`ws-row ${picked === w.id ? "is-picked" : ""}`} onClick={() => onPick(w.id)} aria-pressed={picked === w.id}>
                    <Icon size={14} className="ws-icon" />
                    <span className="ws-name">{w.id}</span>
                    <span className="ws-kind">{kindLabel(ctl, w.adapter)}</span>
                    <span className="ws-root" title={w.root}>
                      {w.root}
                    </span>
                    <ChevronRight size={13} className="ws-chevron" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {running && ctl.step && (
          <div className="ws-installing">
            <Steps steps={[ctl.step]} />
          </div>
        )}
      </div>
    </section>
  );
}

/** The side panel for one workspace: where it is, its repos, and stopping using it. */
export function WorkspacePanel({ ctl, row, onGone }: { ctl: WorkspaceCtl; row: WorkspaceRow; onGone: () => void }) {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRepos(null);
    setRepoError(null);
    setArmed(false);
    setError(null);
    let live = true;
    void workspaceRepos(ctl.machine, row.id).then((r) => {
      if (!live) return;
      if ("error" in r) setRepoError(r.error);
      else setRepos(r);
    });
    return () => {
      live = false;
    };
  }, [ctl.machine, row.id]);
  const forget = () => {
    if (!armed) return setArmed(true);
    setBusy(true);
    void forgetWorkspace(ctl.machine, row.id).then((r) => {
      setBusy(false);
      setArmed(false);
      if (r?.error) return setError(r.error);
      onGone();
    });
  };
  const repo = isRepo(row);
  return (
    <SidePanel
      title={row.id}
      badge={<span className="machine-pill">{kindLabel(ctl, row.adapter)}</span>}
      meta={`on ${ctl.where}`}
      actions={
        <button type="button" className={`button small quiet icon-only ${armed ? "is-armed" : ""}`} onClick={forget} disabled={busy} title={armed ? "Click again: jin stops using it (its files stay)" : "Stop using this workspace"} aria-label="Stop using this workspace">
          {busy ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}
        </button>
      }
    >
      {armed && <p className="machine-notice is-danger">Click the bin again: jin stops using {row.id}. Its files stay at {row.root}; add it again any time.</p>}
      {error && <p className="machine-error">{error}</p>}
      <section className="md-card">
        <div className="md-card-head is-static">
          <h3>Where</h3>
        </div>
        <div className="md-card-body">
          <dl className="ws-facts">
            <div>
              <dt>Path</dt>
              <dd className="mono" title={row.root}>
                {row.root}
              </dd>
            </div>
            <div>
              <dt>Kind</dt>
              <dd>{kindLabel(ctl, row.adapter)}</dd>
            </div>
          </dl>
        </div>
      </section>
      <section className="md-card">
        <div className="md-card-head is-static">
          <h3>{repo ? "Repo" : "Repos"}</h3>
          {repos && !repo && <span className="meta">{repos.length}</span>}
        </div>
        <div className="md-card-body">
          {!repos && !repoError && (
            <p className="meta">
              <LoaderCircle size={12} className="spin" /> Reading its repos…
            </p>
          )}
          {repoError && <p className="machine-error">{repoError}</p>}
          {repos && !repos.length && <p className="meta">No repos found.</p>}
          {repos && repos.length > 0 && (
            <ul className="ws-repos">
              {repos.map((r) => (
                <li key={r.path} title={r.description || r.path}>
                  <span className="ws-repo-name">{r.name}</span>
                  {r.branch && (
                    <span className="ws-repo-branch">
                      <GitBranch size={11} /> {r.branch}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </SidePanel>
  );
}

/** What can be installed: not a workspace already in use where it installs to (a clone names its own folder). */
const installable = (ctl: WorkspaceCtl) =>
  ctl.providers.filter((p) => p.source || !p.installsTo || !(ctl.list ?? []).some((w) => w.adapter === p.id && w.root.endsWith(p.installsTo!.replace(/^~/, ""))));

/** The side panel for adding one: what was found on the machine, installing one, cloning a git repo, or a path. */
export function AddWorkspacePanel({ ctl, onAdded }: { ctl: WorkspaceCtl; onAdded: () => void }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState(ctl.providers[0]?.id ?? "");
  const running = ctl.step?.state === "running";
  const looking = ctl.candidates === null;
  const found = ctl.candidates ?? [];
  const done = (r: { error: string } | null) => {
    setError(r?.error ?? null);
    ctl.refresh();
    if (!r?.error) onAdded();
  };
  return (
    <SidePanel
      title="Add a workspace"
      meta={`a workspace or git repo on ${ctl.where} for tasks to run in`}
      actions={
        ctl.detect && !running ? (
          <button type="button" className="button small quiet icon-only" onClick={ctl.detect} title="Look again" aria-label="Look again">
            <RefreshCw size={12} />
          </button>
        ) : undefined
      }
    >
      {error && <p className="machine-error">{error}</p>}
      {ctl.step && (running || ctl.step.state === "failed") && (
        <section className="md-card">
          <div className="md-card-body">
            <Steps steps={[ctl.step]} />
          </div>
        </section>
      )}
      <section className="md-card">
        <div className="md-card-head is-static">
          <h3>Found on {ctl.where}</h3>
        </div>
        <div className="md-card-body setup-options">
          {looking && (
            <p className="meta">
              <LoaderCircle size={12} className="spin" /> Looking…
            </p>
          )}
          {!looking && !found.length && <p className="meta">Nothing jin does not use already.</p>}
          {found.map((c) => (
            <div key={c.root} className="setup-option">
              <FolderGit2 size={14} />
              <span className="setup-option-path" title={c.root}>
                {c.root}
              </span>
              <span className="meta setup-option-hint">{kindLabel(ctl, c.provider)}</span>
              <button type="button" className="button small primary" disabled={ctl.busy || running} onClick={() => void ctl.use(c.provider, c.root).then(done)}>
                Use
              </button>
            </div>
          ))}
        </div>
      </section>
      <section className="md-card">
        <div className="md-card-head is-static">
          <h3>Install or clone</h3>
        </div>
        <div className="md-card-body setup-options">
          <InstallOptions providers={installable(ctl)} disabled={ctl.busy || running} onInstall={(id, source) => void ctl.install(id, source).then(done)} />
        </div>
      </section>
      <section className="md-card">
        <div className="md-card-head is-static">
          <h3>Somewhere else</h3>
        </div>
        <div className="md-card-body">
          <form
            className="machine-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void ctl.use(kind, path.trim()).then((r) => {
                if (!r?.error) setPath("");
                done(r);
              });
            }}
          >
            {ctl.providers.length > 1 && (
              <select className="machine-input ws-kind-select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind of workspace">
                {ctl.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
            <input className="machine-input" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/path/to/a/workspace or repo" spellCheck={false} />
            <button type="submit" className="button small" disabled={!path.trim() || ctl.busy || running}>
              Use
            </button>
          </form>
        </div>
      </section>
    </SidePanel>
  );
}
