import { notFound } from "next/navigation";
import { Chat } from "@/components/Chat";
import { WorkspacePane } from "@/components/workspace/WorkspacePane";
import { daemon, daemonWsBase, type Approval, type Session, type SessionEvent, type Task } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** A task: its coding agent's chat, and the workspace (editor, terminal, diff). */
export default async function TaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  let task: Task;
  try {
    task = await daemon<Task>(`/api/tasks/${encodeURIComponent(taskId)}`);
  } catch {
    notFound();
  }
  const [sessions, approvals] = await Promise.all([
    daemon<Session[]>(`/api/tasks/${encodeURIComponent(taskId)}/sessions`),
    daemon<Approval[]>("/api/approvals?state=pending"),
  ]);
  const session = sessions[0] ?? null;
  const events = session ? await daemon<SessionEvent[]>(`/api/sessions/${session.id}/events`) : [];
  const ws = daemonWsBase();
  return (
    <div className="panes with-workspace">
      <Chat
        key={session?.id ?? `new-${taskId}`}
        kind="task"
        taskId={taskId}
        session={session}
        initialEvents={events}
        approvals={approvals.filter((a) => sessions.some((s) => s.id === a.sessionId))}
        wsBase={ws}
        title={task.id}
        subtitle={`${task.slug} · ${task.repos.join(", ")}`}
        welcome={{
          overline: task.id,
          heading: task.slug,
          body: `A coding agent works in ${task.root}. Its commands are checked by jin; pushes and PRs wait for you.`,
          suggestions: ["Read the code involved and propose a plan", "Run the tests and tell me what fails", "Summarise the changes so far"],
        }}
        placeholder="Tell the agent what to do…"
      />
      {task.state === "ready" ? <WorkspacePane taskId={task.id} wsBase={ws} /> : <section className="side-panel"><p className="meta pad">This task was removed.</p></section>}
    </div>
  );
}
