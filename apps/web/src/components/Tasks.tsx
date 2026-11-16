import Link from "next/link";
import { startSession } from "@/app/actions";
import type { Session, Task } from "@/lib/daemon";
import { StatusMark } from "./ThermalMark";

/** Tasks with their latest agent session, and a way to start one. */
export function Tasks({ tasks, sessions }: { tasks: Task[]; sessions: Session[] }) {
  const live = tasks.filter((t) => t.state === "ready");
  return (
    <section className="tasks" aria-labelledby="tasks-heading">
      <div className="section-label" id="tasks-heading">
        Tasks
      </div>
      {live.length === 0 ? (
        <p className="meta">No tasks yet. Start one from an item in the feed.</p>
      ) : (
        <ul className="task-list">
          {live.map((t) => {
            const latest = sessions.find((s) => s.taskId === t.id);
            return (
              <li key={t.id} className="task-row">
                <div className="task-head">
                  {latest ? <StatusMark state={latest.state} /> : <span className="status-dot" aria-hidden="true" />}
                  <span className="task-id">{t.id}</span>
                  <span className="meta">{t.repos.join(", ")}</span>
                </div>
                <div className="task-slug">{t.slug}</div>
                {latest ? (
                  <Link className="button quiet" href={`/sessions/${latest.id}`}>
                    Open session
                  </Link>
                ) : (
                  <form action={startSession} className="start-session">
                    <input type="hidden" name="taskId" value={t.id} />
                    <input name="prompt" required placeholder="What should the agent do?" aria-label={`Prompt for ${t.id}`} />
                    <button type="submit" className="button primary">
                      Start
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
