import { notFound } from "next/navigation";
import { ClaudePane } from "@/components/workspace/ClaudePane";
import { WorkspacePane } from "@/components/workspace/WorkspacePane";
import { Panes } from "@/components/Panes";
import { TaskSetup } from "@/components/TaskSetup";
import { daemon, daemonWsBase, type Task, type TaskJob, type TerminalInfo } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** A task: Claude Code sessions in the worktree, and the workspace (editor, shells, diff), all as tabs. */
export default async function TaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  // Being set up (or its setup failed): show the setup's progress until the task is ready.
  const job = (await daemon<TaskJob[]>("/api/task-jobs")).find((j) => j.taskId === taskId);
  if (job && job.state !== "done") return <TaskSetup key={job.id} initial={job} />;
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
    <Panes id="task" defaultSplit={56} minLeft={420} minRight={320} left={
      <ClaudePane taskId={task.id} title={task.id} subtitle={`${task.title ?? task.slug} · ${task.repos.join(", ")}`} terminals={terminals.filter((t) => t.kind === "claude")} wsBase={ws} />
      }
      right={<WorkspacePane taskId={task.id} wsBase={ws} shells={terminals.filter((t) => t.kind === "shell")} />}
    />
  );
}
