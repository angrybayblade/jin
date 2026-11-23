"use client";
import { SidebarDocs } from "./docs/SidebarDocs";
import { fromSession, fromTerminal } from "@/lib/agent-state";
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  FlaskConical,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Layers,
  Pencil,
  Plus,
  Trash2,
  Monitor,
  Server,
  ScanEye,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, Suspense, useEffect, useState } from "react";
import { openTerminal, removeTask, revealTask, updateTask } from "@/lib/actions";
import type { DocSummary, Machine, MachineTasks, NotificationSettings, Session, Task } from "@/lib/daemon";
import { splitPath, taskHref } from "@/lib/paths";
import { setDrawer } from "@/lib/phone";
import { SidebarChats } from "./ChatTabs";
import { contextMenu, type MenuItem } from "./ContextMenu";
import { NewTaskButton } from "./NewTaskDialog";
import { NotificationToggle } from "./Notifications";
import { SettingsLinks, SettingsMenu } from "./MachineSwitcher";
import { RailTips } from "./RailTips";
import { RenameInput } from "./RenameInput";
import { DensityToggle, HistoryButtons, SidebarToggle } from "./ShellControls";
import { StatusMark } from "./ThermalMark";
import { ThemeToggle } from "./ThemeToggle";
import { ViewSwitch } from "./ViewSwitch";

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
  docs = [],
  problems = 0,
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
  /** jin docs, most recently changed first. */
  docs?: DocSummary[];
  /** Background failures on this machine (the settings button shows them). */
  problems?: number;
}) {
  const path = usePathname();
  const router = useRouter();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState<Set<string>>(new Set());
  // Tasks whose removal was just asked for (until the daemon reports them removing, or failed).
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const latest = (pred: (s: Session) => boolean) => sessions.find(pred);
  // The task open now: its machine and id, from the URL.
  const at = splitPath(path);
  const openId = at.path.startsWith("/t/") ? decodeURIComponent(at.path.slice(3).split("/")[0]!) : null;
  const isOpen = (machine: string, id: string) => at.machine === machine && openId === id;
  const several = groups.length > 1;
  // Where a new task can go: machines with a workspace, the page's own first.
  const targets = groups.filter((g) => g.hasWorkspace && !g.down).map((g) => ({ id: g.id, label: g.label }));
  // The phone drawer closes on navigation (and on a tap on a link to the page already open).
  useEffect(() => setDrawer(false), [path]);

  const taskMenu = (machine: string, t: Task): MenuItem[] => [
    { label: "Open", icon: ArrowRight, run: () => router.push(taskHref(machine, t.id)) },
    ...(["agent", "shell"] as const).map((kind) => ({
      label: kind === "agent" ? "Agent session" : "Terminal",
      icon: Plus,
      run: async () => {
        await openTerminal({ taskId: t.id, kind, machine });
        router.push(taskHref(machine, t.id));
      },
    })),
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
      label: t.kind === "scratch" ? "Discard scratch" : "Remove task",
      icon: Trash2,
      danger: true,
      confirm: t.kind === "scratch" ? "Throw this experiment away? Its checkouts, uncommitted changes and scratch branch are deleted." : "Remove its checkouts (with the workspace's own tooling)?",
      run: async () => {
        const key = `${machine}:${t.id}`;
        setRemoving((s) => new Set(s).add(key));
        if (isOpen(machine, t.id)) router.push("/");
        const res = await removeTask(t.id, machine, t.kind === "scratch");
        if ("error" in res) setError(res.error);
        // The daemon now reports it as removing (or, later, why it could not).
        setRemoving((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
        router.refresh();
      },
    },
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
    // Being removed: shown, but not openable, until it is gone.
    if (t.removing || removing.has(`${g.id}:${t.id}`)) {
      return (
        <div key={`${g.id}:${t.id}`} className="nav-item task is-removing" style={depth ? { paddingLeft: 8 + depth * 14 } : undefined} aria-disabled="true" title={`Removing ${t.id}…`}>
          <StatusMark state="working" />
          <span className="nav-label">
            <span className="mono">{t.id}</span> <span className="nav-sub">removing…</span>
          </span>
        </div>
      );
    }
    // Claude Code's status (from its hooks), else the latest SDK session's.
    const cli = terminals.filter((x) => x.taskId === t.id && x.kind === "agent").at(-1);
    const s = latest((x) => x.taskId === t.id);
    const mark = cli ? fromTerminal(cli.status) : s ? fromSession(s.state) : null;
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
        {mark && mark !== "idle" ? <StatusMark state={mark} /> : <span className="status-dot" aria-hidden="true" />}
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
          ) : t.removeError ? (
            <span className="nav-sub is-error" title={`Could not remove: ${t.removeError}`}>
              removal failed
            </span>
          ) : (
            <span className="nav-sub">{title}</span>
          )}
        </span>
        {t.kind === "scratch" ? (
          <span className="nav-pr" title="Scratch: an experiment, tied to no issue (Discard scratch throws it away)">
            <FlaskConical size={12} />
          </span>
        ) : t.kind === "review" ? (
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
        <span className="hide-collapsed">
          <ViewSwitch />
        </span>
        <span className="only-collapsed">
          <SidebarToggle shortcut={false} />
        </span>
      </div>
      {/* On a phone, the drawer over the page (opened from the top bar); on desktop it is not a box (display: contents). */}
      <div className="sidebar-drawer" onClick={(e) => (e.target as Element).closest("a") && setDrawer(false)}>
      <nav aria-label="Chats">
        <Suspense fallback={null}>
          <SidebarChats kind="jin" chats={sessions.filter((x) => x.kind === "jin")} base="/" pending={pendingApprovals} />
        </Suspense>

        <SidebarDocs docs={docs} />

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
                  <StatusMark state={j.state === "running" ? "working" : "failed"} />
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

        {/* Phone drawer only: the desk (the top bar's stack button on desktop) and the settings menu's pages. */}
        <div className="phone-only">
          <div className="nav-section">
            <span>Views</span>
          </div>
          <Link href="/desk" className={`nav-item ${path.startsWith("/desk") ? "active" : ""}`}>
            <Layers size={14} className="nav-icon" />
            <span className="nav-label">Desk</span>
          </Link>
          <SettingsLinks machines={machines} />
        </div>
      </nav>

      <div className="sidebar-bottom">
        <SettingsMenu machines={machines} workspace={workspace} problems={problems} />
        <span className="sidebar-controls">
          {mode !== "vm" && <NotificationToggle initial={notifications} />}
          <DensityToggle />
          <ThemeToggle />
        </span>
      </div>
      </div>
      <div className="drawer-backdrop" aria-hidden="true" onClick={() => setDrawer(false)} />
      <RailTips />
    </aside>
  );
}
