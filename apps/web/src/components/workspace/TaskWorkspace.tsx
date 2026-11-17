"use client";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Activity, Archive, ArchiveRestore, ClipboardCopy, File, FolderTree, GitCompare, NotebookPen, PanelRightClose, GitFork, PanelRightOpen, Pencil, Play, Plus, RotateCcw, SquareTerminal, X, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { archivedTerminals, closeTerminal, openTerminal, readFile, restartTerminal, startTerminal, updateTerminal, writeFile } from "@/app/actions";
import { useArmedConfirm } from "@/lib/confirm";
import type { AgentStatus, TaskPR, TerminalInfo } from "@/lib/daemon";
import { setActiveTerminal } from "@/lib/presence";
import { useTabShortcuts } from "@/lib/shortcuts";
import { registerTabs, touchTab, unregisterTabs } from "@/lib/tabs";
import { readLayout, updateLayout } from "@/lib/layout";
import { useResolvedTheme } from "@/lib/theme";
import { contextMenu, openContextMenu, type MenuItem } from "../ContextMenu";
import { RenameInput } from "../RenameInput";
import { StatusMark, ThermalMark } from "../ThermalMark";
import { Panes } from "../Panes";
import { type SideTab, TaskSidePanel } from "./TaskSidePanel";
import { TaskLabel, TaskPRBadges } from "./TaskPRs";
import { DiffView } from "./DiffView";
import { base, defineTheme, language } from "./monaco";
import { TerminalView } from "./TerminalView";

const MARK: Record<AgentStatus, "running" | "waiting_approval" | "idle" | "interrupted"> = {
  starting: "running",
  working: "running",
  waiting: "waiting_approval",
  idle: "idle",
  exited: "interrupted",
  interrupted: "interrupted",
};
const running = (t: TerminalInfo) => t.status !== "exited" && t.status !== "interrupted";

// Opening is not idempotent and React runs effects twice in development: one request per key.
const pending = new Map<string, Promise<TerminalInfo>>();
function once(key: string, fn: () => Promise<TerminalInfo>): Promise<TerminalInfo> {
  let p = pending.get(key);
  if (!p) {
    p = fn().finally(() => setTimeout(() => pending.delete(key), 1500));
    pending.set(key, p);
  }
  return p;
}

interface Doc {
  content: string;
  saved: string;
  error?: string;
}

/** Tab keys: "t:<terminal id>", "f:<file path>", or "changes". */
type Key = string;
const termKey = (id: string) => `t:${id}`;
const fileKey = (p: string) => `f:${p}`;

/**
 * A task as one row of tabs: Claude Code sessions, terminals, open files and the diff, with
 * one body below. Terminals persist (daemon-side) across reloads and restarts; an interrupted
 * one starts again when shown, and Claude Code resumes its conversation.
 */
