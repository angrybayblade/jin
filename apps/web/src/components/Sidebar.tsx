"use client";
import { BookOpen, GitPullRequest, Layers, Mail, MessageSquare, SquareKanban } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import type { AgentStatus, Session, Task, TerminalInfo } from "@/lib/daemon";
import { StatusMark, ThermalMark } from "./ThermalMark";

export const DESKS: { kind: "slack" | "linear" | "notion" | "gmail" | "github"; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { kind: "github", label: "GitHub", icon: GitPullRequest },
  { kind: "slack", label: "Slack", icon: MessageSquare },
  { kind: "linear", label: "Linear", icon: SquareKanban },
  { kind: "notion", label: "Notion", icon: BookOpen },
  { kind: "gmail", label: "Gmail", icon: Mail },
];

const AGENT_MARK: Record<AgentStatus, "running" | "waiting_approval" | "idle" | "interrupted"> = {
  starting: "running",
  working: "running",
  waiting: "waiting_approval",
  idle: "idle",
  exited: "interrupted",
};

export function Sidebar({
  tasks,
  sessions,
  terminals,
  pendingApprovals,
  workspace,
  mode,
}: {
  tasks: Task[];
  sessions: Session[];
  terminals: TerminalInfo[];
  pendingApprovals: number;
  workspace: string;
  mode: string;
}) {
  const path = usePathname();
  const latest = (pred: (s: Session) => boolean) => sessions.find(pred);
  const jin = latest((s) => s.kind === "jin");
  const live = tasks.filter((t) => t.state === "ready");
  return (
    <aside className="sidebar">
      <Link href="/" className="workspace-brand" aria-label="jin">
        <ThermalMark size={26} label="jin" state={jin?.state === "running" ? "working" : "idle"} />
        <span>jin</span>
      </Link>

      <nav aria-label="Chats">
        <Link href="/" className={`nav-item ${path === "/" ? "active" : ""}`}>
          <Layers size={15} />
          <span className="nav-label">Jin</span>
          {pendingApprovals > 0 && <span className="nav-count" title="Approvals waiting">{pendingApprovals}</span>}
        </Link>

        <div className="nav-section">Tasks</div>
        {live.length === 0 && <p className="sidebar-empty">Ask jin to start one.</p>}
        {live.map((t) => {
          // Claude Code's status (from its hooks), else the latest SDK session's.
          const cli = terminals.filter((x) => x.taskId === t.id && x.kind === "claude").at(-1);
          const s = latest((x) => x.taskId === t.id);
          const mark = cli ? AGENT_MARK[cli.status] : s?.state;
          return (
            <Link key={t.id} href={`/t/${encodeURIComponent(t.id)}`} className={`nav-item task ${path === `/t/${t.id}` ? "active" : ""}`} title={t.slug}>
              {mark ? <StatusMark state={mark} /> : <span className="status-dot" aria-hidden="true" />}
              <span className="nav-label">
                <span className="mono">{t.id}</span> <span className="nav-sub">{t.slug}</span>
              </span>
            </Link>
          );
        })}

        <div className="nav-section">Desks</div>
        {DESKS.map(({ kind, label, icon: Icon }) => {
          const s = latest((x) => x.kind === kind);
          return (
            <Link key={kind} href={`/c/${kind}`} className={`nav-item ${path === `/c/${kind}` ? "active" : ""}`}>
              <Icon size={15} />
              <span className="nav-label">{label}</span>
              {s && (s.state === "running" || s.state === "waiting_approval") && <StatusMark state={s.state} />}
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-bottom meta">
        {workspace} · {mode === "vm" ? "always on" : "local"}
      </div>
    </aside>
  );
}
