"use client";
import { FileText, MessageSquare, Plus, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { createDoc } from "@/app/actions";
import type { DocSummary } from "@/lib/daemon";

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** Start a doc and open it. */
export function useNewDoc() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    const d = await createDoc();
    setBusy(false);
    if ("error" in d) return setError(d.error);
    router.push(`/docs/${d.id}`);
  };
  return { create, busy, error };
}

/** The docs library: search, tags, and every doc, most recently changed first. */
export function DocLibrary({ docs }: { docs: DocSummary[] }) {
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const { create, busy, error } = useNewDoc();
  const tags = useMemo(() => {
    const n = new Map<string, number>();
    for (const d of docs) for (const t of d.tags) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [docs]);
  const shown = docs.filter((d) => (!tag || d.tags.includes(tag)) && (!q.trim() || `${d.title} ${d.excerpt} ${d.tags.join(" ")}`.toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <div className="docs-library">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-name">Docs</span>
          <span className="meta">specs, RFCs and notes you write with jin</span>
        </div>
        <button type="button" className="button small primary" onClick={() => void create()} disabled={busy}>
          <Plus size={13} /> New doc
        </button>
      </header>
      <div className="docs-body" data-scroll="y">
        <div className="docs-tools">
          <label className="docs-search">
            <Search size={14} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search docs" aria-label="Search docs" />
          </label>
          {tags.length > 0 && (
            <div className="docs-tag-filter">
              {tags.map(([t, n]) => (
                <button key={t} type="button" className={`doc-tag ${tag === t ? "is-on" : ""}`} onClick={() => setTag(tag === t ? null : t)}>
                  {t} <span className="meta">{n}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {error && <p className="machine-error">{error}</p>}
        {!docs.length ? (
          <div className="docs-empty">
            <FileText size={28} />
            <p>No docs yet. Write a spec, an RFC or notes, and work on it with jin: it comments, reviews and suggests edits you accept or reject.</p>
            <button type="button" className="button primary" onClick={() => void create()} disabled={busy}>
              <Plus size={14} /> New doc
            </button>
          </div>
        ) : !shown.length ? (
          <p className="meta docs-none">No docs match.</p>
        ) : (
          <ul className="docs-list">
            {shown.map((d) => (
              <li key={d.id}>
                <Link href={`/docs/${d.id}`} className="docs-row">
                  <FileText size={16} className="docs-row-icon" />
                  <span className="docs-row-main">
                    <span className="docs-row-title">{d.title}</span>
                    {d.excerpt && <span className="meta docs-row-excerpt">{d.excerpt}</span>}
                    {d.tags.length > 0 && (
                      <span className="docs-row-tags">
                        {d.tags.map((t) => (
                          <span key={t} className="doc-tag">
                            {t}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="docs-row-side">
                    <span className="meta">{ago(d.updatedAt)}</span>
                    {d.openThreads > 0 && (
                      <span className="meta" title={`${d.openThreads} open comment thread${d.openThreads === 1 ? "" : "s"}`}>
                        <MessageSquare size={12} /> {d.openThreads}
                      </span>
                    )}
                    {d.openSuggestions > 0 && (
                      <span className="meta docs-row-sugg" title={`${d.openSuggestions} suggestion${d.openSuggestions === 1 ? "" : "s"} from jin`}>
                        <Sparkles size={12} /> {d.openSuggestions}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
