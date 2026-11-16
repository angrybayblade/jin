import { notFound } from "next/navigation";
import { TaskView } from "@/components/workspace/TaskView";
import { TaskSetup } from "@/components/TaskSetup";
import { daemon, daemonWsBase, type Task, type TaskJob, type TaskPR, type TerminalInfo } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** A task: Claude Code sessions, terminals, files and the diff as one row of tabs; the file tree on the right. */
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
  const [terminals, prs] = await Promise.all([
    daemon<TerminalInfo[]>(`/api/terminals?task=${encodeURIComponent(taskId)}`),
    daemon<TaskPR[]>(`/api/tasks/${encodeURIComponent(taskId)}/prs`).catch(() => [] as TaskPR[]),
  ]);
  return <TaskView key={task.id} taskId={task.id} subtitle={`${task.title ?? task.slug} · ${task.repos.join(", ")}`} terminals={terminals} prs={prs} wsBase={await daemonWsBase()} />;
}
