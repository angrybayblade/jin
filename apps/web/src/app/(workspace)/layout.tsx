import { Suspense, type ReactNode } from "react";
import { PresenceReporter } from "@/components/Notifications";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ContextMenuHost } from "@/components/ContextMenu";
import { Palette } from "@/components/Palette";
import { SidebarResizer } from "@/components/ShellControls";
import { Sidebar } from "@/components/Sidebar";
import { ThermalMark } from "@/components/ThermalMark";
import { daemon, DaemonUnavailable, type Approval, type NotificationSettings, type Session, type Status, type Task, type TaskJob, type TerminalInfo } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** The persistent workspace shell: sidebar, then each page's chat and side pane. */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  let shell: { status: Status; tasks: Task[]; sessions: Session[]; approvals: Approval[]; terminals: TerminalInfo[]; jobs: TaskJob[]; notifications: NotificationSettings };
  try {
    const [status, tasks, sessions, approvals, terminals, jobs, notifications] = await Promise.all([
      daemon<Status>("/api/status"),
      daemon<Task[]>("/api/tasks"),
      daemon<Session[]>("/api/sessions"),
      daemon<Approval[]>("/api/approvals?state=pending"),
      daemon<TerminalInfo[]>("/api/terminals"),
      daemon<TaskJob[]>("/api/task-jobs"),
      daemon<NotificationSettings>("/api/notifications").catch(() => ({ enabled: true, sound: true })),
    ]);
    shell = { status, tasks, sessions, approvals, terminals, jobs, notifications };
  } catch (err) {
    if (!(err instanceof DaemonUnavailable)) throw err;
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
