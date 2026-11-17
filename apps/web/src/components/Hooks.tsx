"use client";
import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { deleteHook, getHooks, saveHook } from "@/app/actions";
import type { Hook, HooksStatus } from "@/lib/daemon";

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

type Draft = Partial<Hook> & { filterText: string };
const toDraft = (h?: Hook): Draft => ({ ...(h ?? { event: "task.merged", enabled: true, name: "", instructions: "" }), filterText: h ? Object.entries(h.filter).map(([k, v]) => `${k}=${v}`).join("\n") : "" });
/** "toolkit=slack" lines, one per field. */
const parseFilter = (t: string): Record<string, string> =>
  Object.fromEntries(
    t
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf("=");
        return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, ""];
      }),
  );

/** One hook: open to edit its event, filter and instructions. */
function HookCard({ hook, s, onSaved, startOpen = false, onCancel }: { hook?: Hook; s: HooksStatus; onSaved: () => void; startOpen?: boolean; onCancel?: () => void }) {
  const [open, setOpen] = useState(startOpen);
  const [d, setD] = useState<Draft>(toDraft(hook));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const event = s.events.find((e) => e.id === d.event);
  const runs = hook ? s.runs.filter((r) => r.hookId === hook.id) : [];
  const save = async (patch?: Partial<Hook>) => {
    setBusy(true);
    setError(null);
    const r = await saveHook(patch ? { id: hook!.id, ...patch } : { id: hook?.id, name: d.name, event: d.event, instructions: d.instructions, enabled: d.enabled, filter: parseFilter(d.filterText) });
    setBusy(false);
    if ("error" in r) return setError(r.error);
    if (!patch) setOpen(false);
    onSaved();
  };
  const remove = async () => {
    if (!hook || !confirm(`Delete the hook "${hook.name}"?`)) return;
    const r = await deleteHook(hook.id);
    if ("error" in r) setError(r.error);
    else onSaved();
  };
  return (
    <section className="md-card hook-card">
      <div className="md-card-head is-static">
        {hook && (
          <label className="live-switch" title={hook.enabled ? "On" : "Off"}>
            <input type="checkbox" checked={hook.enabled} disabled={busy} onChange={() => void save({ enabled: !hook.enabled })} />
            <span className="live-switch-track" />
          </label>
        )}
        <button type="button" className="hook-title" onClick={() => setOpen(!open)}>
          <h3>{hook?.name ?? "New hook"}</h3>
          <span className="meta">
            {s.events.find((e) => e.id === (hook?.event ?? d.event))?.label}
            {hook && Object.keys(hook.filter).length > 0 && ` · ${Object.entries(hook.filter).map(([k, v]) => `${k}=${v}`).join(", ")}`}
          </span>
        </button>
        {runs[0] && <span className="meta hook-last">ran {ago(runs[0].at)} ago</span>}
      </div>
      {open && (
        <div className="md-card-body">
          <div className="field-row">
            <label className="field">
              <span>Name</span>
              <input value={d.name ?? ""} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Clean up after a merge" />
            </label>
            <label className="field">
              <span>When</span>
              <select value={d.event} onChange={(e) => setD({ ...d, event: e.target.value as Hook["event"] })}>
                {s.events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {event && <p className="meta">{event.description}</p>}
          <label className="field">
            <span>Only when (optional, one field=value per line; /pattern/ to match)</span>
            <textarea rows={2} value={d.filterText} onChange={(e) => setD({ ...d, filterText: e.target.value })} placeholder={event?.id === "live.event" ? "toolkit=slack\nforYou=true" : "pr.repo=acme/api"} />
            {event && <span className="meta">fields: {event.fields.join(", ")}</span>}
          </label>
          <label className="field">
            <span>Instructions for the agent</span>
            <textarea rows={9} value={d.instructions ?? ""} onChange={(e) => setD({ ...d, instructions: e.target.value })} placeholder="Steps the agent follows. It gets the event's details, jin's tools and your connectors; anything outward waits for your approval." />
          </label>
          {error && <p className="machine-error">{error}</p>}
          <div className="hook-actions">
            {hook && (
              <button type="button" className="button quiet small" onClick={() => void remove()}>
                <Trash2 size={13} /> Delete
              </button>
            )}
            <span className="hook-spacer" />
            <button type="button" className="button quiet small" onClick={() => (hook ? (setD(toDraft(hook)), setOpen(false)) : onCancel?.())}>
              Cancel
            </button>
            <button type="button" className="button small" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
          {runs.length > 0 && (
            <ul className="hook-runs">
              {runs.slice(0, 5).map((r) => (
                <li key={r.id}>
                  <span className="meta">{ago(r.at)} ago</span> <span className="mono">{r.key}</span>{" "}
                  {r.chatId ? (
                    <Link href={`/?chat=${r.chatId}`}>open chat</Link>
                  ) : (
                    <span className="machine-error">{r.error}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export function HooksPage({ initial, home }: { initial: HooksStatus; home: string }) {
  const [s, setS] = useState(initial);
  const [adding, setAdding] = useState(false);
  const refresh = () => void getHooks().then(setS, () => {});
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && refresh(), 10_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="machines">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-name">Hooks</span>
          <span className="meta">when something happens, an agent follows your instructions · on {home}</span>
        </div>
        <button type="button" className="button small" onClick={() => setAdding(true)} disabled={adding}>
          <Plus size={13} /> New hook
        </button>
      </header>
      <div className="machines-body is-single" data-scroll="y">
        <main className="machines-main">
          <article className="machine-detail">
            {adding && <HookCard s={s} startOpen onSaved={() => (setAdding(false), refresh())} onCancel={() => setAdding(false)} />}
            {s.hooks.map((h) => (
              <HookCard key={h.id} hook={h} s={s} onSaved={refresh} />
            ))}
            {s.hooks.length === 0 && !adding && <p className="meta">No hooks yet. Add one, or ask jin in the chat to set one up.</p>}
            <p className="meta">
              A hook starts a jin chat with its instructions and the event&apos;s details, once per event. The agent has jin&apos;s tools and your connectors; Linear and Slack changes, and removing worktrees, wait for your approval.
            </p>
          </article>
        </main>
      </div>
    </div>
  );
}
