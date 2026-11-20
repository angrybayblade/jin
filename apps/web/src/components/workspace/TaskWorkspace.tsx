"use client";
import { Empty, Failed, Loading } from "@/components/States";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Activity, Archive, ArchiveRestore, ClipboardCopy, File, FileText, FolderTree, GitCompare, GitPullRequest, MoreHorizontal, NotebookPen, PanelRightClose, Users, UserPlus, Square, Trash2, GitFork, PanelRightOpen, Pencil, Play, Plus, RotateCcw, SquareTerminal, X, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { archivedTerminals, clearRoom, closeTerminal, createTaskDoc, docTab, getRoom, listDocs, roomAgentAction, roomStatus, relabelTaskDoc, renameDoc, openTerminal, readFile, restartTerminal, startTerminal, updateTerminal, writeFile } from "@/app/actions";
import { DocPage } from "../docs/DocPage";
import { docMenu } from "../docs/docMenu";
import type { DocFull, Session, SessionEvent } from "@/lib/daemon";
import { useArmedConfirm } from "@/lib/confirm";
import { AGENT_LABEL, fromTerminal } from "@/lib/agent-state";
import { act } from "@/lib/notices";
import type { TaskPR, TerminalInfo } from "@/lib/daemon";
import { setActiveTerminal } from "@/lib/presence";
import { useTabShortcuts } from "@/lib/shortcuts";
import { registerTabs, touchTab, unregisterTabs } from "@/lib/tabs";
import { readLayout, updateLayout } from "@/lib/layout";
import { isPhone } from "@/lib/phone";
import { useResolvedTheme } from "@/lib/theme";
import { contextMenu, openContextMenu, type MenuItem } from "../ContextMenu";
import { RenameInput } from "../RenameInput";
import { StatusMark, ThermalMark } from "../ThermalMark";
import { Panes, type PhonePane } from "../Panes";
import { type SideTab, TaskSidePanel } from "./TaskSidePanel";
import { TaskLabel, TaskPRBadges } from "./TaskPRs";
import { DiffView } from "./DiffView";
import { base, defineTheme, language } from "./monaco";
import { TerminalView } from "./TerminalView";
import { RoomPanel } from "./RoomPanel";
import { Boundary } from "../Boundary";

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
const docKey = (id: string) => `d:${id}`;
type DocTab = { doc: DocFull; chat: { session: Session; events: SessionEvent[] } | null; wsBase: string } | { error: string };

/**
 * A task as one row of tabs: Claude Code sessions, terminals, open files and the diff, with
 * one body below. Terminals persist (daemon-side) across reloads and restarts; an interrupted
 * one starts again when shown, and Claude Code resumes its conversation.
 */
