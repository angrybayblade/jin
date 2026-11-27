import { Missing } from "@/components/Missing";
import { redirect } from "next/navigation";
import { TaskView } from "@/components/workspace/TaskView";
import { TaskSetup } from "@/components/TaskSetup";
import { MachineDown } from "@/components/MachineSwitcher";
import { currentMachine, daemon, DaemonUnavailable, daemonWsBase, knownMachines, view, type Machine, type Task, type TaskJob, type TaskPR, type TerminalInfo } from "@/lib/daemon";
import { taskHref } from "@/lib/paths";

export const dynamic = "force-dynamic";

/** A task: Claude Code sessions, terminals, files and the diff as one row of tabs; the file tree on the right. */
export default async function TaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const machine = await currentMachine();
  const id = encodeURIComponent(taskId);
  // Its setup, the task, its terminals and PRs in one call to its machine.
  let v: TaskViewData;
  try {
    v = await view<TaskViewData>(`/api/views/task/${id}`, async () => {
      const job = (await daemon<TaskJob[]>("/api/task-jobs")).find((j) => j.taskId === taskId) ?? null;
      if (job && job.state !== "done") return { job, task: null };
      const task = await daemon<Task>(`/api/tasks/${id}`).catch(() => null);
      if (!task || task.state !== "ready") return { job: null, task };
      const [terminals, prs] = await Promise.all([daemon<TerminalInfo[]>(`/api/terminals?task=${id}`), daemon<TaskPR[]>(`/api/tasks/${id}/prs`).catch(() => [] as TaskPR[])]);
      return { job: null, task, terminals, prs };
    });
  } catch (err) {
    // The machine in the URL is not answering: say so, and retry until it does.
    if (!(err instanceof DaemonUnavailable) || machine === "local") throw err;
    const label = (await daemon<Machine[]>("/api/machines", { local: true }).catch(() => [] as Machine[])).find((m) => m.id === machine)?.label ?? machine;
    return <MachineDown id={machine} name={label} message={err.message} />;
  }
  // Being set up (or its setup failed): show the setup's progress until the task is ready.
  if (v.job) return <TaskSetup key={v.job.id} initial={v.job} />;
  const { task } = v;
  if (!task) {
    // Not on the machine in the URL (an old link, or one that named no machine): open it on the machine that has it.
    const elsewhere = await findTask(taskId);
    if (elsewhere) redirect(taskHref(elsewhere, taskId));
    return <Missing title={`No task ${taskId}`} body="No machine jin knows has it: it may have been removed, or be on a machine that is not connected." />;
  }
  if (task.state !== "ready") return <Missing title={`${task.id} was removed`} body="Its checkouts are gone. Its chats and docs stay in jin." />;
  const terminals = v.terminals ?? [];
  const prs = v.prs ?? [];
  // Keyed by machine too: the same task id on two machines is two tasks (nothing carries over between them).
  return <TaskView key={`${machine}:${task.id}`} machine={machine} taskId={task.id} subtitle={`${task.title ?? task.slug} · ${task.repos.join(", ")}`} terminals={terminals} prs={prs} wsBase={await daemonWsBase()} />;
}

type TaskViewData = { job: TaskJob | null; task: Task | null; terminals?: TerminalInfo[]; prs?: TaskPR[] };

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
