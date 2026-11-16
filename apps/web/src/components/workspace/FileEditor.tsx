"use client";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import { ChevronDown, ChevronRight, ClipboardCopy, File, Folder, X, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { listFiles, readFile, writeFile } from "@/app/actions";
import type { FileEntry } from "@/lib/daemon";
import { useArmedConfirm } from "@/lib/confirm";
import { registerTabs, touchTab, unregisterTabs } from "@/lib/tabs";
import { useResolvedTheme } from "@/lib/theme";
import { contextMenu, type MenuItem } from "../ContextMenu";

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

  // Files opened from the finder or search, optionally at a line.
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const pendingLine = useRef<number | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ taskId: string; path: string; line?: number }>).detail;
      if (d.taskId !== taskId) return;
      pendingLine.current = d.line ?? null;
      // Already the active file: nothing re-renders, so reveal the line now.
      if (activeRef.current === d.path) requestAnimationFrame(() => revealPendingRef.current());
      open(d.path);
    };
    window.addEventListener("jin:open-file", onOpen);
    return () => window.removeEventListener("jin:open-file", onOpen);
  }, [taskId, open]);
  const revealPendingRef = useRef<() => void>(() => {});
  const revealPending = useCallback(() => {
    const ed = editorRef.current;
    const line = pendingLine.current;
    if (!ed || !line) return;
    pendingLine.current = null;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
  }, []);
  revealPendingRef.current = revealPending;

  // The tab switcher (⌘E) lists open files and can bring one to front.
  const owner = `files:${taskId}`;
  useEffect(() => {
    registerTabs(
      owner,
      tabs.map((p) => ({
        id: `file:${taskId}:${p}`,
        group: "file" as const,
        label: base(p),
        detail: `${taskId} · ${p}`,
        activate: () => {
          setActive(p);
          window.dispatchEvent(new CustomEvent("jin:show-pane-tab", { detail: { taskId, tab: "editor" } }));
        },
      })),
    );
  }, [owner, tabs, taskId]);
  useEffect(() => () => unregisterTabs(owner), [owner]);
  useEffect(() => {
    if (active) touchTab(`file:${taskId}:${active}`);
  }, [active, taskId]);

  const confirmClose = useArmedConfirm();
  const close = (p: string, confirmed = false) => {
    const doc = docsRef.current[p];
    // Unsaved changes: the first click asks, the second closes and drops them.
    if (!confirmed && doc && doc.content !== doc.saved && !confirmClose.ask(p)) return;
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

  const dirty = (p: string) => {
    const d = docsRef.current[p];
    return Boolean(d && d.content !== d.saved);
  };
  const fileMenu = (p: string): MenuItem[] => [
    { header: base(p) },
    { label: "Close", icon: X, ...(dirty(p) ? { danger: true, confirm: "Close without saving?" } : {}), run: () => close(p, true) },
    {
      label: "Close others",
      icon: XCircle,
      disabled: tabs.length < 2,
      ...(tabs.some((o) => o !== p && dirty(o)) ? { danger: true, confirm: "Close others, dropping unsaved changes?" } : {}),
      run: () => {
        for (const o of tabs) if (o !== p) close(o, true);
      },
    },
    { label: "Close all", icon: XCircle, ...(tabs.some(dirty) ? { danger: true, confirm: "Close all, dropping unsaved changes?" } : {}), run: () => tabs.forEach((o) => close(o, true)) },
    { divider: true },
    { label: "Copy path", icon: ClipboardCopy, hint: "in the task", run: () => void navigator.clipboard?.writeText(p) },
  ];

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
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
    revealPending();
  };
  // A file already loaded: reveal its line as soon as it is active.
  useEffect(() => {
    if (active && docs[active] && !docs[active]!.error) requestAnimationFrame(revealPending);
  }, [active, docs, revealPending]);

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
                <div key={p} role="tab" aria-selected={p === active} className={`file-tab ${p === active ? "is-active" : ""}`} title={p} onClick={() => setActive(p)} onAuxClick={(e) => e.button === 1 && close(p)} {...contextMenu(() => fileMenu(p))}>
                  <span className="file-tab-name">{base(p)}</span>
                  {dirty && <span className="dirty-dot" aria-label="unsaved" />}
                  <button
                    type="button"
                    className={`file-tab-close ${confirmClose.armed === p ? "is-armed" : ""}`}
                    aria-label={confirmClose.armed === p ? `Click again to close ${base(p)} without saving` : `Close ${base(p)}`}
                    title={confirmClose.armed === p ? "Unsaved changes: click again to close without saving" : `Close ${base(p)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      close(p);
                    }}
                  >
                    {confirmClose.armed === p ? "Close?" : <X size={12} />}
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
