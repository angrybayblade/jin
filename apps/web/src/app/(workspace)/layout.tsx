import { Suspense, type ReactNode } from "react";
import { PresenceReporter } from "@/components/Notifications";
import { AutoRefresh, RetrySoon } from "@/components/AutoRefresh";
import { ContextMenuHost } from "@/components/ContextMenu";
import { Notices } from "@/components/Notices";
import { Palette } from "@/components/Palette";
import { SidebarResizer } from "@/components/ShellControls";
import { Sidebar } from "@/components/Sidebar";
import { ThermalMark } from "@/components/ThermalMark";
import { currentMachine, daemon, DaemonUnavailable, homeMachine, type MachineTasks, type Machine, type Approval, type DocSummary, type NotificationSettings, type TaskPR, type Session, type Status, type Task, type TaskJob, type TerminalInfo } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** The persistent workspace shell: sidebar, then each page's chat and side pane. */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  // The machine of the page being shown (from its URL): only for where a new task goes by default.
  const here = await currentMachine();
  const machines = await daemon<Machine[]>("/api/machines", { local: true }).catch(() => [] as Machine[]);
  // Every machine's tasks, listed the same way: this one, then each connected one. There is no
  // machine to switch to; a task opens on the machine it is on.
  const remote = machines.filter((m) => m.connected).map((m) => ({ id: m.id, label: m.label }));
  const tasksOf = async (m: { id: string; label: string }, required: boolean): Promise<MachineTasks> => {
    const o = { machine: m.id, ...(required ? {} : { timeoutMs: 2500 }) };
    try {
      const [tasks, terminals, jobs, prs, status] = await Promise.all([
        daemon<Task[]>("/api/tasks", o),
        daemon<TerminalInfo[]>("/api/terminals", o),
        daemon<TaskJob[]>("/api/task-jobs", o).catch(() => [] as TaskJob[]),
        daemon<TaskPR[]>("/api/prs", o).catch(() => [] as TaskPR[]),
        daemon<Status>("/api/status", o).catch(() => null),
      ]);
      return { ...m, tasks, terminals, jobs, prs, hasWorkspace: (status?.workspaces.length ?? 0) > 0 };
    } catch (err) {
      if (required) throw err;
      return { ...m, tasks: [], terminals: [], jobs: [], prs: [], hasWorkspace: false, down: true };
    }
  };
  // Chats and approvals live on the home (hub). When it is not answering (a restart, sleep, a
  // network change) the tasks still show; only those wait for it.
  const home = homeMachine();
  let homeDown: string | null = null;
  const fromHome = <T,>(p: Promise<T>, empty: T): Promise<T> =>
    home === "local"
      ? p
      : p.catch((err) => {
          if (!(err instanceof DaemonUnavailable)) throw err;
          homeDown = machines.find((m) => m.id === home)?.label ?? home;
          return empty;
        });
  let shell: { status: Status; sessions: Session[]; approvals: Approval[]; notifications: NotificationSettings; groups: MachineTasks[]; docs: DocSummary[]; problems: number };
  try {
    const [status, sessions, approvals, notifications, groups, docs, problems] = await Promise.all([
      daemon<Status>("/api/status", { local: true }),
      fromHome(daemon<Session[]>("/api/sessions"), [] as Session[]),
      fromHome(daemon<Approval[]>("/api/approvals?state=pending"), [] as Approval[]),
      daemon<NotificationSettings>("/api/notifications").catch(() => ({ enabled: true, sound: true })),
      Promise.all([tasksOf({ id: "local", label: "This machine" }, true), ...remote.map((m) => tasksOf(m, false))]),
      fromHome(daemon<DocSummary[]>("/api/docs"), [] as DocSummary[]).catch(() => [] as DocSummary[]),
      daemon<unknown[]>("/api/problems", { local: true }).then((l) => l.length).catch(() => 0),
    ]);
    shell = { status, sessions, approvals, notifications, groups, docs, problems };
  } catch (err) {
    if (!(err instanceof DaemonUnavailable)) throw err;
    return (
      <main className="daemon-down">
        <ThermalMark size={40} state="queued" variant="workflow" />
        <p>{err.message}</p>
        <RetrySoon />
      </main>
    );
  }
  return (
    <div className="app-shell">
      <AutoRefresh />
      {homeDown && (
        <div className="home-down" role="status">
          jin&apos;s home ({homeDown}) is not answering; your chats and approvals come back when it does.
        </div>
      )}
      <Sidebar
        groups={shell.groups}
        here={here}
        sessions={shell.sessions}
        pendingApprovals={shell.approvals.length}
        workspace={shell.status.workspaces.join(", ") || "no workspace"}
        mode={shell.status.mode}
        notifications={shell.notifications}
        machines={machines}
        docs={shell.docs}
        problems={shell.problems}
      />
      <SidebarResizer />
      <Palette tasks={shell.groups.flatMap((g) => g.tasks.map((t) => ({ ...t, machine: g.id, machineLabel: g.label })))} />
      <ContextMenuHost />
      <Notices />
      <Suspense fallback={null}>
        <PresenceReporter />
      </Suspense>
      <main className="work-area">{children}</main>
    </div>
  );
}
