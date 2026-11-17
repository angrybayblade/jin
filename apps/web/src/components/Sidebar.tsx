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
  Monitor,
  Server,
  ScanEye,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useState, type ComponentType } from "react";
import { openTerminal, removeTask, revealTask, updateTask } from "@/app/actions";
import type { AgentStatus, Elsewhere, Machine, NotificationSettings, Session, Task, TaskJob, TaskPR, TerminalInfo } from "@/lib/daemon";
import { contextMenu, type MenuItem } from "./ContextMenu";
import { NewTaskButton } from "./NewTaskDialog";
import { NotificationToggle } from "./Notifications";
import { MachineSwitcher } from "./MachineSwitcher";
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

/** A machine's name above its tasks, when the sidebar lists more than one machine's. */
function MachineLabel({ label, current = false, empty = false }: { label: string; current?: boolean; empty?: boolean }) {
  return (
    <div className={`nav-machine ${current ? "is-current" : ""}`} title={current ? `${label}: the machine jin is showing` : `Tasks on ${label}`}>
      <span className="nav-machine-icon">{label === "This machine" ? <Monitor size={12} /> : <Server size={12} />}</span>
      <span className="nav-machine-name">{label}</span>
      {empty && <span className="nav-machine-empty">no tasks</span>}
    </div>
  );
}