export function TaskWorkspace({
  taskId,
  subtitle,
  terminals,
  prs,
  wsBase,
}: {
  taskId: string;
  subtitle: string;
  terminals: TerminalInfo[];
  prs: TaskPR[];
  wsBase: string;
}) {
  const router = useRouter();
  const root = useRef<HTMLElement>(null);
  const editorTheme = useResolvedTheme(root);
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------- terminals
  const [local, setLocal] = useState<Record<string, TerminalInfo>>({});
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const started = useRef(new Set<string>());
  const remember = (t: TerminalInfo) => setLocal((l) => ({ ...l, [t.id]: t }));
  const unhide = (id: string) =>
    setClosed((c) => {
      const next = new Set(c);
      next.delete(id);
      return next;
    });

  // Server list (refreshed by the shell), overlaid with what this view just created or started.
  const terms = useMemo(() => {
    const byId = new Map(terminals.map((t) => [t.id, t]));
    for (const t of Object.values(local)) {
      const server = byId.get(t.id);
      if (!server || (!running(server) && running(t))) byId.set(t.id, t);
    }
    // Claude Code sessions first, then shells; each oldest first.
    return [...byId.values()].filter((t) => !closed.has(t.id)).sort((a, b) => (a.kind === b.kind ? a.createdAt.localeCompare(b.createdAt) : a.kind === "claude" ? -1 : 1));
  }, [terminals, local, closed]);

  // ---------------------------------------------------------------- files
  const filesKey = `jin-files:${taskId}`;
  const [files, setFiles] = useState<string[]>([]);
  const [docs, setDocs] = useState<Record<string, Doc>>({});
  const [changesOpen, setChangesOpen] = useState(false);
  // The right panel shows files or the work journal (remembered across tasks).
  const [side, setSideState] = useState<SideTab>("files");
  useEffect(() => {
    try {
      const t = localStorage.getItem("jin-task-side");
      if (t === "files" || t === "journal" || t === "activity") setSideState(t);
    } catch {}
  }, []);
  const setSide = (t: SideTab) => {
    setSideState(t);
    try {
      localStorage.setItem("jin-task-side", t);
    } catch {}
    // Choosing one shows the panel if it was hidden.
    if (readLayout().asideHidden?.task) updateLayout((l) => ({ ...l, asideHidden: { ...l.asideHidden, task: false } }));
  };
  const docsRef = useRef(docs);
  docsRef.current = docs;

  // ---------------------------------------------------------------- the active tab
  const activeKey = `jin-task-tab:${taskId}`;
  const [active, setActiveState] = useState<Key | null>(null);
  const activeRef = useRef<Key | null>(null);
  activeRef.current = active;
  const setActive = (k: Key | null) => setActiveState(k);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(filesKey) ?? "null") as { tabs?: string[] } | null;
      if (saved?.tabs?.length) setFiles(saved.tabs);
      // ?terminal=<id> (a notification's link) opens that Claude Code tab; else the last one you had open.
      const wanted = new URLSearchParams(window.location.search).get("terminal");
      setActiveState(wanted ? termKey(wanted) : localStorage.getItem(activeKey));
    } catch {}
  }, [filesKey, activeKey]);
  useEffect(() => {
    try {
      localStorage.setItem(filesKey, JSON.stringify({ tabs: files }));
      if (active) localStorage.setItem(activeKey, active);
    } catch {}
  }, [filesKey, activeKey, files, active]);

  const tabs: Key[] = [...terms.map((t) => termKey(t.id)), ...files.map(fileKey), ...(changesOpen ? ["changes"] : [])];
  const current: Key | null = active && tabs.includes(active) ? active : (tabs[0] ?? null);
  const currentTerm = current?.startsWith("t:") ? (terms.find((t) => termKey(t.id) === current) ?? null) : null;
  const currentFile = current?.startsWith("f:") ? current.slice(2) : null;

  useEffect(() => {
    if (current) touchTab(current);
  }, [current]);

  // ---------------------------------------------------------------- terminal actions
  const create = useCallback(
    (kind: "claude" | "shell") =>
      once(`${taskId}:${kind}:new:${terms.filter((t) => t.kind === kind).length}`, () => openTerminal({ taskId, kind }))
        .then((t) => {
          remember(t);
          setActive(termKey(t.id));
          router.refresh();
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [taskId, terms, router],
  );
  /** A new tab that carries on from this one's conversation (Claude Code --fork-session). */
  const fork = (t: TerminalInfo) =>
    openTerminal({ taskId, kind: "claude", forkFrom: t.id })
      .then((n) => {
        remember(n);
        setActive(termKey(n.id));
        router.refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  const start = (id: string) =>
    once(`start:${id}`, () => startTerminal(id))
      .then(remember)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  // A task always has something open: its first Claude Code session.
  useEffect(() => {
    if (terminals.length === 0 && terms.length === 0 && files.length === 0) void create("claude");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terms.length, files.length]);

  // An interrupted tab (daemon restart) starts again when shown, once.
  useEffect(() => {
    if (currentTerm?.status === "interrupted" && !started.current.has(currentTerm.id)) {
      started.current.add(currentTerm.id);
      void start(currentTerm.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTerm?.id, currentTerm?.status]);

  // The Claude Code session on screen: jin does not notify about it while you watch.
  useEffect(() => {
    setActiveTerminal(currentTerm?.kind === "claude" ? currentTerm.id : null);
    return () => setActiveTerminal(null);
  }, [currentTerm?.id, currentTerm?.kind]);

  const confirm = useArmedConfirm();
  /** Leaving the open tab moves to its neighbour. */
  const leave = (k: Key) => {
    if (current !== k) return;
    const i = tabs.indexOf(k);
    setActive(tabs[i + 1] ?? tabs[i - 1] ?? null);
  };
  const closeTerm = async (t: TerminalInfo, confirmed = false) => {
    // A running Claude Code session ends when its tab closes: the first click asks, the second closes.
    if (!confirmed && t.kind === "claude" && running(t) && !confirm.ask(termKey(t.id))) return;
    leave(termKey(t.id));
    setClosed((c) => new Set(c).add(t.id));
    await closeTerminal(t.id).catch(() => {});
    router.refresh();
  };
  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = async (t: TerminalInfo, title: string) => {
    setRenaming(null);
    remember(await updateTerminal(t.id, { title }));
    router.refresh();
  };
  const archive = async (t: TerminalInfo) => {
    leave(termKey(t.id));
    setClosed((c) => new Set(c).add(t.id));
    await updateTerminal(t.id, { archived: true }).catch(() => {});
    router.refresh();
  };

  // ---------------------------------------------------------------- file actions
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const pendingLine = useRef<number | null>(null);
  const revealPending = useCallback(() => {
    const ed = editorRef.current;
    const line = pendingLine.current;
    if (!ed || !line) return;
    pendingLine.current = null;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
  }, []);

  const openFile = useCallback(
    (p: string, line?: number) => {
      pendingLine.current = line ?? null;
      if (activeRef.current === fileKey(p)) requestAnimationFrame(revealPending);
      setFiles((f) => (f.includes(p) ? f : [...f, p]));
      setActive(fileKey(p));
    },
    [revealPending],
  );
  const showChanges = useCallback(() => {
    setChangesOpen(true);
    setActive("changes");
  }, []);

  // Load a file the first time its tab is shown.
  useEffect(() => {
    if (!currentFile || docs[currentFile]) return;
    const p = currentFile;
    void readFile(taskId, p).then((res) => setDocs((d) => ({ ...d, [p]: "error" in res ? { content: "", saved: "", error: res.error } : { content: res.content, saved: res.content } })));
  }, [currentFile, docs, taskId]);
  useEffect(() => {
    if (currentFile && docs[currentFile] && !docs[currentFile]!.error) requestAnimationFrame(revealPending);
  }, [currentFile, docs, revealPending]);

  const dirty = (p: string) => {
    const d = docsRef.current[p];
    return Boolean(d && d.content !== d.saved);
  };
  const closeFile = (p: string, confirmed = false) => {
    if (!confirmed && dirty(p) && !confirm.ask(fileKey(p))) return;
    leave(fileKey(p));
    setFiles((f) => f.filter((x) => x !== p));
    setDocs((d) => {
      const { [p]: _, ...rest } = d;
      return rest;
    });
  };
  const [note, setNote] = useState<string | null>(null);
  const save = useCallback(async () => {
    const k = activeRef.current;
    const p = k?.startsWith("f:") ? k.slice(2) : null;
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

  // ⌘T a new Claude Code session, ⌘W close the open tab (as its × does), ⌘1–9 a tab.
  useTabShortcuts({
    count: tabs.length,
    create: () => void create("claude"),
    select: (i) => tabs[i] && setActive(tabs[i]!),
    close: () => {
      if (!current) return;
      if (current === "changes") {
        leave("changes");
        setChangesOpen(false);
      } else if (current.startsWith("f:")) closeFile(current.slice(2));
      else {
        const t = terms.find((x) => termKey(x.id) === current);
        if (t) void closeTerm(t);
      }
    },
  });

  // ---------------------------------------------------------------- outside requests
  // The palette's finder opens files, and its commands open sessions, terminals and the diff.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ taskId: string; path: string; line?: number }>).detail;
      if (d.taskId === taskId) openFile(d.path, d.line);
    };
    const onNew = (e: Event) => {
      const d = (e as CustomEvent<{ taskId: string; kind: "claude" | "shell" }>).detail;
      if (d.taskId === taskId) void create(d.kind);
    };
    const onShow = (e: Event) => {
      const d = (e as CustomEvent<{ taskId: string; tab?: string }>).detail;
      if (d.taskId !== taskId) return;
      if (d.tab === "diff") showChanges();
      else if (d.tab === "editor" && files.length) setActive(fileKey(files.at(-1)!));
      else if (d.tab === "terminal") {
        const shell = terms.filter((t) => t.kind === "shell").at(-1);
        if (shell) setActive(termKey(shell.id));
        else void create("shell");
      }
    };
    window.addEventListener("jin:open-file", onOpen);
    window.addEventListener("jin:new-tab", onNew);
    window.addEventListener("jin:show-pane-tab", onShow);
    return () => {
      window.removeEventListener("jin:open-file", onOpen);
      window.removeEventListener("jin:new-tab", onNew);
      window.removeEventListener("jin:show-pane-tab", onShow);
    };
  }, [taskId, openFile, showChanges, create, files, terms]);

  // The tab switcher (⌘E) lists every tab and can bring one to front.
  const owner = `task:${taskId}`;
  useEffect(() => {
    registerTabs(owner, [
      ...terms.map((t) => ({
        id: termKey(t.id),
        group: t.kind,
        label: t.title,
        detail: `${taskId} · ${t.kind === "claude" ? `Claude Code · ${t.status}` : "shell"}`,
        activate: () => setActive(termKey(t.id)),
      })),
      ...files.map((p) => ({ id: fileKey(p), group: "file" as const, label: base(p), detail: `${taskId} · ${p}`, activate: () => setActive(fileKey(p)) })),
    ]);
  }, [owner, terms, files, taskId]);
  useEffect(() => () => unregisterTabs(owner), [owner]);

  // ---------------------------------------------------------------- menus
  const termMenu = (t: TerminalInfo): MenuItem[] => [
    { label: "Rename", icon: Pencil, run: () => setRenaming(t.id) },
    {
      label: "Restart",
      icon: RotateCcw,
      run: async () => {
        setActive(termKey(t.id));
        started.current.add(t.id);
        remember(await restartTerminal(t.id));
      },
    },
    ...(t.kind === "claude"
      ? ([
          ...(t.claudeSessionId ? [{ label: "Fork", icon: GitFork, run: () => void fork(t) }] : []),
          { label: "Archive", icon: Archive, run: () => archive(t) },
          ...(t.claudeSessionId ? [{ label: "Copy session id", icon: ClipboardCopy, run: () => void navigator.clipboard?.writeText(t.claudeSessionId!) }] : []),
        ] satisfies MenuItem[])
      : []),
    { divider: true },
    { label: "Close", icon: X, ...(t.kind === "claude" && running(t) ? { danger: true, confirm: "Close and end the session?" } : {}), run: () => closeTerm(t, true) },
  ];
  const fileMenu = (p: string): MenuItem[] => [
    { header: p },
    { label: "Close", icon: X, ...(dirty(p) ? { danger: true, confirm: "Close without saving?" } : {}), run: () => closeFile(p, true) },
    {
      label: "Close other files",
      icon: XCircle,
      disabled: files.length < 2,
      ...(files.some((o) => o !== p && dirty(o)) ? { danger: true, confirm: "Close others, dropping unsaved changes?" } : {}),
      run: () => files.forEach((o) => o !== p && closeFile(o, true)),
    },
    { label: "Close all files", icon: XCircle, ...(files.some(dirty) ? { danger: true, confirm: "Close all, dropping unsaved changes?" } : {}), run: () => files.forEach((o) => closeFile(o, true)) },
    { divider: true },
    { label: "Copy path", icon: ClipboardCopy, hint: "in the task", run: () => void navigator.clipboard?.writeText(p) },
  ];

  /** Right-click "+": bring back an archived Claude Code session (it resumes where it left off). */
  const restoreMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const point = { clientX: e.clientX, clientY: e.clientY };
    const items: MenuItem[] = [
      { label: "New Claude Code session", icon: Plus, run: () => void create("claude") },
      { label: "New terminal", icon: SquareTerminal, run: () => void create("shell") },
    ];
    const old = (await archivedTerminals(taskId).catch(() => [] as TerminalInfo[])).filter((t) => t.kind === "claude");
    if (old.length) {
      items.push({ divider: true }, { header: "Archived sessions" });
      for (const t of old)
        items.push({
          label: t.title,
          icon: ArchiveRestore,
          hint: new Date(t.createdAt).toLocaleDateString(),
          run: async () => {
            const back = await updateTerminal(t.id, { archived: false });
            unhide(back.id);
            remember(back);
            setActive(termKey(back.id));
            router.refresh();
          },
        });
    }
    openContextMenu(point, items);
  };

  // ---------------------------------------------------------------- render
  const closeButton = (k: Key, label: string, onClose: () => void, armedText: string) => (
    <button
      type="button"
      className={`file-tab-close ${confirm.armed === k ? "is-armed" : ""}`}
      aria-label={confirm.armed === k ? armedText : `Close ${label}`}
      title={confirm.armed === k ? armedText : `Close ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      {confirm.armed === k ? "Close?" : <X size={12} />}
    </button>
  );
  const doc = currentFile ? docs[currentFile] : undefined;

  return (
    <section className="task-workspace" ref={root} aria-label={`Task ${taskId}`}>
      <header className="pane-header has-tabs task-bar">
        <div className="task-tabs" role="tablist" aria-label={`${taskId} tabs`}>
          {terms.map((t) => {
            const k = termKey(t.id);
            return (
              <div key={k} role="tab" tabIndex={0} aria-selected={current === k} className={`term-tab ${current === k ? "is-active" : ""}`} title={t.kind === "claude" ? `${t.title} · Claude Code · ${t.status}` : `${t.title} · terminal`} onClick={() => setActive(k)} onDoubleClick={() => setRenaming(t.id)} {...contextMenu(() => termMenu(t))}>
                {t.kind === "claude" ? <StatusMark state={MARK[t.status]} /> : <SquareTerminal size={13} className="tab-icon" />}
                {renaming === t.id ? <RenameInput value={t.title} label={`Rename ${t.title}`} onCancel={() => setRenaming(null)} onSave={(v) => void rename(t, v)} /> : <span className="term-tab-name">{t.title}</span>}
                {closeButton(k, t.title, () => void closeTerm(t), "Click again to close; the Claude Code session ends")}
              </div>
            );
          })}
          {files.map((p) => {
            const k = fileKey(p);
            return (
              <div key={k} role="tab" tabIndex={0} aria-selected={current === k} className={`term-tab ${current === k ? "is-active" : ""}`} title={p} onClick={() => setActive(k)} onAuxClick={(e) => e.button === 1 && closeFile(p)} {...contextMenu(() => fileMenu(p))}>
                <File size={13} className="tab-icon" />
                <span className="term-tab-name">{base(p)}</span>
                {dirty(p) && <span className="dirty-dot" aria-label="unsaved" />}
                {closeButton(k, base(p), () => closeFile(p), "Unsaved changes: click again to close without saving")}
              </div>
            );
          })}
          {changesOpen && (
            <div role="tab" tabIndex={0} aria-selected={current === "changes"} className={`term-tab ${current === "changes" ? "is-active" : ""}`} onClick={() => setActive("changes")}>
              <GitCompare size={13} className="tab-icon" />
              <span className="term-tab-name">Changes</span>
              {closeButton("changes", "Changes", () => (leave("changes"), setChangesOpen(false)), "Close")}
            </div>
          )}
        </div>
        <NewTab onClaude={() => void create("claude")} onShell={() => void create("shell")} onRestore={(e) => void restoreMenu(e)} />
        <TaskPRBadges taskId={taskId} prs={prs} />
        <TaskLabel taskId={taskId} subtitle={subtitle} />
        <div className="pane-actions">
          <div className="side-switch" role="tablist" aria-label="Right panel">
            <button type="button" role="tab" aria-selected={side === "files"} className={`button quiet icon-only${side === "files" ? " is-active" : ""}`} onClick={() => setSide("files")} title="Files" aria-label="Files">
              <FolderTree size={14} />
            </button>
            <button type="button" role="tab" aria-selected={side === "journal"} className={`button quiet icon-only${side === "journal" ? " is-active" : ""}`} onClick={() => setSide("journal")} title="Journal: what Claude Code decided and did" aria-label="Journal">
              <NotebookPen size={14} />
            </button>
            <button type="button" role="tab" aria-selected={side === "activity"} className={`button quiet icon-only${side === "activity" ? " is-active" : ""}`} onClick={() => setSide("activity")} title="Activity: its PRs, issue, and the Slack threads and Notion pages it follows" aria-label="Activity">
              <Activity size={14} />
            </button>
          </div>
          <button type="button" className="button quiet icon-only" onClick={showChanges} title="Changes: the task's uncommitted diff" aria-label="Show changes">
            <GitCompare size={14} />
          </button>
          <FilesToggle />
        </div>
      </header>

      <Panes id="task" defaultSplit={80} minLeft={480} minRight={180} toggle={false} left={<div className="task-body">
        {currentTerm ? (
          running(currentTerm) ? (
            <TerminalView key={currentTerm.id} terminalId={currentTerm.id} wsBase={wsBase} active autoFocus onState={(s) => s === "exited" && remember({ ...currentTerm, status: "exited" })} />
          ) : currentTerm.status === "exited" ? (
            <div className="editor-empty">
              <p>{currentTerm.kind === "claude" ? "Claude Code exited." : "The shell exited."}</p>
              <button type="button" className="button" onClick={() => void start(currentTerm.id)}>
                <Play size={13} /> {currentTerm.kind === "claude" && currentTerm.claudeSessionId ? "Resume the conversation" : "Start again"}
              </button>
            </div>
          ) : (
            <div className="editor-empty">
              {error ?? (
                <>
                  <ThermalMark size={24} state="working" /> {currentTerm.kind === "claude" ? "Resuming Claude Code…" : "Starting the shell…"}
                </>
              )}
            </div>
          )
        ) : currentFile ? (
          <div className="editor-main">
            <div className="editor-bar">
              <span className="editor-path">{currentFile}</span>
              {note && <span className="meta">{note}</span>}
              {doc && !doc.error && (
                <button type="button" className="button quiet small" onClick={() => void save()} disabled={doc.content === doc.saved}>
                  Save
                </button>
              )}
            </div>
            {doc?.error ? (
              <div className="editor-empty">{doc.error}</div>
            ) : doc ? (
              <Editor
                height="100%"
                theme={editorTheme === "dark" ? "jin-dark" : "jin-light"}
                path={currentFile}
                language={language(currentFile)}
                value={doc.content}
                beforeMount={defineTheme}
                onMount={(editor, monaco) => {
                  editorRef.current = editor;
                  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
                  revealPending();
                }}
                onChange={(v) => {
                  const k = activeRef.current;
                  const p = k?.startsWith("f:") ? k.slice(2) : null;
                  if (p) setDocs((d) => ({ ...d, [p]: { ...d[p]!, content: v ?? "" } }));
                }}
                options={{ fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", minimap: { enabled: false }, scrollBeyondLastLine: false, smoothScrolling: true, renderLineHighlight: "line", automaticLayout: true }}
              />
            ) : (
              <div className="editor-empty">Loading…</div>
            )}
          </div>
        ) : current === "changes" ? (
          <DiffView taskId={taskId} active />
        ) : (
          <div className="editor-empty">{error ?? "Open a Claude Code session or a terminal with +, or a file from the tree."}</div>
        )}
      </div>} right={<TaskSidePanel tab={side} taskId={taskId} openPath={currentFile} onOpen={(p) => openFile(p)} />} />
    </section>
  );
}

/** "+": a Claude Code session on click; hover to choose a terminal instead; right-click for archived sessions. */
function NewTab({ onClaude, onShell, onRestore }: { onClaude: () => void; onShell: () => void; onRestore: (e: React.MouseEvent) => void }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = () => {
    clearTimeout(timer.current);
    setOpen(true);
  };
  const hide = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 180);
  };
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="tab-new" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <button type="button" className="term-tab-new" onClick={pick(onClaude)} onContextMenu={onRestore} aria-label="New tab" aria-haspopup="menu" aria-expanded={open} title="New Claude Code session (hover for a terminal; right-click for archived sessions)">
        <Plus size={14} />
      </button>
      {open && (
        <div className="tab-new-menu" role="menu">
          <button type="button" role="menuitem" onClick={pick(onClaude)}>
            <ThermalMark size={13} animated={false} variant="blob" /> Claude Code session
          </button>
          <button type="button" role="menuitem" onClick={pick(onShell)}>
            <SquareTerminal size={13} /> Terminal
          </button>
        </div>
      )}
    </div>
  );
}

/** Show or hide the file tree on the right (remembered with the rest of the layout). */
function FilesToggle() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const sync = () => setHidden(Boolean(readLayout().asideHidden?.task));
    sync();
    window.addEventListener("jin-layout", sync);
    return () => window.removeEventListener("jin-layout", sync);
  }, []);
  return (
    <button
      type="button"
      className="button quiet icon-only"
      onClick={() => updateLayout((l) => ({ ...l, asideHidden: { ...l.asideHidden, task: !l.asideHidden?.task } }))}
      title={hidden ? "Show the side panel" : "Hide the side panel"}
      aria-label={hidden ? "Show the side panel" : "Hide the side panel"}
    >
      {hidden ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
    </button>
  );
}
