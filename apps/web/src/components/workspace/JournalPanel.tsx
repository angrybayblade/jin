"use client";
import { Empty, Failed, Loading } from "@/components/States";
import { BookMarked, CheckCircle2, ChevronRight, FileText, FlaskConical, GitCommitHorizontal, Hash, Lightbulb, PenLine, Plus, RefreshCw, Split, X } from "lucide-react";
import { useEffect, useState } from "react";
import { addPreContext, getJournal, getPreContext, listMemory, refreshPreContext, removePreContext } from "@/lib/actions";
import type { JournalEntry, JournalView, PreContextPick } from "@/lib/daemon";

const KIND = {
  decision: { Icon: Split, label: "Decision" },
  done: { Icon: CheckCircle2, label: "Done" },
  found: { Icon: Lightbulb, label: "Found" },
  change: { Icon: PenLine, label: "Changed" },
  summary: { Icon: BookMarked, label: "Summary" },
} as const;

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

function Entry({ e, showSession, onOpen }: { e: JournalEntry; showSession: boolean; onOpen: (path: string) => void }) {
  const { Icon, label } = KIND[e.kind];
  const status = e.status ?? "active";
  return (
    <li className={`jr-entry is-${e.kind} is-${status}`}>
      <Icon size={13} className="jr-kind" aria-label={label} />
      <div className="jr-body">
        <span className="jr-text">{e.text}</span>
        {status !== "active" && <span className="jr-flag" title={status === "superseded" ? "A later entry replaced this one" : "Dropped when the task was wrapped up"}>{status === "superseded" ? "replaced" : "dropped"}</span>}
        {e.level === "global" && status === "active" && (
          <span className="jr-flag is-kept" title="Kept in long-term memory: agents in later tasks of this workspace find it">
            kept
          </span>
        )}
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
                  {r.type === "commit" ? <GitCommitHorizontal size={11} /> : r.type === "id" ? <Hash size={11} /> : <FlaskConical size={11} />} <span>{r.text}</span>
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

/** Find a kept memory and add it to the task's pre-context (yours: a refresh keeps it). */
function AddFromMemory({ taskId, picked, onPicks }: { taskId: string; picked: Set<string>; onPicks: (p: PreContextPick[]) => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<JournalEntry[]>([]);
  useEffect(() => {
    if (!q.trim()) return setFound([]);
    let live = true;
    const t = setTimeout(() => void listMemory(q.trim()).then((r) => live && setFound(r.slice(0, 6)), () => {}), 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  return (
    <div className="jr-add">
      <input value={q} placeholder="Add from memory…" onChange={(e) => setQ(e.target.value)} aria-label="Find a kept memory to add to this task" />
      {found.length > 0 && (
        <ul className="jr-add-list">
          {found.map((e) => (
            <li key={e.id}>
              <button type="button" disabled={picked.has(e.id)} onClick={async () => (onPicks((await addPreContext(taskId, e.id)).picks), setQ(""))} title={picked.has(e.id) ? "Already in this task's pre-context" : "Add to this task"}>
                <Plus size={11} />
                <span>{e.text}</span>
                <span className="meta">{e.taskId}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What earlier tasks kept that bears on this one (jin's pick, or yours): every agent in the task starts with it. */
function FromEarlier({ taskId }: { taskId: string }) {
  const [picks, setPicks] = useState<PreContextPick[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void getPreContext(taskId).then((r) => live && setPicks(r.picks), () => live && setPicks([]));
    return () => {
      live = false;
    };
  }, [taskId]);
  if (picks === null) return null;
  const shown = picks.filter((p) => p.row);
  return (
    <details className="jr-concern jr-earlier" open={shown.length > 0}>
      <summary>
        <ChevronRight size={12} className="jr-chevron" />
        <span className="jr-name">From earlier tasks</span>
        <span className="jr-count">{shown.length}</span>
        <button
          type="button"
          className="button quiet icon-only small jr-earlier-refresh"
          title="Pick again from long-term memory"
          aria-label="Pick again"
          disabled={busy}
          onClick={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              setPicks((await refreshPreContext(taskId)).picks);
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw size={12} className={busy ? "spin" : undefined} />
        </button>
      </summary>
      {shown.length ? (
        <ul>
          {shown.map((p) => (
            <li key={p.memoryId} className={`jr-entry is-${p.row!.kind}`}>
              <BookMarked size={13} className="jr-kind" aria-label="Kept memory" />
              <div className="jr-body">
                <span className="jr-text">{p.row!.text}</span>
                {p.reason && <div className="jr-why">{p.reason}</div>}
                <span className="jr-meta">
                  from {p.row!.taskId} · {p.by === "you" ? "added by you" : "picked by jin"}
                </span>
              </div>
              <button type="button" className="button quiet icon-only small" title="Leave it out of this task" aria-label="Leave it out" onClick={async () => setPicks((await removePreContext(taskId, p.memoryId)).picks)}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="meta jr-earlier-none">Nothing from earlier tasks bears on this one yet.</p>
      )}
      <AddFromMemory taskId={taskId} picked={new Set(picks.map((p) => p.memoryId))} onPicks={setPicks} />
    </details>
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
  if (error && !view) return <Failed message={error} />;
  if (!view) return <Loading />;
  const sessions = new Set([...view.concerns.flatMap((c) => c.entries), ...view.unjournaled].map((e) => e.session));
  const showSession = sessions.size > 1;
  if (!view.concerns.length && !view.unjournaled.length)
    return (
      <div className="journal" data-scroll="y">
        <FromEarlier taskId={taskId} />
        <Empty title="Nothing journaled yet">The task&apos;s agents record their decisions, work and findings here as they go.</Empty>
      </div>
    );
  const latest = view.concerns.reduce<string | null>((a, c) => (!a || c.lastAt > (view.concerns.find((x) => x.name === a)?.lastAt ?? "") ? c.name : a), null);
  return (
    <div className="journal" data-scroll="y">
      <FromEarlier taskId={taskId} />
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
