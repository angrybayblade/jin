import { Suspense, type ReactNode } from "react";
import { PresenceReporter } from "@/components/Notifications";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ContextMenuHost } from "@/components/ContextMenu";
import { Palette } from "@/components/Palette";
import { SidebarResizer } from "@/components/ShellControls";
import { Sidebar } from "@/components/Sidebar";
import { ThermalMark } from "@/components/ThermalMark";
import { MachineDown } from "@/components/MachineSwitcher";
import { currentMachine, daemon, DaemonUnavailable, type Elsewhere, type Machine, type Approval, type NotificationSettings, type TaskPR, type Session, type Status, type Task, type TaskJob, type TerminalInfo } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** The persistent workspace shell: sidebar, then each page's chat and side pane. */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const machine = await currentMachine();
  const machines = await daemon<Machine[]>("/api/machines", { local: true }).catch(() => [] as Machine[]);
  // Every other machine's tasks, for the sidebar: this one's when a remote is showing, and each connected remote's.
  const others = [{ id: "local", label: "This machine" }, ...machines.filter((m) => m.connected).map((m) => ({ id: m.id, label: m.label }))].filter((m) => m.id !== machine);
  const elsewhereP = (async () =>
    (await Promise.all(
      others.map(async (m): Promise<Elsewhere | null> => {
        const o = { machine: m.id, timeoutMs: 1500 };
        try {
          const [tasks, terminals, prs] = await Promise.all([daemon<Task[]>("/api/tasks", o), daemon<TerminalInfo[]>("/api/terminals", o), daemon<TaskPR[]>("/api/prs", o).catch(() => [] as TaskPR[])]);
          return { ...m, tasks: tasks.filter((t) => t.state === "ready" && !t.archived), terminals, prs };
        } catch {
          return null; // offline or slow: left out until it answers
        }
      }),
    )).filter((e): e is Elsewhere => e !== null && e.tasks.length > 0))();
  let elsewhere: Elsewhere[] = [];
  let shell: { status: Status; tasks: Task[]; sessions: Session[]; approvals: Approval[]; terminals: TerminalInfo[]; jobs: TaskJob[]; notifications: NotificationSettings; prs: TaskPR[] };
  try {
    const [status, tasks, sessions, approvals, terminals, jobs, notifications, prs] = await Promise.all([
      daemon<Status>("/api/status"),
      daemon<Task[]>("/api/tasks"),
      daemon<Session[]>("/api/sessions"),
      daemon<Approval[]>("/api/approvals?state=pending"),
      daemon<TerminalInfo[]>("/api/terminals"),
      daemon<TaskJob[]>("/api/task-jobs"),
      daemon<NotificationSettings>("/api/notifications").catch(() => ({ enabled: true, sound: true })),
      daemon<TaskPR[]>("/api/prs").catch(() => [] as TaskPR[]),
    ]);
    shell = { status, tasks, sessions, approvals, terminals, jobs, notifications, prs };
    elsewhere = await elsewhereP;
  } catch (err) {
    if (!(err instanceof DaemonUnavailable)) throw err;
    if (machine !== "local") return <MachineDown name={machines.find((m) => m.id === machine)?.label ?? machine} message={err.message} />;
    return (
      <main className="daemon-down">
        <ThermalMark size={40} state="queued" variant="workflow" />
        <p>{err.message}</p>
      </main>
    );
  }
  return (
    <div className="app-shell">
      <AutoRefresh every={3000} />
      <Sidebar
        tasks={shell.tasks}
        sessions={shell.sessions}
        terminals={shell.terminals}
        jobs={shell.jobs}
        pendingApprovals={shell.approvals.length}
        workspace={shell.status.workspaces.join(", ") || "no workspace"}
        mode={shell.status.mode}
        notifications={shell.notifications}
        prs={shell.prs}
        machines={machines}
        machine={machine}
        elsewhere={elsewhere}
      />
      <SidebarResizer />
      <Palette tasks={shell.tasks} />
      <ContextMenuHost />
      <Suspense fallback={null}>
        <PresenceReporter />
      </Suspense>
      <main className="work-area">{children}</main>
    </div>
  );
}
