"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getTaskJob } from "@/app/actions";
import type { TaskJob } from "@/lib/daemon";
import { ThermalMark } from "./ThermalMark";

const elapsed = (from: string, to?: string | null) => {
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** A task being set up: the workspace tooling's output, live, until the task is ready. */
export function TaskSetup({ initial }: { initial: TaskJob }) {
  const router = useRouter();
  const [job, setJob] = useState(initial);
  const [, tick] = useState(0);
  const log = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (job.state !== "running") return;
    const timer = setInterval(async () => {
      try {
        const next = await getTaskJob(job.id);
        setJob(next);
        if (next.state === "done") router.refresh(); // the task exists now: the page becomes the task view
      } catch {}
      tick((n) => n + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [job.id, job.state, router]);

  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [job.log.length]);

  return (
    <section className="task-setup" aria-live="polite">
      <header className="pane-header">
        <div className="pane-title">
          <ThermalMark size={18} state={job.state === "running" ? "working" : "idle"} variant={job.state === "failed" ? "command" : "blob"} />
          <span className="pane-name">{job.taskId}</span>
          <span className="meta">
            {job.slug} · {job.repos.join(", ")}
          </span>
        </div>
        <span className="meta">
          {job.state === "running" ? `setting up · ${elapsed(job.startedAt)}` : job.state === "done" ? `ready in ${elapsed(job.startedAt, job.finishedAt)}` : "setup failed"}
        </span>
      </header>
      <div className="task-setup-body">
        <p className="meta">
          {job.state === "failed"
            ? "The workspace's tooling stopped. Its output is below; fix the cause and create the task again (a partly set-up task may need `cws task rm` first)."
            : job.setup
              ? "Creating the branch and worktrees, then running each repo's setup. Claude Code opens here when it is ready."
              : "Creating the branch and worktrees."}
        </p>
        <pre ref={log} className="setup-log" data-scroll="y">
          {job.log.length ? job.log.join("\n") : "Waiting for output…"}
        </pre>
        {job.error && <p className="field-error">{job.error}</p>}
      </div>
    </section>
  );
}
