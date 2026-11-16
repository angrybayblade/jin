"use client";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { listFiles } from "@/app/actions";
import type { FileEntry } from "@/lib/daemon";

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

/** The task's worktree as a tree, on the right. Opening a file adds an editor tab. */
export function FilesPanel({ taskId, openPath, onOpen }: { taskId: string; openPath: string | null; onOpen: (path: string) => void }) {
  const [roots, setRoots] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void listFiles(taskId, "").then(setRoots).catch((e) => setError(String(e)));
  }, [taskId]);
  return (
    <nav className="files-panel file-tree" data-scroll="y" aria-label="Files">
      {error && <p className="meta pad">{error}</p>}
      {roots === null ? (
        <p className="meta pad">Loading…</p>
      ) : (
        <ul>
          {roots.map((e) => (
            <TreeNode key={e.path} taskId={taskId} entry={e} depth={0} open={openPath} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </nav>
  );
}
