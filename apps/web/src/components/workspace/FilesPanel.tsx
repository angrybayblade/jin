"use client";
import { ChevronDown, ChevronRight, File, FilePlus, Folder, GitCompare, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getDiff, listFiles } from "@/app/actions";
import type { FileEntry, RepoDiff } from "@/lib/daemon";

function TreeNode({ taskId, entry, depth, open, onOpen }: { taskId: string; entry: FileEntry; depth: number; open: string | null; onOpen: (p: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const toggle = async () => {
    if (!entry.dir) return onOpen(entry.path);
    if (!children) setChildren(await listFiles(taskId, entry.path));
    setExpanded((x) => !x);
  };
  return (
    <li>
      <button type="button" className={`tree-row ${open === entry.path ? "is-open" : ""}`} style={{ paddingLeft: 8 + depth * 12 }} onClick={() => void toggle()} title={entry.path}>
        {entry.dir ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span className="tree-spacer" />}
        {entry.dir ? <Folder size={13} /> : <File size={13} />}
        <span className="tree-name">{entry.name}</span>
      </button>
      {expanded && children && (
        <ul>
          {children.map((c) => (
            <TreeNode key={c.path} taskId={taskId} entry={c} depth={depth + 1} open={open} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Changed files in a repo's diff ("diff --git a/x b/x"), plus new ones. */
function changedFiles(r: RepoDiff): { path: string; added: boolean }[] {
  const seen = new Set<string>();
  const out: { path: string; added: boolean }[] = [];
  for (const m of r.diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const p = `${r.repo}/${m[2]}`;
    if (!seen.has(p)) seen.add(p), out.push({ path: p, added: false });
  }
  for (const u of r.untracked) {
    const p = `${r.repo}/${u}`;
    if (!seen.has(p)) seen.add(p), out.push({ path: p, added: true });
  }
  return out;
}

/** The task's files, on the right: the worktree tree, or what changed. Opening a file adds an editor tab. */
export function FilesPanel({ taskId, subtitle, openPath, onOpen, onShowChanges }: { taskId: string; subtitle: string; openPath: string | null; onOpen: (path: string) => void; onShowChanges: () => void }) {
  const [view, setView] = useState<"files" | "changes">("files");
  const [roots, setRoots] = useState<FileEntry[] | null>(null);
  const [diff, setDiff] = useState<RepoDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listFiles(taskId, "").then(setRoots).catch((e) => setError(String(e)));
  }, [taskId]);
  const loadDiff = useCallback(() => {
    void getDiff(taskId)
      .then((d) => (setDiff(d), setError(null)))
      .catch((e) => setError(String(e)));
  }, [taskId]);
  useEffect(() => {
    if (view === "changes") loadDiff();
  }, [view, loadDiff]);

  const changes = diff?.flatMap(changedFiles) ?? [];
  return (
    <section className="files-panel" aria-label="Files">
      <header className="pane-header">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={view === "files"} className={`tab ${view === "files" ? "is-selected" : ""}`} onClick={() => setView("files")}>
            Files
          </button>
          <button type="button" role="tab" aria-selected={view === "changes"} className={`tab ${view === "changes" ? "is-selected" : ""}`} onClick={() => setView("changes")}>
            Changes
          </button>
        </div>
        {view === "changes" && (
          <span className="pane-actions">
            <button type="button" className="button quiet icon-only" onClick={loadDiff} title="Refresh" aria-label="Refresh changes">
              <RefreshCw size={13} />
            </button>
            <button type="button" className="button quiet icon-only" onClick={onShowChanges} title="Open the full diff as a tab" aria-label="Open the diff">
              <GitCompare size={13} />
            </button>
          </span>
        )}
      </header>
      <p className="files-subtitle meta" title={subtitle}>
        {subtitle}
      </p>
      <nav className="file-tree" data-scroll="y">
        {error && <p className="meta pad">{error}</p>}
        {view === "files" ? (
          roots === null ? (
            <p className="meta pad">Loading…</p>
          ) : (
            <ul>
              {roots.map((e) => (
                <TreeNode key={e.path} taskId={taskId} entry={e} depth={0} open={openPath} onOpen={onOpen} />
              ))}
            </ul>
          )
        ) : diff === null ? (
          <p className="meta pad">Loading…</p>
        ) : changes.length === 0 ? (
          <p className="meta pad">No uncommitted changes.</p>
        ) : (
          <ul>
            {changes.map((c) => (
              <li key={c.path}>
                <button type="button" className={`tree-row ${openPath === c.path ? "is-open" : ""}`} style={{ paddingLeft: 8 }} onClick={() => onOpen(c.path)} title={c.path}>
                  {c.added ? <FilePlus size={13} /> : <File size={13} />}
                  <span className="tree-name">{c.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </section>
  );
}
