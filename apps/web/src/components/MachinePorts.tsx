"use client";

import { SidePanel } from "@/components/MachineAgents";
import { ArrowRight, ChevronRight, EthernetPort, ExternalLink, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { addPortForward, listListening, removePortForward } from "@/lib/actions";
import type { ListeningPort, PortForward } from "@/lib/daemon";

const dot = (s: PortForward["state"]) => (s === "up" ? "ok" : s === "connecting" ? "busy" : "bad");
const stateLabel = (f: PortForward) => (f.state === "up" ? "forwarding" : f.state === "connecting" ? "connecting" : "down");
const url = (f: PortForward) => `http://localhost:${f.localPort}`;
const base = (path: string | null) => path?.split("/").filter(Boolean).pop() ?? null;
/** What a listener is, in a few words: its process and the folder it runs in. */
const describe = (l: ListeningPort) => [l.process, base(l.folder)].filter(Boolean).join(" · ") || null;

/** The main column's list of a machine's forwarded ports; picked to manage one in the side panel, Add to forward another. */
export function PortList({ where, forwards, picked, adding, onPick, onAdd }: { where: string; forwards: PortForward[]; picked: string | null; adding: boolean; onPick: (id: string) => void; onAdd: () => void }) {
  return (
    <section className="md-card">
      <div className="md-card-head is-static">
        <h3>Ports</h3>
        <span className="meta">{forwards.length ? `${where}'s ports, on this machine's localhost` : `reach ${where}'s dev servers here`}</span>
        <button type="button" className={`button small quiet md-card-action ${adding ? "is-picked" : ""}`} onClick={onAdd} title={`Forward a port of ${where}`}>
          <Plus size={12} /> Forward
        </button>
      </div>
      <div className="md-card-body">
        {!forwards.length && (
          <button type="button" className="ws-empty" onClick={onAdd}>
            No ports forwarded. Forward a port of {where} (a dev server, a database) to open it on this machine.
          </button>
        )}
        {forwards.length > 0 && (
          <ul className="ws-list">
            {forwards.map((f) => (
              <li key={f.id} className="pf-item">
                <button type="button" className={`ws-row pf-row ${picked === f.id ? "is-picked" : ""}`} onClick={() => onPick(f.id)} aria-pressed={picked === f.id}>
                  <span className={`machine-dot is-${dot(f.state)}`} title={f.error ?? stateLabel(f)} />
                  <span className="ws-name mono">localhost:{f.localPort}</span>
                  <span className="pf-to">
                    <ArrowRight size={11} /> {where}:{f.remotePort}
                  </span>
                  <span className="ws-root pf-label">{f.error ?? f.label ?? ""}</span>
                  <ChevronRight size={13} className="ws-chevron" aria-hidden />
                </button>
                <a className="button small quiet icon-only pf-open" href={url(f)} target="_blank" rel="noreferrer" title={`Open ${url(f)}`} aria-label={`Open localhost:${f.localPort}`}>
                  <ExternalLink size={12} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** The side panel for one forwarded port: where it goes, whether it is up, and stopping it. */
export function PortPanel({ machine, where, forward: f, onGone }: { machine: string; where: string; forward: PortForward; onGone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [f.id]);
  const stop = () => {
    setBusy(true);
    void removePortForward(machine, f.remotePort).then((r) => {
      setBusy(false);
      if (r?.error) return setError(r.error);
      onGone();
    });
  };
  return (
    <SidePanel
      title={`localhost:${f.localPort}`}
      badge={<span className={`machine-pill is-${f.state === "up" ? "ok" : f.state === "connecting" ? "busy" : "bad"}`}>{stateLabel(f)}</span>}
      meta={`${where}'s port ${f.remotePort}${f.label ? ` · ${f.label}` : ""}`}
      actions={
        <>
          <a className="button small" href={url(f)} target="_blank" rel="noreferrer" title={`Open ${url(f)} in your browser`}>
            <ExternalLink size={12} /> Open
          </a>
          <button type="button" className="button small quiet icon-only" onClick={stop} disabled={busy} title="Stop forwarding" aria-label="Stop forwarding">
            {busy ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}
          </button>
        </>
      }
    >
      {error && <p className="machine-error">{error}</p>}
      {f.error && <p className="machine-notice is-danger">{f.error}</p>}
      <section className="md-card">
        <div className="md-card-head is-static">
          <h3>Where</h3>
        </div>
        <div className="md-card-body">
          <dl className="ws-facts pf-facts">
            <div>
              <dt>Here</dt>
              <dd className="mono">
                <a href={url(f)} target="_blank" rel="noreferrer">
                  localhost:{f.localPort}
                </a>
              </dd>
            </div>
            <div>
              <dt>On {where}</dt>
              <dd className="mono">localhost:{f.remotePort}</dd>
            </div>
            <div>
              <dt>Line</dt>
              <dd>
                <span className={`machine-dot is-${dot(f.state)}`} /> {f.state === "up" ? "ssh, reopened when it drops" : stateLabel(f)}
              </dd>
            </div>
          </dl>
          <p className="meta pf-note">Only this machine can reach it (loopback). It comes back whenever jin starts.</p>
        </div>
      </section>
    </SidePanel>
  );
}

/** The side panel for forwarding a port: what listens on the machine, or any port by number. */
export function AddPortPanel({ machine, where, forwards, onAdded }: { machine: string; where: string; forwards: PortForward[]; onAdded: (f: PortForward) => void }) {
  const [found, setFound] = useState<ListeningPort[] | null>(null);
  const [lookError, setLookError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | "form" | null>(null);
  const [remote, setRemote] = useState("");
  const [local, setLocal] = useState("");
  const [label, setLabel] = useState("");
  const look = useCallback(() => {
    setFound(null);
    setLookError(null);
    void listListening(machine).then((r) => ("error" in r ? (setLookError(r.error), setFound([])) : setFound(r)));
  }, [machine]);
  useEffect(look, [look]);
  const forwarded = new Map(forwards.map((f) => [f.remotePort, f]));
  const add = (key: number | "form", o: { remotePort: number; localPort?: number | null; label?: string | null }) => {
    setBusy(key);
    setError(null);
    void addPortForward(machine, o).then((r) => {
      setBusy(null);
      if ("error" in r) return setError(r.error);
      if (key === "form") (setRemote(""), setLocal(""), setLabel(""));
      onAdded(r);
    });
  };
  const remotePort = Number(remote);
  const validRemote = Number.isInteger(remotePort) && remotePort > 0 && remotePort < 65536;
  return (
    <SidePanel
      title="Forward a port"
      meta={`a port of ${where}, opened on this machine's localhost`}
      actions={
        <button type="button" className="button small quiet icon-only" onClick={look} disabled={found === null} title="Look again" aria-label="Look again">
          <RefreshCw size={12} />
        </button>
      }
    >
      {error && <p className="machine-error">{error}</p>}
      <section className="md-card">
        <div className="md-card-head is-static">
          <h3>Listening on {where}</h3>
        </div>
        <div className="md-card-body setup-options">
          {found === null && (
            <p className="meta">
              <LoaderCircle size={12} className="spin" /> Looking…
            </p>
          )}
          {lookError && <p className="machine-error">{lookError}</p>}
          {found && !found.length && !lookError && <p className="meta">Nothing listens on a port above 1024 there.</p>}
          {found?.map((l) => {
            const f = forwarded.get(l.port);
            return (
              <div key={l.port} className="setup-option">
                <EthernetPort size={14} />
                <span className="setup-option-path mono">{l.port}</span>
                <span className="meta setup-option-hint" title={l.folder ?? undefined}>
                  {describe(l) ?? "run by another user"}
                </span>
                {f ? (
                  <span className="meta">on localhost:{f.localPort}</span>
                ) : (
                  <button type="button" className="button small primary" disabled={busy !== null} onClick={() => add(l.port, { remotePort: l.port, label: base(l.folder) ?? l.process })}>
                    {busy === l.port ? <LoaderCircle size={12} className="spin" /> : "Forward"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <section className="md-card">
        <div className="md-card-head is-static">
          <h3>Another port</h3>
          <span className="meta">one not listening yet works too</span>
        </div>
        <div className="md-card-body">
          <form
            className="machine-inline-form pf-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (validRemote) add("form", { remotePort, localPort: local.trim() ? Number(local) : null, label: label.trim() || null });
            }}
          >
            <input className="machine-input pf-port" value={remote} onChange={(e) => setRemote(e.target.value.replace(/\D/g, ""))} placeholder={`${where} port`} inputMode="numeric" aria-label={`Port on ${where}`} />
            <ArrowRight size={12} className="pf-arrow" aria-hidden />
            <input className="machine-input pf-port" value={local} onChange={(e) => setLocal(e.target.value.replace(/\D/g, ""))} placeholder={remote ? `here: ${remote}` : "here: same"} inputMode="numeric" aria-label="Port on this machine (empty: the same, or the next free one)" />
            <input className="machine-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="name (optional)" aria-label="Name" maxLength={60} />
            <button type="submit" className="button small" disabled={!validRemote || busy !== null}>
              {busy === "form" ? <LoaderCircle size={12} className="spin" /> : "Forward"}
            </button>
          </form>
        </div>
      </section>
    </SidePanel>
  );
}
