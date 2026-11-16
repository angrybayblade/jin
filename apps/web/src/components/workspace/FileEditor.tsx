"use client";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import { ChevronDown, ChevronRight, File, Folder, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { listFiles, readFile, writeFile } from "@/app/actions";
import type { FileEntry } from "@/lib/daemon";
import { useResolvedTheme } from "@/lib/theme";

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", go: "go", py: "python", yaml: "yaml", yml: "yaml", sh: "shell", css: "css",
  html: "html", sql: "sql", prisma: "graphql", graphql: "graphql", toml: "ini", rs: "rust", dockerfile: "dockerfile",
};
const language = (path: string) => LANG[(path.split(".").pop() ?? "").toLowerCase()] ?? (path.endsWith("Dockerfile") ? "dockerfile" : "plaintext");
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// The coding tokens (tokens.css) as Monaco themes, light and dark.
const defineTheme: BeforeMount = (monaco) => {
  monaco.editor.defineTheme("jin-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "8b8a94" },
      { token: "keyword", foreground: "a13e28" },
      { token: "string", foreground: "455569" },
      { token: "number", foreground: "8a5a12" },
      { token: "type", foreground: "9d5034" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#29272b",
      "editorLineNumber.foreground": "#b8b7bb",
      "editorLineNumber.activeForeground": "#50515a",
      "editor.selectionBackground": "#f1d3ae",
      "editor.lineHighlightBackground": "#f7f7f7",
      "editorCursor.foreground": "#9d5034",
    },
  });
  monaco.editor.defineTheme("jin-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7d7b87" },
      { token: "keyword", foreground: "e7952f" },
      { token: "string", foreground: "b9c2d6" },
      { token: "number", foreground: "f0c36d" },
      { token: "type", foreground: "e4b07a" },
    ],
    colors: {
      "editor.background": "#1b1a1e",
      "editor.foreground": "#e6e4ea",
      "editorLineNumber.foreground": "#4a4952",
      "editorLineNumber.activeForeground": "#b9b8c1",
      "editor.selectionBackground": "#3a2a1a",
      "editor.lineHighlightBackground": "#222126",
      "editorCursor.foreground": "#e7a35a",
    },
  });
};

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

interface Doc {
  content: string;
  saved: string;
  error?: string;
}

/** File tree and tabbed editor over the task's worktrees; Cmd/Ctrl+S saves the active tab. */
export function FileEditor({ taskId }: { taskId: string }) {
  const root = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme(root);
  const storageKey = `jin-files:${taskId}`;
  const [roots, setRoots] = useState<FileEntry[] | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [docs, setDocs] = useState<Record<string, Doc>>({});
  const [note, setNote] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const docsRef = useRef(docs);
  activeRef.current = active;
  docsRef.current = docs;

  useEffect(() => {
    void listFiles(taskId, "").then(setRoots).catch((e) => setNote(String(e)));
    // Open tabs are remembered per task in this browser.
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as { tabs: string[]; active: string | null } | null;
      if (saved?.tabs?.length) {
        setTabs(saved.tabs);
        setActive(saved.active ?? saved.tabs[0] ?? null);
      }
    } catch {}
  }, [taskId, storageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ tabs, active }));
    } catch {}
  }, [storageKey, tabs, active]);

  // Load a tab's file the first time it is shown.
  useEffect(() => {
    if (!active || docs[active]) return;
    void readFile(taskId, active).then((res) =>
      setDocs((d) => ({ ...d, [active]: "error" in res ? { content: "", saved: "", error: res.error } : { content: res.content, saved: res.content } })),
    );
  }, [active, docs, taskId]);

  const open = useCallback((p: string) => {
    setTabs((t) => (t.includes(p) ? t : [...t, p]));
    setActive(p);
    setNote(null);
  }, []);

  const close = (p: string) => {
    const doc = docsRef.current[p];
    if (doc && doc.content !== doc.saved && !confirm(`${base(p)} has unsaved changes. Close it anyway?`)) return;
    setTabs((t) => {
      const next = t.filter((x) => x !== p);
      if (activeRef.current === p) setActive(next[Math.max(0, t.indexOf(p) - 1)] ?? null);
      return next;
    });
    setDocs((d) => {
      const { [p]: _, ...rest } = d;
      return rest;
    });
  };

  const save = useCallback(async () => {
    const p = activeRef.current;
    const doc = p ? docsRef.current[p] : undefined;
    if (!p || !doc || doc.error) return;
    try {
      await writeFile(taskId, p, doc.content);
      setDocs((d) => ({ ...d, [p]: { ...doc, saved: doc.content } }));
      setNote(`saved ${base(p)}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }, [taskId]);

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
  };

  const doc = active ? docs[active] : undefined;
  return (
    <div className="file-editor" ref={root}>
      <nav className="file-tree" data-scroll="y" aria-label="Files">
        {roots === null ? (
          <p className="meta pad">Loading…</p>
        ) : (
          <ul>
            {roots.map((e) => (
              <TreeNode key={e.path} taskId={taskId} entry={e} depth={0} open={active} onOpen={open} />
            ))}
          </ul>
        )}
      </nav>
      <div className="editor-main">
        {tabs.length > 0 && (
          <div className="file-tabs" role="tablist" aria-label="Open files">
            {tabs.map((p) => {
              const d = docs[p];
              const dirty = d && d.content !== d.saved;
              return (
                <div key={p} role="tab" aria-selected={p === active} className={`file-tab ${p === active ? "is-active" : ""}`} title={p} onClick={() => setActive(p)} onAuxClick={(e) => e.button === 1 && close(p)}>
                  <span className="file-tab-name">{base(p)}</span>
                  {dirty && <span className="dirty-dot" aria-label="unsaved" />}
                  <button
                    type="button"
                    className="file-tab-close"
                    aria-label={`Close ${base(p)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      close(p);
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="editor-bar">
          <span className="editor-path">{active ?? "Open a file from the tree"}</span>
          {note && <span className="meta">{note}</span>}
          {active && doc && !doc.error && (
            <button type="button" className="button quiet small" onClick={() => void save()} disabled={doc.content === doc.saved}>
              Save
            </button>
          )}
        </div>
        {active && doc?.error ? (
          <div className="editor-empty">{doc.error}</div>
        ) : active && doc ? (
          <Editor
            height="100%"
            theme={theme === "dark" ? "jin-dark" : "jin-light"}
            path={active}
            language={language(active)}
            value={doc.content}
            beforeMount={defineTheme}
            onMount={onMount}
            onChange={(v) => {
              const p = activeRef.current;
              if (p) setDocs((d) => ({ ...d, [p]: { ...d[p]!, content: v ?? "" } }));
            }}
            options={{ fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", minimap: { enabled: false }, scrollBeyondLastLine: false, smoothScrolling: true, renderLineHighlight: "line", automaticLayout: true }}
          />
        ) : (
          <div className="editor-empty">{active ? "Loading…" : "Pick a file to view or edit it. Changes save to the task's worktree."}</div>
        )}
      </div>
    </div>
  );
}
