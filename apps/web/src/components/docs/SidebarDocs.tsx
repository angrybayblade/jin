"use client";
import { FileText, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { renameDoc } from "@/lib/actions";
import type { DocSummary } from "@/lib/daemon";
import { openContextMenu } from "../ContextMenu";
import { RenameInput } from "../RenameInput";
import { useNewDoc } from "./DocLibrary";
import { docMenu } from "./docMenu";

/** The sidebar's docs: the latest few, the library, and + for a new one; right-click one for its menu. */
export function SidebarDocs({ docs }: { docs: DocSummary[] }) {
  const path = usePathname();
  const router = useRouter();
  const { create, busy } = useNewDoc();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const shown = docs.filter((d) => !gone.has(d.id));
  const title = (d: DocSummary) => names[d.id] ?? d.title;

  const menu = (e: React.MouseEvent, d: DocSummary) => {
    e.preventDefault();
    openContextMenu(
      e,
      docMenu({
        doc: { id: d.id, title: title(d) },
        at: { clientX: e.clientX, clientY: e.clientY },
        rename: () => setRenaming(d.id),
        opened: (id) => router.push(`/docs/${id}`),
        gone: () => {
          setGone((g) => new Set(g).add(d.id));
          if (path === `/docs/${d.id}`) router.push("/docs");
          router.refresh();
        },
        onError: setError,
      }),
    );
  };

  return (
    <>
      <div className="nav-section">
        <Link href="/docs" className="nav-section-link" title="All docs">
          Docs
        </Link>
        <button type="button" className="nav-section-action" onClick={() => void create()} disabled={busy} title="New doc" aria-label="New doc">
          <Plus size={13} />
        </button>
      </div>
      {error && (
        <p className="sidebar-error" role="alert" onClick={() => setError(null)} title="Dismiss">
          {error}
        </p>
      )}
      {shown.slice(0, 5).map((d) =>
        renaming === d.id ? (
          <div key={d.id} className="nav-item is-doc active">
            <FileText size={13} className="nav-doc-icon" />
            <RenameInput
              value={title(d)}
              label="Doc title"
              onCancel={() => setRenaming(null)}
              onSave={async (v) => {
                setRenaming(null);
                setNames((n) => ({ ...n, [d.id]: v.trim() || "Untitled" }));
                const r = await renameDoc(d.id, v);
                if ("error" in r) setError(r.error);
              }}
            />
          </div>
        ) : (
          <Link
            key={d.id}
            href={`/docs/${d.id}`}
            className={`nav-item is-doc ${path === `/docs/${d.id}` ? "active" : ""}`}
            title={title(d)}
            onContextMenu={(e) => menu(e, d)}
            onDoubleClick={(e) => {
              e.preventDefault();
              setRenaming(d.id);
            }}
          >
            <FileText size={13} className="nav-doc-icon" />
            <span className="nav-label">{title(d)}</span>
            {d.openSuggestions > 0 && (
              <span className="nav-count" title={`${d.openSuggestions} suggestion${d.openSuggestions === 1 ? "" : "s"} from jin`}>
                {d.openSuggestions}
              </span>
            )}
          </Link>
        ),
      )}
      {shown.length > 5 && (
        <Link href="/docs" className={`nav-item is-doc nav-more ${path === "/docs" ? "active" : ""}`}>
          <span className="nav-label meta">All docs ({shown.length})</span>
        </Link>
      )}
    </>
  );
}
