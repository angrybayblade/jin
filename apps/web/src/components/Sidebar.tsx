"use client";
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Layers,
  Mail,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Plus,
  SquareKanban,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ComponentType } from "react";
import { openTerminal, removeTask, revealTask, updateTask } from "@/app/actions";
import type { AgentStatus, NotificationSettings, Session, Task, TaskJob, TerminalInfo } from "@/lib/daemon";
import { contextMenu, type MenuItem } from "./ContextMenu";
import { NewTaskButton } from "./NewTaskDialog";
import { NotificationToggle } from "./Notifications";
import { RenameInput } from "./RenameInput";
import { DensityToggle, HistoryButtons, SidebarToggle } from "./ShellControls";
import { StatusMark } from "./ThermalMark";
import { ThemeToggle } from "./ThemeToggle";

export const DESKS: { kind: "slack" | "linear" | "notion" | "gmail" | "github"; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { kind: "github", label: "GitHub", icon: GitPullRequest },
  { kind: "slack", label: "Slack", icon: MessageSquare },
  { kind: "linear", label: "Linear", icon: SquareKanban },
  { kind: "notion", label: "Notion", icon: BookOpen },
  { kind: "gmail", label: "Gmail", icon: Mail },
];

const AGENT_MARK: Record<AgentStatus, "running" | "waiting_approval" | "idle" | "interrupted"> = {
  starting: "running",
  working: "running",
  waiting: "waiting_approval",
  idle: "idle",
  exited: "interrupted",
  interrupted: "interrupted",
};

const copy = (text: string) => void navigator.clipboard?.writeText(text);

