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
import type { AgentStatus, Machine, MachineTasks, NotificationSettings, Session, Task } from "@/lib/daemon";
import { splitPath, taskHref } from "@/lib/paths";
import { contextMenu, type MenuItem } from "./ContextMenu";
import { NewTaskButton } from "./NewTaskDialog";
import { NotificationToggle } from "./Notifications";
import { SettingsMenu } from "./MachineSwitcher";
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
function MachineLabel({ label, local, note }: { label: string; local: boolean; note?: string }) {
  return (
    <div className="nav-machine" title={`Tasks on ${label}`}>
      <span className="nav-machine-icon">{local ? <Monitor size={12} /> : <Server size={12} />}</span>
      <span className="nav-machine-name">{label}</span>
      {note && <span className="nav-machine-empty">{note}</span>}
    </div>
  );
}

export function Sidebar({
  groups,
  here = "local",
  sessions,
  pendingApprovals,
  workspace,
  mode,
  notifications,
  machines = [],
}: {
  /** Every connected machine's tasks, this machine's first. */
  groups: MachineTasks[];
  /** The machine of the page being shown (where a new task goes by default). */
  here?: string;
  sessions: Session[];
  pendingApprovals: number;
  workspace: string;
  mode: string;
  notifications: NotificationSettings;
  machines?: Machine[];
}) {
  const path = usePathname();
  const router = useRouter();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const latest = (pred: (s: Session) => boolean) => sessions.find(pred);
  const jin = latest((s) => s.kind === "jin");
  // The task open now: its machine and id, from the URL.
  const at = splitPath(path);
  const openId = at.path.startsWith("/t/") ? decodeURIComponent(at.path.slice(3).split("/")[0]!) : null;
  const isOpen = (machine: string, id: string) => at.machine === machine && openId === id;
  const several = groups.length > 1;
  // Where a new task can go: machines with a workspace, the page's own first.
  const targets = groups.filter((g) => g.hasWorkspace && !g.down).map((g) => ({ id: g.id, label: g.label }));

  const taskMenu = (machine: string, t: Task): MenuItem[] => [
    { header: several ? `${t.id} · ${groups.find((g) => g.id === machine)?.label ?? machine}` : t.id },
    { label: "Open", icon: ArrowRight, run: () => router.push(taskHref(machine, t.id)) },
    {
      label: "New Claude Code session",
      icon: Plus,
      run: async () => {
        await openTerminal({ taskId: t.id, kind: "claude", machine });
        router.push(taskHref(machine, t.id));
      },
    },
    { divider: true },
    { label: "Rename", icon: Pencil, run: () => setRenaming(`task:${machine}:${t.id}`) },
    ...(t.branch ? [{ label: "Copy branch", icon: GitBranch, hint: t.branch, run: () => copy(t.branch!) }] : []),
    { label: "Copy path", icon: ClipboardCopy, run: () => copy(t.root) },
    ...(machine === "local" ? [{ label: "Reveal in Finder", icon: FolderOpen, run: () => revealTask(t.id, machine) }] : []),
    { divider: true },
    t.archived
      ? { label: "Unarchive", icon: ArchiveRestore, run: () => updateTask(t.id, { archived: false }, machine).then(() => router.refresh()) }
      : { label: "Archive", icon: Archive, hint: "hide from the list", run: () => updateTask(t.id, { archived: true }, machine).then(() => router.refresh()) },
    {
      label: "Remove task",
      icon: Trash2,
      danger: true,
      confirm: "Remove its checkouts (with the workspace's own tooling)?",
      run: async () => {
        const res = await removeTask(t.id, machine);
        if ("error" in res) setError(res.error);
        else if (isOpen(machine, t.id)) router.push("/");
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

  const taskRow = (g: MachineTasks, t: Task, depth = 0) => {
    const { terminals, prs } = g;
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
        key={`${g.id}:${t.id}`}
        href={taskHref(g.id, t.id)}
        prefetch={g.id === "local"}
        className={`nav-item task ${isOpen(g.id, t.id) ? "active" : ""} ${t.archived ? "is-archived" : ""} ${depth ? "is-subtask" : ""}`}
        style={depth ? { paddingLeft: 8 + depth * 14 } : undefined}
        title={`${t.parent ? `${title} · sub-task of ${t.parent}` : title}${several ? ` · on ${g.label}` : ""}`}
        {...contextMenu(() => taskMenu(g.id, t))}
      >
        {mark ? <StatusMark state={mark} /> : <span className="status-dot" aria-hidden="true" />}
        <span className="nav-label">
          <span className="mono">{t.id}</span>{" "}
          {renaming === `task:${g.id}:${t.id}` ? (
            <RenameInput
              value={title}
              label={`Rename ${t.id}`}
              onCancel={() => setRenaming(null)}
              onSave={(v) => {
                setRenaming(null);
                void updateTask(t.id, { title: v }, g.id).then(() => router.refresh());
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
          <NewTaskButton targets={targets} here={here} />
        </div>
        {error && (
          <p className="sidebar-error" role="alert" onClick={() => setError(null)} title="Dismiss">
            {error}
          </p>
        )}
        {groups.map((g) => {
          const ready = g.tasks.filter((t) => t.state === "ready");
          const live = ready.filter((t) => !t.archived);
          const archived = ready.filter((t) => t.archived);
          const pending = g.jobs.filter((j) => j.state !== "done" && !live.some((t) => t.id === j.taskId && j.state === "failed"));
          const empty = live.length === 0 && pending.length === 0;
          // A machine without a workspace or tasks needs no row, unless it is the only one.
          if (several && empty && !g.down && g.id !== "local" && !g.hasWorkspace) return null;
          return (
            <Fragment key={g.id}>
              {several && <MachineLabel label={g.label} local={g.id === "local"} note={g.down ? "not answering" : empty ? "no tasks" : undefined} />}
              {pending.map((j) => (
                <Link key={`${g.id}:job:${j.id}`} href={taskHref(g.id, j.taskId)} className={`nav-item task ${isOpen(g.id, j.taskId) ? "active" : ""}`} title={j.slug}>
                  <StatusMark state={j.state === "running" ? "running" : "failed"} />
                  <span className="nav-label">
                    <span className="mono">{j.taskId}</span> <span className="nav-sub">{j.state === "running" ? "setting up…" : "setup failed"}</span>
                  </span>
                </Link>
              ))}
              {!several && empty &&
                (!g.hasWorkspace && g.id === "local" && workspace === "no workspace" ? (
                  <p className="sidebar-empty">
                    No workspace yet. <Link href="/setup">Set up jin</Link>
                  </p>
                ) : (
                  <p className="sidebar-empty">Ask jin to start one, or press +.</p>
                ))}
              {nested(live.filter((t) => !g.jobs.some((j) => j.taskId === t.id && j.state === "running"))).map(({ task, depth }) => taskRow(g, task, depth))}
              {archived.length > 0 && (
                <>
                  <button
                    type="button"
                    className="nav-archived-toggle"
                    onClick={() =>
                      setShowArchived((v) => {
                        const n = new Set(v);
                        if (n.has(g.id)) n.delete(g.id);
                        else n.add(g.id);
                        return n;
                      })
                    }
                    aria-expanded={showArchived.has(g.id)}
                  >
                    {showArchived.has(g.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span className="nav-label">Archived ({archived.length})</span>
                  </button>
                  {showArchived.has(g.id) && archived.map((t) => taskRow(g, t))}
                </>
              )}
            </Fragment>
          );
        })}

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
        <SettingsMenu machines={machines} workspace={workspace} />
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
