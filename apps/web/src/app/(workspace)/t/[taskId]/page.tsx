import { redirect } from "next/navigation";
import { TaskView } from "@/components/workspace/TaskView";
import { TaskSetup } from "@/components/TaskSetup";
import { MachineDown } from "@/components/MachineSwitcher";
import { currentMachine, daemon, DaemonUnavailable, daemonWsBase, knownMachines, type Machine, type Task, type TaskJob, type TaskPR, type TerminalInfo } from "@/lib/daemon";
import { taskHref } from "@/lib/paths";

export const dynamic = "force-dynamic";

/** A task: Claude Code sessions, terminals, files and the diff as one row of tabs; the file tree on the right. */
export default async function TaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const machine = await currentMachine();
  // The machine in the URL is not answering: say so, and retry until it does.
  let jobs: TaskJob[];
  try {
    jobs = await daemon<TaskJob[]>("/api/task-jobs");
  } catch (err) {
    if (!(err instanceof DaemonUnavailable) || machine === "local") throw err;
    const label = (await daemon<Machine[]>("/api/machines", { local: true }).catch(() => [] as Machine[])).find((m) => m.id === machine)?.label ?? machine;
    return <MachineDown id={machine} name={label} message={err.message} />;
  }
  // Being set up (or its setup failed): show the setup's progress until the task is ready.
  const job = jobs.find((j) => j.taskId === taskId);
  if (job && job.state !== "done") return <TaskSetup key={job.id} initial={job} />;
  let task: Task | null = null;
  try {
    task = await daemon<Task>(`/api/tasks/${encodeURIComponent(taskId)}`);
  } catch {
    // Not on the machine in the URL (an old link, or one that named no machine): open it on the machine that has it.
    const elsewhere = await findTask(taskId);
    if (elsewhere) redirect(taskHref(elsewhere, taskId));
  }
  if (!task) {
    return (
      <section className="side-panel">
        <p className="meta pad">No machine jin knows has a task {taskId}.</p>
      </section>
    );
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

/** The other machine that has this task (ready), if any. */
async function findTask(taskId: string): Promise<string | null> {
  const here = await currentMachine();
  const hits = await Promise.all(
    knownMachines()
      .filter((m) => m !== here)
      .map((m) =>
        daemon<Task>(`/api/tasks/${encodeURIComponent(taskId)}`, { machine: m, timeoutMs: 4_000 })
          .then((t) => (t.state === "ready" ? m : null))
          .catch(() => null),
      ),
  );
  return hits.find(Boolean) ?? null;
}
