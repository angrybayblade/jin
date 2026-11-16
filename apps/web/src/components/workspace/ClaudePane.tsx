"use client";
import { Plus, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { closeTerminal, openTerminal } from "@/app/actions";
import type { AgentStatus, TerminalInfo } from "@/lib/daemon";
import { StatusMark, ThermalMark } from "../ThermalMark";
import { TerminalView } from "./TerminalView";

const MARK: Record<AgentStatus, "running" | "waiting_approval" | "idle" | "interrupted"> = {
  starting: "running",
  working: "running",
  waiting: "waiting_approval",
  idle: "idle",
  exited: "interrupted",
};
const LABEL: Record<AgentStatus, string> = {
  starting: "starting",
  working: "working",
  waiting: "waiting for you",
  idle: "ready",
  exited: "exited",
};

// Opening is not idempotent; React runs effects twice in development, so share one request per task.
const opening = new Map<string, Promise<TerminalInfo>>();

/** Claude Code's own TUI for a task, running in the task's worktree. */
export function ClaudePane({ taskId, title, subtitle, initial, wsBase }: { taskId: string; title: string; subtitle: string; initial: TerminalInfo | null; wsBase: string }) {
  const router = useRouter();
  const [terminal, setTerminal] = useState<TerminalInfo | null>(initial);
  const [error, setError] = useState<string | null>(null);

  // Status comes from the server (Claude Code's hooks report it), refreshed by the shell.
  useEffect(() => {
    if (initial && initial.id === terminal?.id) setTerminal(initial);
  }, [initial, terminal?.id]);

  useEffect(() => {
    if (terminal) return;
    let p = opening.get(taskId);
    if (!p) {
      p = openTerminal({ taskId, kind: "claude" });
      opening.set(taskId, p);
    }
    p.then(setTerminal, (e) => setError(e instanceof Error ? e.message : String(e))).finally(() => setTimeout(() => opening.delete(taskId), 1000));
  }, [terminal, taskId]);

  const restart = async () => {
    if (terminal) await closeTerminal(terminal.id).catch(() => {});
    setTerminal(null);
    router.refresh();
  };

  const status = terminal?.status ?? "starting";
  return (
    <section className="claude-pane" data-theme="dark" aria-label={`Claude Code for ${taskId}`}>
      <header className="pane-header">
        <div className="pane-title">
          <StatusMark state={MARK[status]} />
          <span className="pane-name">{title}</span>
          <span className="meta">
            Claude Code · {LABEL[status]} · {subtitle}
          </span>
        </div>
        <div className="pane-actions">
          <button type="button" className="button quiet" onClick={() => void restart()} title={status === "exited" ? "Start Claude Code again" : "Close this session and start a new one"}>
            {status === "exited" ? <RotateCcw size={14} /> : <Plus size={14} />} {status === "exited" ? "Restart" : "New session"}
          </button>
        </div>
      </header>
      <div className="claude-body">
        {terminal ? (
          <TerminalView key={terminal.id} terminalId={terminal.id} wsBase={wsBase} active autoFocus />
        ) : (
          <div className="editor-empty">
            {error ?? (
              <>
                <ThermalMark size={28} state="working" /> Starting Claude Code…
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
