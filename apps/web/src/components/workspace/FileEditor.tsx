"use client";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { listFiles, readFile, writeFile } from "@/app/actions";
import type { FileEntry } from "@/lib/daemon";

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", go: "go", py: "python", yaml: "yaml", yml: "yaml", sh: "shell", css: "css",
  html: "html", sql: "sql", prisma: "graphql", graphql: "graphql", toml: "ini", rs: "rust", dockerfile: "dockerfile",
};
const language = (path: string) => LANG[(path.split(".").pop() ?? "").toLowerCase()] ?? (path.endsWith("Dockerfile") ? "dockerfile" : "plaintext");

// The dark coding tokens (tokens.css [data-theme="dark"]) as a Monaco theme.
const defineTheme: BeforeMount = (monaco) => {
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

/** File tree and editor for the task's worktrees; Cmd/Ctrl+S saves. */
export function FileEditor({ taskId }: { taskId: string }) {
  const [roots, setRoots] = useState<FileEntry[] | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const pathRef = useRef<string | null>(null);
  const contentRef = useRef("");

  useEffect(() => {
    void listFiles(taskId, "").then(setRoots).catch((e) => setNote(String(e)));
  }, [taskId]);

  const open = useCallback(
    async (p: string) => {
      const res = await readFile(taskId, p);
      if ("error" in res) {
        setNote(res.error);
        return;
      }
      setNote(null);
      setPath(p);
      pathRef.current = p;
      setContent(res.content);
      contentRef.current = res.content;
      setSaved(res.content);
    },
    [taskId],
  );

  const save = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    try {
      await writeFile(taskId, p, contentRef.current);
      setSaved(contentRef.current);
      setNote(`saved ${p}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }, [taskId]);

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
  };

  const dirty = path !== null && content !== saved;
  return (
    <div className="file-editor">
      <nav className="file-tree" data-scroll="y" aria-label="Files">
        {roots === null ? (
          <p className="meta pad">Loading…</p>
        ) : (
          <ul>
            {roots.map((e) => (
              <TreeNode key={e.path} taskId={taskId} entry={e} depth={0} open={path} onOpen={(p) => void open(p)} />
            ))}
          </ul>
        )}
      </nav>
      <div className="editor-main">
        <div className="editor-bar">
          <span className="editor-path">{path ?? "Open a file from the tree"}</span>
          {dirty && <span className="dirty-dot" title="Unsaved changes" />}
          {note && <span className="meta">{note}</span>}
          {path && (
            <button type="button" className="button quiet" onClick={() => void save()} disabled={!dirty}>
              Save
            </button>
          )}
        </div>
        {path ? (
          <Editor
            height="100%"
            theme="jin-dark"
            path={path}
            language={language(path)}
            value={content}
            beforeMount={defineTheme}
            onMount={onMount}
            onChange={(v) => {
              setContent(v ?? "");
              contentRef.current = v ?? "";
            }}
            options={{ fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", minimap: { enabled: false }, scrollBeyondLastLine: false, smoothScrolling: true, renderLineHighlight: "line", automaticLayout: true }}
          />
        ) : (
          <div className="editor-empty">Pick a file to view or edit it. Changes save to the task's worktree.</div>
        )}
      </div>
    </div>
  );
}
