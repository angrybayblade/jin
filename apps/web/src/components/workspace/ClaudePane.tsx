"use client";
import type { TerminalInfo } from "@/lib/daemon";
import { usePaneTheme } from "@/lib/theme";
import { ThemeToggle } from "../ThemeToggle";
import { TerminalTabs } from "./TerminalTabs";

/** Claude Code's own TUI for a task, as tabs of sessions in the task's worktree. */
export function ClaudePane({ taskId, title, subtitle, terminals, wsBase }: { taskId: string; title: string; subtitle: string; terminals: TerminalInfo[]; wsBase: string }) {
  const [theme, setTheme] = usePaneTheme("claude");
  return (
    <section className="claude-pane" data-theme={theme === "system" ? undefined : theme} aria-label={`Claude Code for ${taskId}`}>
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-name">{title}</span>
          <span className="meta">{subtitle}</span>
        </div>
        <div className="pane-actions">
          <ThemeToggle value={theme} onChange={setTheme} label="Claude Code pane theme" />
        </div>
      </header>
      <div className="claude-body">
        <TerminalTabs taskId={taskId} kind="claude" terminals={terminals} wsBase={wsBase} />
      </div>
    </section>
  );
}