export function Sidebar({
  tasks,
  sessions,
  terminals,
  jobs,
  pendingApprovals,
  workspace,
  mode,
  notifications,
}: {
  tasks: Task[];
  sessions: Session[];
  terminals: TerminalInfo[];
  jobs: TaskJob[];
  pendingApprovals: number;
  workspace: string;
  mode: string;
  notifications: NotificationSettings;
}) {
  const path = usePathname();
  const router = useRouter();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = (pred: (s: Session) => boolean) => sessions.find(pred);
  const jin = latest((s) => s.kind === "jin");
  const ready = tasks.filter((t) => t.state === "ready");
  const live = ready.filter((t) => !t.archived);
  const archived = ready.filter((t) => t.archived);

  const taskMenu = (t: Task): MenuItem[] => [
    { header: t.id },
    { label: "Open", icon: ArrowRight, run: () => router.push(`/t/${encodeURIComponent(t.id)}`) },
    {
      label: "New Claude Code session",
      icon: Plus,
      run: async () => {
        await openTerminal({ taskId: t.id, kind: "claude" });
        router.push(`/t/${encodeURIComponent(t.id)}`);
      },
    },
    { divider: true },
    { label: "Rename", icon: Pencil, run: () => setRenaming(`task:${t.id}`) },
    ...(t.branch ? [{ label: "Copy branch", icon: GitBranch, hint: t.branch, run: () => copy(t.branch!) }] : []),
    { label: "Copy path", icon: ClipboardCopy, run: () => copy(t.root) },
    { label: "Reveal in Finder", icon: FolderOpen, run: () => revealTask(t.id) },
    { divider: true },
    t.archived
      ? { label: "Unarchive", icon: ArchiveRestore, run: () => updateTask(t.id, { archived: false }).then(() => router.refresh()) }
      : { label: "Archive", icon: Archive, hint: "hide from the list", run: () => updateTask(t.id, { archived: true }).then(() => router.refresh()) },
    {
      label: "Remove task",
      icon: Trash2,
      danger: true,
      confirm: "Remove worktrees (cws task rm)?",
      run: async () => {
        const res = await removeTask(t.id);
        if ("error" in res) setError(res.error);
        else if (path === `/t/${t.id}`) router.push("/");
        router.refresh();
      },
    },
  ];

  /** Jin's chat and each desk: start a chat (each chat's own menu is on its tab). */
  const chatMenu = (label: string, href: string): MenuItem[] => [
    { header: label },
    { label: "Open", icon: ArrowRight, run: () => router.push(href) },
    { label: "New chat", icon: MessageSquarePlus, run: () => router.push(`${href}?chat=new`) },
  ];

  const taskRow = (t: Task) => {
    // Claude Code's status (from its hooks), else the latest SDK session's.
    const cli = terminals.filter((x) => x.taskId === t.id && x.kind === "claude").at(-1);
    const s = latest((x) => x.taskId === t.id);
    const mark = cli ? AGENT_MARK[cli.status] : s?.state;
    const title = t.title ?? t.slug;
    return (
      <Link key={t.id} href={`/t/${encodeURIComponent(t.id)}`} className={`nav-item task ${path === `/t/${t.id}` ? "active" : ""} ${t.archived ? "is-archived" : ""}`} title={title} {...contextMenu(() => taskMenu(t))}>
        {mark ? <StatusMark state={mark} /> : <span className="status-dot" aria-hidden="true" />}
        <span className="nav-label">
          <span className="mono">{t.id}</span>{" "}
          {renaming === `task:${t.id}` ? (
            <RenameInput
              value={title}
              label={`Rename ${t.id}`}
              onCancel={() => setRenaming(null)}
              onSave={(v) => {
                setRenaming(null);
                void updateTask(t.id, { title: v }).then(() => router.refresh());
              }}
            />
          ) : (
            <span className="nav-sub">{title}</span>
          )}
        </span>
      </Link>
    );
  };

  return (
    <aside className="sidebar">
      {/* Level with the panes' top bars; in the desktop window it is the title bar, with room for the window buttons. */}
      <div className="sidebar-top">
        <span className="traffic-gap" aria-hidden="true" />
        <span className="hide-collapsed">
          <SidebarToggle />
        </span>
        <span className="hide-collapsed">
          <HistoryButtons />
        </span>
      </div>
      <nav aria-label="Chats">
        <Link href="/" className={`nav-item ${path === "/" ? "active" : ""}`} {...contextMenu(() => chatMenu("Jin", "/"))}>
          <Layers size={15} />
          <span className="nav-label">Jin</span>
          {jin && (jin.state === "running" || jin.state === "waiting_approval") && <StatusMark state={jin.state} />}
          {pendingApprovals > 0 && <span className="nav-count" title="Approvals waiting">{pendingApprovals}</span>}
        </Link>

        <div className="nav-section">
          <span>Tasks</span>
          <NewTaskButton />
        </div>
        {error && (
          <p className="sidebar-error" role="alert" onClick={() => setError(null)} title="Dismiss">
            {error}
          </p>
        )}
        {jobs
          .filter((j) => j.state !== "done" && !live.some((t) => t.id === j.taskId && j.state === "failed"))
          .map((j) => (
            <Link key={j.id} href={`/t/${encodeURIComponent(j.taskId)}`} className={`nav-item task ${path === `/t/${j.taskId}` ? "active" : ""}`} title={j.slug}>
              <StatusMark state={j.state === "running" ? "running" : "failed"} />
              <span className="nav-label">
                <span className="mono">{j.taskId}</span> <span className="nav-sub">{j.state === "running" ? "setting up…" : "setup failed"}</span>
              </span>
            </Link>
          ))}
        {live.length === 0 && jobs.every((j) => j.state === "done") && <p className="sidebar-empty">Ask jin to start one, or press +.</p>}
        {live.filter((t) => !jobs.some((j) => j.taskId === t.id && j.state === "running")).map(taskRow)}
        {archived.length > 0 && (
          <>
            <button type="button" className="nav-archived-toggle" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived}>
              {showArchived ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span className="nav-label">Archived ({archived.length})</span>
            </button>
            {showArchived && archived.map(taskRow)}
          </>
        )}

        <div className="nav-section">Desks</div>
        {DESKS.map(({ kind, label, icon: Icon }) => {
          const s = latest((x) => x.kind === kind);
          return (
            <Link key={kind} href={`/c/${kind}`} className={`nav-item ${path === `/c/${kind}` ? "active" : ""}`} {...contextMenu(() => chatMenu(label, `/c/${kind}`))}>
              <Icon size={15} />
              <span className="nav-label">{label}</span>
              {s && (s.state === "running" || s.state === "waiting_approval") && <StatusMark state={s.state} />}
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        <span className="meta sidebar-where">
          {workspace} · {mode === "vm" ? "always on" : "local"}
        </span>
        <span className="sidebar-controls">
          {mode !== "vm" && <NotificationToggle initial={notifications} />}
          <DensityToggle />
          <ThemeToggle />
          <span className="only-collapsed">
            <SidebarToggle shortcut={false} />
          </span>
        </span>
      </div>
    </aside>
  );
}
