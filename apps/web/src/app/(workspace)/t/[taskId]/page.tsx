import { notFound } from "next/navigation";
import { ClaudePane } from "@/components/workspace/ClaudePane";
import { WorkspacePane } from "@/components/workspace/WorkspacePane";
import { daemon, daemonWsBase, type Task, type TerminalInfo } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** A task: Claude Code sessions in the worktree, and the workspace (editor, shells, diff), all as tabs. */
export default async function TaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  let task: Task;
  try {
    task = await daemon<Task>(`/api/tasks/${encodeURIComponent(taskId)}`);
  } catch {
    notFound();
  }
  if (task.state !== "ready") {
    return (
      <section className="side-panel">
        <p className="meta pad">Task {task.id} was removed.</p>
      </section>
    );
  }
  const terminals = await daemon<TerminalInfo[]>(`/api/terminals?task=${encodeURIComponent(taskId)}`);
  const ws = daemonWsBase();
  return (
    <div className="panes with-workspace">
      <ClaudePane taskId={task.id} title={task.id} subtitle={`${task.slug} · ${task.repos.join(", ")}`} terminals={terminals.filter((t) => t.kind === "claude")} wsBase={ws} />
      <WorkspacePane taskId={task.id} wsBase={ws} shells={terminals.filter((t) => t.kind === "shell")} />
    </div>
  );
}
