"use client";
import { Check, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { getLive, liveConnect, liveLinearTeams, liveListener, liveLogin, liveProjects, liveSetEvent, liveUseProject } from "@/lib/actions";
import type { LiveStatus } from "@/lib/daemon";

const NAME: Record<string, string> = { slack: "Slack", linear: "Linear", notion: "Notion", gmail: "Gmail", github: "GitHub" };
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
const open = (url: string) => void window.open(url, "_blank", "noopener");

function Dot({ tone }: { tone: "ok" | "busy" | "bad" | "idle" }) {
  return <span className={`machine-dot is-${tone}`} />;
}

/** Composio sign-in, and which org and project jin's triggers live in. */
function Account({ s, refresh }: { s: LiveStatus; refresh: () => void }) {
  const [projects, setProjects] = useState<{ orgId: string; org: string; projects: { id: string; name: string }[] }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signIn = async () => {
    setBusy(true);
    const r = await liveLogin();
    setBusy(false);
    if ("error" in r) setError(r.error);
    else open(r.url);
    refresh();
  };
  const choose = async () => {
    const r = await liveProjects();
    if ("error" in r) setError(r.error);
    else setProjects(r);
  };
  return (
    <section className="md-card">
      <div className="md-card-head is-static">
        <h3>Composio</h3>
        <span className="meta">{s.signedIn ? `${s.email} · ${s.org ?? ""}` : "sign in on the home, once"}</span>
        {s.signedIn && (
          <button type="button" className="button small quiet md-card-action" onClick={() => void choose()}>
            {s.project ? "Change project" : "Choose project"}
          </button>
        )}
      </div>
      <ul className="machine-auths">
        <li className="machine-auth">
          <div className="machine-auth-head">
            <Dot tone={s.signedIn ? "ok" : s.login.state === "waiting" ? "busy" : "idle"} />
            <div className="machine-auth-name">
              <span className="machine-auth-tool">Sign-in</span>
              <span className="meta machine-auth-state">{s.signedIn ? "signed in" : s.login.state === "waiting" ? "waiting for you in the browser…" : s.installed ? "not signed in" : "composio CLI is not installed on the home"}</span>
            </div>
            {!s.signedIn && s.installed && (
              <button type="button" className="button small" disabled={busy} onClick={() => void signIn()}>
                {s.login.state === "waiting" ? "Open again" : "Sign in"}
              </button>
            )}
          </div>
        </li>
        <li className="machine-auth">
          <div className="machine-auth-head">
            <Dot tone={s.project ? "ok" : "idle"} />
            <div className="machine-auth-name">
              <span className="machine-auth-tool">Project</span>
              <span className="meta machine-auth-state">{s.project ? `${s.project.name} · as user ${s.userId}` : "none yet"}</span>
            </div>
          </div>
          {projects && (
            <div className="machine-auth-body">
              {projects.map((o) => (
                <div key={o.orgId} className="live-projects">
                  <span className="meta">{o.org}</span>
                  {o.projects.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`button small ${s.project?.id === p.id ? "primary" : "quiet"}`}
                      onClick={() =>
                        void liveUseProject(o.orgId, p.id, p.name).then((r) => {
                          setError(r?.error ?? null);
                          setProjects(null);
                          refresh();
                        })
                      }
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </li>
      </ul>
      {error && <p className="machine-error home-error">{error}</p>}
    </section>
  );
}

function Accounts({ s, refresh }: { s: LiveStatus; refresh: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="md-card">
      <div className="md-card-head is-static">
        <h3>Accounts</h3>
        <span className="meta">connected to the {s.project?.name ?? ""} project as {s.userId}</span>
        <button type="button" className="button small quiet md-card-action" onClick={refresh} title="Check again">
          <RefreshCw size={12} />
        </button>
      </div>
      <ul className="machine-auths">
        {s.accounts.map((a) => {
          const ok = a.status === "ACTIVE";
          return (
            <li key={a.toolkit} className="machine-auth">
              <div className="machine-auth-head">
                <Dot tone={ok ? "ok" : a.status ? "bad" : "idle"} />
                <div className="machine-auth-name">
                  <span className="machine-auth-tool">{NAME[a.toolkit] ?? a.toolkit}</span>
                  <span className="meta machine-auth-state">{ok ? "connected" : a.status ? a.status.toLowerCase() : "not connected"}</span>
                </div>
                <button
                  type="button"
                  className={`button small ${ok ? "quiet" : ""}`}
                  onClick={() =>
                    void liveConnect(a.toolkit).then((r) => {
                      if ("error" in r) setError(r.error);
                      else open(r.url);
                    })
                  }
                >
                  {ok ? "Reconnect" : "Connect"} <ExternalLink size={11} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {error && <p className="machine-error home-error">{error}</p>}
    </section>
  );
}

function LinearTeams({ chosen, onSave }: { chosen: string[]; onSave: (ids: string[]) => void }) {
  const [teams, setTeams] = useState<{ id: string; name: string; key: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState(new Set(chosen));
  const [q, setQ] = useState("");
  useEffect(() => {
    void liveLinearTeams().then((r) => ("error" in r ? setError(r.error) : setTeams(r)));
  }, []);
  if (error) return <p className="machine-error">{error}</p>;
  if (!teams)
    return (
      <p className="meta setup-done">
        <LoaderCircle size={12} className="spin" /> Loading your Linear teams…
      </p>
    );
  const shown = teams.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="live-teams">
      <input className="machine-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${teams.length} teams`} />
      <div className="live-team-list" data-scroll="y">
        {shown.map((t) => (
          <label key={t.id} className="live-team">
            <input
              type="checkbox"
              checked={pick.has(t.id)}
              onChange={() =>
                setPick((p) => {
                  const n = new Set(p);
                  if (n.has(t.id)) n.delete(t.id);
                  else n.add(t.id);
                  return n;
                })
              }
            />
            <span>{t.name}</span>
          </label>
        ))}
      </div>
      <button type="button" className="button small primary" disabled={!pick.size} onClick={() => onSave([...pick])}>
        Watch {pick.size} team{pick.size === 1 ? "" : "s"}
      </button>
    </div>
  );
}

function Events({ s, refresh }: { s: LiveStatus; refresh: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState(false);
  const set = async (kind: string, on: boolean, linearTeams?: string[]) => {
    setBusy(kind);
    setError(null);
    const r = await liveSetEvent(kind, on, linearTeams);
    setBusy(null);
    if (r) setError(r.error);
    refresh();
  };
  const connected = new Set(s.accounts.filter((a) => a.status === "ACTIVE").map((a) => a.toolkit));
  return (
    <section className="md-card">
      <div className="md-card-head is-static">
        <h3>Events</h3>
        <span className="meta">each goes to the feed and its desk; ones for you also notify</span>
      </div>
      <ul className="machine-auths">
        {s.events.map((e) => (
          <li key={e.kind} className="machine-auth">
            <div className="machine-auth-head">
              <label className="live-switch">
                <input
                  type="checkbox"
                  checked={e.on}
                  disabled={busy !== null || (!e.native && !connected.has(e.toolkit))}
                  onChange={() => (e.kind === "linear" && !e.on ? setTeams(true) : void set(e.kind, !e.on))}
                />
                <span className="live-switch-track" />
              </label>
              <div className="machine-auth-name">
                <span className="machine-auth-tool">{e.label}</span>
                <span className="meta machine-auth-state">
                  {busy === e.kind
                    ? "updating…"
                    : e.native
                      ? e.on
                        ? s.github?.error
                          ? `gh: ${s.github.error}`
                          : `watching ${e.triggers} PR${e.triggers === 1 ? "" : "s"} with gh${s.github?.lastCheck ? `, checked ${ago(s.github.lastCheck)} ago` : ""}`
                        : "with gh on the home, every 2 minutes"
                      : !connected.has(e.toolkit)
                        ? `connect ${NAME[e.toolkit]} first`
                        : e.on
                          ? `${e.triggers} trigger${e.triggers === 1 ? "" : "s"} on`
                          : ""}
                </span>
              </div>
              {e.kind === "linear" && e.on && (
                <button type="button" className="button small quiet" onClick={() => setTeams((v) => !v)}>
                  {s.linearTeams.length} team{s.linearTeams.length === 1 ? "" : "s"}
                </button>
              )}
            </div>
            {e.kind === "linear" && teams && (
              <div className="machine-auth-body">
                <LinearTeams
                  chosen={s.linearTeams}
                  onSave={(ids) => {
                    setTeams(false);
                    void set("linear", true, ids);
                  }}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="machine-error home-error">{error}</p>}
    </section>
  );
}

function Listener({ s, refresh }: { s: LiveStatus; refresh: () => void }) {
  const tone = s.listener.state === "running" ? "ok" : s.listener.state === "starting" ? "busy" : s.listener.state === "down" ? "bad" : "idle";
  return (
    <section className="md-card">
      <div className="md-card-head is-static">
        <h3>Listening</h3>
        <span className="meta">
          <Dot tone={tone} /> {s.listener.state}
          {s.listener.since && s.listener.state === "running" ? ` since ${ago(s.listener.since)} ago` : ""}
        </span>
        <button type="button" className="button small quiet md-card-action" onClick={() => void liveListener(true).then(refresh)} title="Restart the listener">
          <RefreshCw size={12} />
        </button>
      </div>
      {s.listener.error && <p className="machine-error home-error">{s.listener.error}</p>}
      {s.recent.length === 0 ? (
        <p className="meta live-empty">No events yet. They show here as they arrive.</p>
      ) : (
        <ul className="live-events">
          {s.recent.map((e) => (
            <li key={e.id} className={`live-event ${e.forYou ? "is-for-you" : ""}`}>
              <span className="live-event-when">{ago(e.at)}</span>
              <span className="live-event-tool">{NAME[e.toolkit] ?? e.toolkit}</span>
              <span className="live-event-title" title={e.summary}>
                {e.title}
              </span>
              {e.url && (
                <button type="button" className="button small quiet icon-only" onClick={() => open(e.url!)} aria-label="Open">
                  <ExternalLink size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Live events from Slack, Linear, Notion, Gmail and GitHub through Composio, running on the home. */
export function LiveEvents({ initial, home }: { initial: LiveStatus; home: string }) {
  const [s, setS] = useState(initial);
  const refresh = () => void getLive().then(setS, () => {});
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 4000);
    return () => clearInterval(t);
  }, []);
  const ready = s.signedIn && s.project;
  return (
    <div className="machines">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-name">Live events</span>
          <span className="meta">Slack, Linear, Notion, Gmail and GitHub through Composio, on {home}</span>
        </div>
        {ready && s.listener.state === "running" && (
          <span className="meta setup-done">
            <Check size={12} className="step-done" /> listening
          </span>
        )}
      </header>
      <div className="machines-body is-single" data-scroll="y">
        <main className="machines-main">
          <article className="machine-detail">
            <Account s={s} refresh={refresh} />
            {ready && <Accounts s={s} refresh={refresh} />}
            {ready && <Events s={s} refresh={refresh} />}
            {ready && <Listener s={s} refresh={refresh} />}
          </article>
        </main>
      </div>
    </div>
  );
}
