"use client";
import { BookMarked, CheckCircle2, Hash, Lightbulb, Pencil, Search, Split, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Empty } from "@/components/States";
import { SettingsPage } from "@/components/SettingsPage";
import { editMemory, listMemory } from "@/lib/actions";
import type { JournalEntry } from "@/lib/daemon";

/**
 * jin's long-term memory: what finished tasks kept (jin decides when a task is merged or wrapped
 * up; agents never do). Agents search it, and each task starts with what bears on it. Here you
 * read it, reword a row, or forget one.
 */

const KIND = { decision: { Icon: Split, label: "Decision" }, found: { Icon: Lightbulb, label: "Learned" }, done: { Icon: CheckCircle2, label: "Done" }, summary: { Icon: BookMarked, label: "Task summary" }, change: { Icon: Pencil, label: "Change" } } as const;

function Row({ e, onChange }: { e: JournalEntry; onChange: (next: JournalEntry | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(e.text);
  const [busy, setBusy] = useState(false);
  const { Icon, label } = KIND[e.kind] ?? KIND.found;
  const save = async () => {
    setBusy(true);
    try {
      onChange(await editMemory(e.id, { text }));
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`mem-row is-${e.kind}`}>
      <Icon size={14} className="mem-kind" aria-label={label} />
      <div className="mem-body">
        {editing ? (
          <div className="mem-edit">
            <textarea value={text} rows={2} onChange={(ev) => setText(ev.target.value)} aria-label="Reword this memory" />
            <div className="mem-actions">
              <button type="button" className="button quiet small" onClick={() => (setEditing(false), setText(e.text))} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="button small primary" onClick={() => void save()} disabled={busy || !text.trim() || text.trim() === e.text}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <span className="mem-text">{e.text}</span>
        )}
        {e.why && <span className="mem-why">{e.why}</span>}
        {e.refs.some((r) => r.type === "id") && (
          <span className="jr-refs">
            {e.refs
              .filter((r) => r.type === "id")
              .map((r) => (
                <span key={r.text} className="jr-ref" title={r.text}>
                  <Hash size={11} /> <span>{r.text}</span>
                </span>
              ))}
          </span>
        )}
        <span className="meta">
          {label}
          {e.concern && e.kind !== "summary" ? ` · ${e.concern}` : ""} · from {e.taskId}
          {e.machine ? ` on ${e.machine}` : ""} · {new Date(e.at).toLocaleDateString()}
          {e.workspace ? ` · ${e.workspace}` : ""}
        </span>
      </div>
      {!editing && (
        <div className="mem-row-actions">
          <button type="button" className="button quiet icon-only small" onClick={() => setEditing(true)} title="Reword" aria-label="Reword">
            <Pencil size={13} />
          </button>
          <button
            type="button"
            className="button quiet icon-only small"
            title="Forget: agents no longer find it"
            aria-label="Forget"
            onClick={async () => {
              if (!window.confirm("Forget this memory? Agents will no longer find it.")) return;
              await editMemory(e.id, { forget: true });
              onChange(null);
            }}
          >
            <X size={13} />
          </button>
        </div>
      )}
    </li>
  );
}

export function MemoryPage({ initial, home }: { initial: JournalEntry[]; home: string }) {
  const [rows, setRows] = useState(initial);
  const [q, setQ] = useState("");
  const [workspace, setWorkspace] = useState("");
  const workspaces = useMemo(() => [...new Set(initial.map((r) => r.workspace).filter((w): w is string => Boolean(w)))].sort(), [initial]);
  useEffect(() => {
    const t = setTimeout(() => void listMemory(q.trim() || undefined, workspace || undefined).then(setRows, () => {}), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [q, workspace]);
  return (
    <SettingsPage title="Memory" meta={<>what finished tasks kept · on {home}</>}>
      <div className="mem-tools">
        <label className="docs-search">
          <Search size={13} />
          <input value={q} placeholder="Find in memory…" onChange={(e) => setQ(e.target.value)} aria-label="Find in memory" />
        </label>
        {workspaces.length > 1 && (
          <select value={workspace} onChange={(e) => setWorkspace(e.target.value)} aria-label="Workspace">
            <option value="">Every workspace</option>
            {workspaces.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        )}
      </div>
      {rows.length ? (
        <ul className="mem-list">
          {rows.map((e) => (
            <Row key={e.id} e={e} onChange={(next) => setRows((list) => (next ? list.map((x) => (x.id === next.id ? next : x)) : list.filter((x) => x.id !== e.id)))} />
          ))}
        </ul>
      ) : (
        <Empty title={q ? "Nothing matches" : "Nothing kept yet"}>{q ? "Try other words." : "When a task is merged, or you wrap one up, jin keeps what it learned here."}</Empty>
      )}
      <p className="meta">
        jin keeps a task&apos;s lasting decisions, learnings and a short summary when it is merged or wrapped up; agents never add here themselves. Agents search this memory, and each task starts with what bears on it.
      </p>
    </SettingsPage>
  );
}
