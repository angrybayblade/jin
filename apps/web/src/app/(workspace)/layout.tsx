import type { ReactNode } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Sidebar } from "@/components/Sidebar";
import { ThermalMark } from "@/components/ThermalMark";
import { daemon, DaemonUnavailable, type Approval, type Session, type Status, type Task, type TerminalInfo } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** The persistent workspace shell: sidebar, then each page's chat and side pane. */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  let shell: { status: Status; tasks: Task[]; sessions: Session[]; approvals: Approval[]; terminals: TerminalInfo[] };
  try {
    const [status, tasks, sessions, approvals, terminals] = await Promise.all([
      daemon<Status>("/api/status"),
      daemon<Task[]>("/api/tasks"),
      daemon<Session[]>("/api/sessions"),
      daemon<Approval[]>("/api/approvals?state=pending"),
      daemon<TerminalInfo[]>("/api/terminals"),
    ]);
    shell = { status, tasks, sessions, approvals, terminals };
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
        pendingApprovals={shell.approvals.length}
        workspace={shell.status.workspaces.join(", ") || "no workspace"}
        mode={shell.status.mode}
      />
      <main className="work-area">{children}</main>
    </div>
  );
}