export function Sidebar({
  tasks,
  sessions,
  terminals,
  jobs,
  pendingApprovals,
  workspace,
  mode,
  notifications,
  prs = [],
  machines = [],
  machine = "local",
  elsewhere = [],
}: {
  tasks: Task[];
  sessions: Session[];
  terminals: TerminalInfo[];
  jobs: TaskJob[];
  pendingApprovals: number;
  workspace: string;
  mode: string;
  notifications: NotificationSettings;
  prs?: TaskPR[];
  machines?: Machine[];
  machine?: string;
  elsewhere?: Elsewhere[];
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

  /** Tasks in order, each sub-task right under its parent (jin-task spawn), one level in. */
  const nested = (list: Task[]): { task: Task; depth: number }[] => {
    const ids = new Set(list.map((t) => t.id));
    const out: { task: Task; depth: number }[] = [];
    const walk = (t: Task, depth: number) => {
      out.push({ task: t, depth });
      for (const c of list.filter((x) => x.parent === t.id)) walk(c, Math.min(depth + 1, 3));
    };
    for (const t of list) if (!t.parent || !ids.has(t.parent)) walk(t, 0);
    return out;
  };

  const taskRow = (t: Task, depth = 0) => {
    // Claude Code's status (from its hooks), else the latest SDK session's.
    const cli = terminals.filter((x) => x.taskId === t.id && x.kind === "claude").at(-1);
    const s = latest((x) => x.taskId === t.id);
    const mark = cli ? AGENT_MARK[cli.status] : s?.state;
    const title = t.title ?? t.slug;
    // Open PRs: a quiet mark, red when one needs you (failing checks, changes requested).
    const open = prs.filter((p) => p.taskId === t.id && p.state === "OPEN");
    const needsYou = open.filter((p) => p.checks === "failing" || p.review === "CHANGES_REQUESTED");
    return (
      <Link
        key={t.id}
        href={`/t/${encodeURIComponent(t.id)}`}
        className={`nav-item task ${path === `/t/${t.id}` ? "active" : ""} ${t.archived ? "is-archived" : ""} ${depth ? "is-subtask" : ""}`}
        style={depth ? { paddingLeft: 8 + depth * 14 } : undefined}
        title={t.parent ? `${title} · sub-task of ${t.parent}` : title}
        {...contextMenu(() => taskMenu(t))}
      >
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
        {t.kind === "review" ? (
          <span className="nav-pr" title={`Reviewing ${(t.prs ?? []).map((p) => `${p.repo}#${p.number}${p.title ? ` ${p.title}` : ""}`).join(", ")}`}>
            <ScanEye size={12} />
          </span>
        ) : open.length > 0 && (
          <span className={`nav-pr ${needsYou.length ? "is-attention" : ""}`} title={open.map((p) => `#${p.number} ${p.title ?? ""} — ${p.checks === "failing" ? "checks failing" : p.review === "CHANGES_REQUESTED" ? "changes requested" : p.draft ? "draft" : (p.review ?? "open").toLowerCase().replace("_", " ")}`).join("\n")}>
            <GitPullRequest size={12} />
          </span>
        )}
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
        <Link
          href="/"
          className={`jin-button hide-collapsed ${path === "/" ? "is-active" : ""}`}
          title={pendingApprovals > 0 ? `Jin · ${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"} waiting` : "Jin, your orchestrator"}
          aria-label="Jin"
          {...contextMenu(() => chatMenu("Jin", "/"))}
        >
          {jin && (jin.state === "running" || jin.state === "waiting_approval") ? <StatusMark state={jin.state} /> : <Layers size={14} />}
          {pendingApprovals > 0 && <span className="jin-count">{pendingApprovals}</span>}
        </Link>
      </div>
      <nav aria-label="Chats">
        {/* Collapsed sidebar: the top bar has only room for the window buttons, so Jin stays in the list. */}
        <Link href="/" className={`nav-item only-collapsed-row ${path === "/" ? "active" : ""}`} {...contextMenu(() => chatMenu("Jin", "/"))}>
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
        {elsewhere.length > 0 && (
          <MachineLabel label={machines.find((m) => m.id === machine)?.label ?? "This machine"} current empty={live.length === 0 && jobs.every((j) => j.state === "done")} />
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
        {live.length === 0 && jobs.every((j) => j.state === "done") &&
          (workspace === "no workspace" && machine === "local" ? (
            <p className="sidebar-empty">
              No workspace yet. <Link href="/setup">Set up jin</Link>
            </p>
          ) : elsewhere.length === 0 ? (
            <p className="sidebar-empty">Ask jin to start one, or press +.</p>
          ) : null)}
        {nested(live.filter((t) => !jobs.some((j) => j.taskId === t.id && j.state === "running"))).map(({ task, depth }) => taskRow(task, depth))}
        {archived.length > 0 && (
          <>
            <button type="button" className="nav-archived-toggle" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived}>
              {showArchived ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span className="nav-label">Archived ({archived.length})</span>
            </button>
            {showArchived && archived.map((t) => taskRow(t))}
          </>
        )}

        {elsewhere.map((e) => (
          <Fragment key={e.id}>
            <MachineLabel label={e.label} />
            {e.tasks.map((t) => {
              const cli = e.terminals.filter((x) => x.taskId === t.id && x.kind === "claude").at(-1);
              const open = e.prs.filter((p) => p.taskId === t.id && p.state === "OPEN");
              const href = `/m/${e.id}/t/${encodeURIComponent(t.id)}`;
              return (
                <Link key={`${e.id}:${t.id}`} href={href} prefetch={false} className="nav-item task is-elsewhere" title={`${t.title ?? t.slug} · on ${e.label}`} {...contextMenu(() => [{ header: `${t.id} · ${e.label}` }, { label: `Open on ${e.label}`, icon: ArrowRight, run: () => router.push(href) }])}>
                  {cli ? <StatusMark state={AGENT_MARK[cli.status]} /> : <span className="status-dot" aria-hidden="true" />}
                  <span className="nav-label">
                    <span className="mono">{t.id}</span> <span className="nav-sub">{t.title ?? t.slug}</span>
                  </span>
                  {open.length > 0 && (
                    <span className={`nav-pr ${open.some((p) => p.checks === "failing" || p.review === "CHANGES_REQUESTED") ? "is-attention" : ""}`}>
                      <GitPullRequest size={12} />
                    </span>
                  )}
                </Link>
              );
            })}
          </Fragment>
        ))}

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
        <MachineSwitcher machines={machines} current={machine} workspace={workspace} />
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