export function TaskWorkspace({
  machine,
  taskId,
  subtitle,
  terminals,
  prs,
  wsBase,
}: {
  /** The machine the task is on: what is remembered for it (open files, the active tab) is per machine. */
  machine: string;
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
  const scope = machine === "local" ? taskId : `${machine}:${taskId}`;
  const filesKey = `jin-files:${scope}`;
  const [files, setFiles] = useState<string[]>([]);
  const [docs, setDocs] = useState<Record<string, Doc>>({});
  const [changesOpen, setChangesOpen] = useState(false);
  // jin docs open as tabs (the task's own docs, made from "+"): their ids, what each needs, their titles.
  const [docTabs, setDocTabs] = useState<string[]>([]);
  const [docData, setDocData] = useState<Record<string, DocTab>>({});
  const [docTitles, setDocTitles] = useState<Record<string, string>>({});
  // The task's agent room is always a tab (one room per task).
  const roomOpen = true;
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
  // On a phone the tabs' body and the side panel are one at a time (the switcher under the bar).
  const [phonePane, setPhonePane] = useState<PhonePane>("left");
  const toBody = () => setPhonePane("left");

  // ---------------------------------------------------------------- the active tab
  const activeKey = `jin-task-tab:${scope}`;
  const [active, setActiveState] = useState<Key | null>(null);
  const activeRef = useRef<Key | null>(null);
  activeRef.current = active;
  const setActive = (k: Key | null) => setActiveState(k);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(filesKey) ?? "null") as { tabs?: string[]; docs?: string[]; room?: boolean } | null;
      if (saved?.tabs?.length) setFiles(saved.tabs);
      if (saved?.docs?.length) setDocTabs(saved.docs);
      // ?terminal=<id> (a notification's link) opens that Claude Code tab; else the last one you had open.
      const wanted = new URLSearchParams(window.location.search).get("terminal");
      setActiveState(wanted ? termKey(wanted) : localStorage.getItem(activeKey));
    } catch {}
  }, [filesKey, activeKey]);
  useEffect(() => {
    try {
      localStorage.setItem(filesKey, JSON.stringify({ tabs: files, docs: docTabs }));
      if (active) localStorage.setItem(activeKey, active);
    } catch {}
  }, [filesKey, activeKey, files, docTabs, active]);

  const tabs: Key[] = [...terms.map((t) => termKey(t.id)), ...(roomOpen ? ["room"] : []), ...docTabs.map(docKey), ...files.map(fileKey), ...(changesOpen ? ["changes"] : [])];
  const current: Key | null = active && tabs.includes(active) ? active : (tabs[0] ?? null);
  const currentTerm = current?.startsWith("t:") ? (terms.find((t) => termKey(t.id) === current) ?? null) : null;
  const currentFile = current?.startsWith("f:") ? current.slice(2) : null;
  const currentDoc = current?.startsWith("d:") ? current.slice(2) : null;

  // Every doc tab's title, even before it is shown.
  useEffect(() => {
    if (!docTabs.some((id) => !(id in docTitles))) return;
    void listDocs()
      .then((all) => setDocTitles((t) => ({ ...Object.fromEntries(all.filter((d) => docTabs.includes(d.id)).map((d) => [d.id, d.title])), ...t })))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docTabs.join(",")]);
  // A doc tab loads when first shown.
  useEffect(() => {
    if (!currentDoc || docData[currentDoc]) return;
    const id = currentDoc;
    void docTab(id).then((r) => {
      setDocData((d) => ({ ...d, [id]: r }));
      if (!("error" in r)) setDocTitles((t) => ({ ...t, [id]: r.doc.title }));
    });
  }, [currentDoc, docData]);
  const openRoom = () => setActive("room");
  // The Room tab says what goes on in it: agents working or waiting on you, and messages you have not seen.
  const [room, setRoom] = useState<{ working: number; waiting: number; lastSeq: number }>({ working: 0, waiting: 0, lastSeq: 0 });
  const [roomSeen, setRoomSeen] = useState(0);
  const [roomIntent, setRoomIntent] = useState<{ n: number; action: "add-agent" } | null>(null);
  const [roomEpoch, setRoomEpoch] = useState(0);
  const seenKey = `jin-room-seen:${scope}`;
  useEffect(() => {
    try {
      setRoomSeen(Number(localStorage.getItem(seenKey) ?? 0));
    } catch {}
    let live = true;
    const load = () => document.visibilityState === "visible" && void roomStatus(taskId).then((r) => live && r && setRoom(r));
    load();
    const t = setInterval(load, 4000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [taskId, seenKey]);
  const seeRoom = (seq: number) => {
    setRoomSeen((s) => Math.max(s, seq));
    try {
      localStorage.setItem(seenKey, String(seq));
    } catch {}
  };
  const roomMenu = (): MenuItem[] => [
    { label: "Add an agent", icon: UserPlus, run: () => (openRoom(), setRoomIntent((i) => ({ n: (i?.n ?? 0) + 1, action: "add-agent" }))) },
    {
      label: "Copy the conversation",
      icon: ClipboardCopy,
      hint: "markdown",
      run: async () => {
        const r = await getRoom(taskId, 0);
        if ("error" in r) return setError(r.error);
        const text = r.messages.map((m) => (m.kind === "note" ? `_${m.text}_` : `**${m.author === "you" ? "You" : `${m.authorName} (@${m.authorHandle})`}** · ${new Date(m.at).toLocaleString()}\n\n${m.text}`)).join("\n\n---\n\n");
        void navigator.clipboard?.writeText(`# ${taskId} · agent room\n\n${text}\n`);
      },
    },
    { divider: true },
    {
      label: "Stop every agent",
      icon: Square,
      disabled: room.working + room.waiting === 0,
      run: async () => {
        const r = await getRoom(taskId, Number.MAX_SAFE_INTEGER);
        if ("error" in r) return setError(r.error);
        await Promise.all(r.agents.filter((a) => a.state === "running" || a.state === "waiting_approval").map((a) => roomAgentAction(taskId, a.id, "stop")));
      },
    },
    {
      label: "Clear the room",
      icon: Trash2,
      danger: true,
      confirm: "Clear the room? Its messages go, and every agent starts a new session. The agents stay.",
      run: async () => {
        const r = await clearRoom(taskId);
        if ("error" in r) return setError(r.error);
        seeRoom(0);
        setRoom((x) => ({ ...x, lastSeq: 0 }));
        setRoomEpoch((n) => n + 1);
      },
    },
  ];
  /** Open a jin doc as a tab of this task (a doc an agent wrote in the room). */
  const openDocTab = (id: string) => {
    setDocTabs((t) => (t.includes(id) ? t : [...t, id]));
    setActive(docKey(id));
  };
  /** A new doc for this task: linked to it (its Claude Code can read it) and opened as a tab. */
  const newDoc = async () => {
    const d = await createTaskDoc(taskId);
    if ("error" in d) return setError(d.error);
    setDocTabs((t) => [...t, d.id]);
    setActive(docKey(d.id));
    router.refresh();
  };
  // The task's link to a doc takes the doc's title once you stop typing it (after the doc saved it).
  const relabel = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const relabelSoon = (id: string) => {
    clearTimeout(relabel.current);
    relabel.current = setTimeout(() => void relabelTaskDoc(taskId, id), 3000);
  };
  const [docRenaming, setDocRenaming] = useState<string | null>(null);
  const renameDocTab = async (id: string, v: string) => {
    setDocRenaming(null);
    const t = v.trim() || "Untitled";
    setDocTitles((x) => ({ ...x, [id]: t }));
    const r = await renameDoc(id, t);
    if ("error" in r) return setError(r.error);
    void relabelTaskDoc(taskId, id);
  };
  const docTabMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    openContextMenu(
      e,
      docMenu({
        doc: { id, title: docTitles[id] || "Untitled" },
        at: { clientX: e.clientX, clientY: e.clientY },
        rename: () => setDocRenaming(id),
        opened: (copy) => {
          setDocTabs((t) => [...t, copy]);
          setActive(docKey(copy));
        },
        gone: () => {
          closeDoc(id);
          router.refresh();
        },
        task: { id: taskId, machine, openInDocs: () => router.push(`/docs/${id}`) },
        onError: setError,
      }),
    );
  };
  const closeDoc = (id: string) => {
    leave(docKey(id));
    setDocTabs((t) => t.filter((x) => x !== id));
    setDocData((d) => {
      const { [id]: _, ...rest } = d;
      return rest;
    });
  };

  useEffect(() => {
    if (current) touchTab(current);
  }, [current]);

  // ---------------------------------------------------------------- terminal actions
  const create = useCallback(
    (kind: "claude" | "shell") =>
      once(`${scope}:${kind}:new:${terms.filter((t) => t.kind === kind).length}`, () => openTerminal({ taskId, kind }))
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
    once(`start:${machine}:${id}`, () => startTerminal(id))
      .then(remember)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  // A task always has something open: its first Claude Code session.
  useEffect(() => {
    if (terminals.length === 0 && terms.length === 0 && files.length === 0 && docTabs.length === 0) void create("claude");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terms.length, files.length, docTabs.length]);

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
    if ((await act(`Couldn't close ${t.title}`, async () => (await closeTerminal(t.id), true))) === null) unhide(t.id);
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
    if ((await act(`Couldn't archive ${t.title}`, () => updateTerminal(t.id, { archived: true }))) === null) unhide(t.id);
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
  const owner = `task:${scope}`;
  useEffect(() => {
    registerTabs(owner, [
      ...terms.map((t) => ({
        id: termKey(t.id),
        group: t.kind,
        label: t.title,
        detail: `${taskId} · ${t.kind === "claude" ? `Claude Code · ${AGENT_LABEL[fromTerminal(t.status)]}` : "shell"}`,
        activate: () => setActive(termKey(t.id)),
      })),
      { id: "room", group: "file" as const, label: "Room", detail: `${taskId} · agent room`, activate: () => setActive("room") },
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
      { label: "New document", icon: FileText, run: () => void newDoc() },
      { label: "Agent room", icon: Users, run: () => openRoom() },
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
              <div key={k} role="tab" tabIndex={0} aria-selected={current === k} className={`term-tab ${current === k ? "is-active" : ""}`} title={t.kind === "claude" ? `${t.title} · Claude Code · ${AGENT_LABEL[fromTerminal(t.status)]}` : `${t.title} · terminal`} onClick={() => (setActive(k), toBody())} onDoubleClick={() => setRenaming(t.id)} {...contextMenu(() => termMenu(t))}>
                {t.kind === "claude" ? <StatusMark state={fromTerminal(t.status)} /> : <SquareTerminal size={13} className="tab-icon" />}
                {renaming === t.id ? <RenameInput value={t.title} label={`Rename ${t.title}`} onCancel={() => setRenaming(null)} onSave={(v) => void rename(t, v)} /> : <span className="term-tab-name">{t.title}</span>}
                {closeButton(k, t.title, () => void closeTerm(t), "Click again to close; the Claude Code session ends")}
              </div>
            );
          })}
          {roomOpen && (
            <div role="tab" tabIndex={0} aria-selected={current === "room"} className={`term-tab ${current === "room" ? "is-active" : ""}`} title="Agent room: several agents, each with a role, that you direct" onClick={() => (setActive("room"), toBody())} {...contextMenu(roomMenu)}>
              {room.waiting > 0 ? <StatusMark state="needs-you" /> : room.working > 0 ? <StatusMark state="working" /> : <Users size={13} className="tab-icon" />}
              <span className="term-tab-name">Room</span>
              {current !== "room" && room.lastSeq > roomSeen && <span className="dirty-dot" aria-label="new messages" title="New messages" />}
            </div>
          )}
          {docTabs.map((id) => {
            const k = docKey(id);
            const name = docTitles[id] || "Untitled";
            return (
              <div key={k} role="tab" tabIndex={0} aria-selected={current === k} className={`term-tab ${current === k ? "is-active" : ""}`} title={`${name} · jin doc`} onClick={() => (setActive(k), toBody())} onDoubleClick={() => setDocRenaming(id)} onAuxClick={(e) => e.button === 1 && closeDoc(id)} onContextMenu={(e) => docTabMenu(e, id)}>
                <FileText size={13} className="tab-icon" />
                {docRenaming === id ? <RenameInput value={name} label="Doc title" onSave={(v) => void renameDocTab(id, v)} onCancel={() => setDocRenaming(null)} /> : <span className="term-tab-name">{name}</span>}
                {closeButton(k, name, () => closeDoc(id), "Close")}
              </div>
            );
          })}
          {files.map((p) => {
            const k = fileKey(p);
            return (
              <div key={k} role="tab" tabIndex={0} aria-selected={current === k} className={`term-tab ${current === k ? "is-active" : ""}`} title={p} onClick={() => (setActive(k), toBody())} onAuxClick={(e) => e.button === 1 && closeFile(p)} {...contextMenu(() => fileMenu(p))}>
                <File size={13} className="tab-icon" />
                <span className="term-tab-name">{base(p)}</span>
                {dirty(p) && <span className="dirty-dot" aria-label="unsaved" />}
                {closeButton(k, base(p), () => closeFile(p), "Unsaved changes: click again to close without saving")}
              </div>
            );
          })}
          {changesOpen && (
            <div role="tab" tabIndex={0} aria-selected={current === "changes"} className={`term-tab ${current === "changes" ? "is-active" : ""}`} onClick={() => (setActive("changes"), toBody())}>
              <GitCompare size={13} className="tab-icon" />
              <span className="term-tab-name">Changes</span>
              {closeButton("changes", "Changes", () => (leave("changes"), setChangesOpen(false)), "Close")}
            </div>
          )}
        </div>
        <NewTab onClaude={() => (void create("claude"), toBody())} onShell={() => (void create("shell"), toBody())} onDoc={() => (void newDoc(), toBody())} onRoom={() => (openRoom(), toBody())} onRestore={(e) => void restoreMenu(e)} />
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
        {/* A phone has no room for the label, PRs and icons: they are in this menu. */}
        <button
          type="button"
          className="button quiet icon-only task-more"
          title="More"
          aria-label="More"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openContextMenu({ clientX: r.right - 220, clientY: r.bottom + 4 }, [
              { header: `${taskId} · ${subtitle}` },
              { label: "Changes", icon: GitCompare, hint: "uncommitted diff", run: () => (showChanges(), toBody()) },
              { label: "New Claude Code session", icon: Plus, run: () => (void create("claude"), toBody()) },
              { label: "New terminal", icon: SquareTerminal, run: () => (void create("shell"), toBody()) },
              { label: "New document", icon: FileText, run: () => (void newDoc(), toBody()) },
              { label: "Agent room", icon: Users, run: () => (openRoom(), toBody()) },
              ...(prs.length ? [{ divider: true } as const, ...prs.map((p) => ({ label: `${p.repo}#${p.number}`, icon: GitPullRequest, hint: p.title ?? undefined, run: () => void window.open(p.url, "_blank", "noopener") }))] : []),
              { divider: true },
              { label: "Copy task id", icon: ClipboardCopy, run: () => void navigator.clipboard?.writeText(taskId) },
            ]);
          }}
        >
          <MoreHorizontal size={18} />
        </button>
      </header>
      <div className="phone-switch task-phone-switch" role="tablist" aria-label="Task panes">
        <button type="button" role="tab" aria-selected={phonePane === "left"} className={phonePane === "left" ? "is-active" : ""} onClick={toBody}>
          {currentFile ? "Editor" : current === "changes" ? "Changes" : "Terminal"}
        </button>
        {(
          [
            ["files", "Files"],
            ["journal", "Journal"],
            ["activity", "Activity"],
          ] as const
        ).map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={phonePane === "right" && side === t} className={phonePane === "right" && side === t ? "is-active" : ""} onClick={() => (setSide(t), setPhonePane("right"))}>
            {label}
          </button>
        ))}
      </div>

      <Panes id="task" defaultSplit={80} minLeft={480} minRight={180} toggle={false} phone={phonePane} onPhone={setPhonePane} phoneSwitch={false} left={<div className="task-body">
        {currentTerm ? (
          running(currentTerm) ? (
            <Boundary label="The terminal" resetKey={currentTerm.id}>
              <TerminalView key={currentTerm.id} terminalId={currentTerm.id} wsBase={wsBase} active autoFocus={!isPhone()} onState={(s) => s === "exited" && remember({ ...currentTerm, status: "exited" })} />
            </Boundary>
          ) : currentTerm.status === "exited" ? (
            <Empty
              place="pane"
              title={currentTerm.kind === "claude" ? "Claude Code exited" : "The shell exited"}
              action={
                <button type="button" className="button" onClick={() => void start(currentTerm.id)}>
                  <Play size={13} /> {currentTerm.kind === "claude" && currentTerm.claudeSessionId ? "Resume the conversation" : "Start again"}
                </button>
              }
            />
          ) : error ? (
            <Failed place="pane" message={error} />
          ) : (
            <Loading place="pane" label={currentTerm.kind === "claude" ? "Resuming Claude Code…" : "Starting the shell…"} />
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
              <Failed place="pane" message={doc.error} />
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
              <Loading place="pane" />
            )}
          </div>
        ) : currentDoc ? (
          (() => {
            const d = docData[currentDoc];
            if (!d) return <Loading place="pane" />;
            if ("error" in d) return <Failed place="pane" message={d.error} retry={() => setDocData(({ [currentDoc]: _, ...rest }) => rest)} />;
            return <Boundary label="The doc" resetKey={currentDoc}><DocPage key={currentDoc} embedded initial={d.doc} chat={d.chat} wsBase={d.wsBase} onTitle={(t) => (setDocTitles((x) => ({ ...x, [currentDoc]: t })), relabelSoon(currentDoc))} /></Boundary>;
          })()
        ) : current === "room" ? (
          <div className="room-box">
            <Boundary label="The room" resetKey={scope}>
            <RoomPanel key={`${scope}:${roomEpoch}`} taskId={taskId} intent={roomIntent} onOpenDoc={openDocTab} onOpenChanges={showChanges} onSeen={seeRoom} />
            </Boundary>
          </div>
        ) : current === "changes" ? (
          <Boundary label="The changes" resetKey={scope}>
            <DiffView taskId={taskId} active />
          </Boundary>
        ) : (
          error ? <Failed place="pane" message={error} /> : <Empty place="pane" title="Nothing open">Open a Claude Code session or a terminal with +, the agent room, or a file from the tree.</Empty>
        )}
      </div>} right={<Boundary label={side === "files" ? "Files" : side === "journal" ? "The journal" : "Activity"} resetKey={`${scope}:${side}`}><TaskSidePanel tab={side} taskId={taskId} openPath={currentFile} onOpen={(p) => (openFile(p), toBody())} /></Boundary>} />
    </section>
  );
}

/** "+": a Claude Code session on click; hover to choose a terminal or a document instead; right-click for archived sessions. */
function NewTab({ onClaude, onShell, onDoc, onRoom, onRestore }: { onClaude: () => void; onShell: () => void; onDoc: () => void; onRoom: () => void; onRestore: (e: React.MouseEvent) => void }) {
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
      <button type="button" className="term-tab-new" onClick={pick(onClaude)} onContextMenu={onRestore} aria-label="New tab" aria-haspopup="menu" aria-expanded={open} title="New Claude Code session (hover for a terminal or a document; right-click for archived sessions)">
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
          <button type="button" role="menuitem" onClick={pick(onDoc)} title="A jin doc for this task (a spec, plan or notes); its Claude Code can read it">
            <FileText size={13} /> Document
          </button>
          <button type="button" role="menuitem" onClick={pick(onRoom)} title="The task's agent room: a designer, an engineer and a reviewer (or your own), each taking a turn when you @-mention it">
            <Users size={13} /> Agent room
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
