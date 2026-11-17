"use client";
import { CheckCircle2, ChevronRight, FileText, FlaskConical, GitCommitHorizontal, Lightbulb, PenLine, Split } from "lucide-react";
import { useEffect, useState } from "react";
import { getJournal } from "@/app/actions";
import type { JournalEntry, JournalView } from "@/lib/daemon";

const KIND = {
  decision: { Icon: Split, label: "Decision" },
  done: { Icon: CheckCircle2, label: "Done" },
  found: { Icon: Lightbulb, label: "Found" },
  change: { Icon: PenLine, label: "Changed" },
} as const;

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

function Entry({ e, showSession, onOpen }: { e: JournalEntry; showSession: boolean; onOpen: (path: string) => void }) {
  const { Icon, label } = KIND[e.kind];
  return (
    <li className={`jr-entry is-${e.kind}`}>
      <Icon size={13} className="jr-kind" aria-label={label} />
      <div className="jr-body">
        <span className="jr-text">{e.text}</span>
        {e.why && <div className="jr-why">{e.why}</div>}
        {e.refs.length > 0 && (
          <div className="jr-refs">
            {e.refs.map((r) =>
              r.type === "file" ? (
                <button key={`f:${r.text}`} type="button" className="jr-ref" onClick={() => onOpen(r.text)} title={r.text}>
                  <FileText size={11} /> <span>{r.text.split("/").pop()}</span>
                </button>
              ) : (
                <span key={`${r.type}:${r.text}`} className="jr-ref" title={r.text}>
                  {r.type === "commit" ? <GitCommitHorizontal size={11} /> : <FlaskConical size={11} />} <span>{r.text}</span>
                </span>
              ),
            )}
          </div>
        )}
        <span className="jr-meta" title={new Date(e.at).toLocaleString()}>
          {ago(e.at)}
          {showSession && e.session ? ` · ${e.session}` : ""}
        </span>
      </div>
    </li>
  );
}

/** What Claude Code decided, did and found in this task, by concern; the hooks add files, commits and tests. */
export function JournalPanel({ taskId, onOpen }: { taskId: string; onOpen: (path: string) => void }) {
  const [view, setView] = useState<JournalView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void getJournal(taskId).then(
        (v) => {
          if (!live) return;
          if ("error" in v) setError(v.error);
          else (setView(v), setError(null));
        },
        (e) => live && setError(String(e)),
      );
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [taskId]);
  if (error && !view) return <p className="meta pad">{error}</p>;
  if (!view) return <p className="meta pad">Loading…</p>;
  const sessions = new Set([...view.concerns.flatMap((c) => c.entries), ...view.unjournaled].map((e) => e.session));
  const showSession = sessions.size > 1;
  if (!view.concerns.length && !view.unjournaled.length)
    return <p className="meta pad">Nothing journaled yet. Claude Code records its decisions, work and findings here as it goes.</p>;
  const latest = view.concerns.reduce<string | null>((a, c) => (!a || c.lastAt > (view.concerns.find((x) => x.name === a)?.lastAt ?? "") ? c.name : a), null);
  return (
    <div className="journal" data-scroll="y">
      {view.concerns.map((c) => (
        <details key={c.name} className="jr-concern" open={c.name === latest || view.concerns.length <= 3}>
          <summary>
            <ChevronRight size={12} className="jr-chevron" />
            <span className="jr-name">{c.name}</span>
            <span className="jr-count">{c.entries.length}</span>
            <span className="jr-age">{ago(c.lastAt)}</span>
          </summary>
          <ul>
            {c.entries.map((e) => (
              <Entry key={e.id} e={e} showSession={showSession} onOpen={onOpen} />
            ))}
          </ul>
        </details>
      ))}
      {view.unjournaled.length > 0 && (
        <details className="jr-concern is-unjournaled">
          <summary>
            <ChevronRight size={12} className="jr-chevron" />
            <span className="jr-name">Not journaled</span>
            <span className="jr-count">{view.unjournaled.length}</span>
          </summary>
          <ul>
            {view.unjournaled.map((e) => (
              <Entry key={e.id} e={e} showSession={showSession} onOpen={onOpen} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
