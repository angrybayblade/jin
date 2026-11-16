"use client";
import { Code2, GitCompare, SquareTerminal } from "lucide-react";
import { useState } from "react";
import type { TerminalInfo } from "@/lib/daemon";
import { usePaneTheme } from "@/lib/theme";
import { ThemeToggle } from "../ThemeToggle";
import { DiffView } from "./DiffView";
import { FileEditor } from "./FileEditor";
import { TerminalTabs } from "./TerminalTabs";

const TABS = [
  { id: "editor", label: "Editor", icon: Code2 },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "diff", label: "Diff", icon: GitCompare },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** The task's workspace: tabbed editor, tabbed shells of your own, and the diff. */
export function WorkspacePane({ taskId, wsBase, shells }: { taskId: string; wsBase: string; shells: TerminalInfo[] }) {
  const [tab, setTab] = useState<Tab>("editor");
  const [terminalSeen, setTerminalSeen] = useState(false);
  const [theme, setTheme] = usePaneTheme("workspace");
  return (
    <section className="workspace-pane" data-theme={theme === "system" ? undefined : theme} aria-label="Workspace">
      <header className="pane-header">
        <div className="tabs" role="tablist">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`tab ${tab === id ? "is-selected" : ""}`}
              onClick={() => {
                setTab(id);
                if (id === "terminal") setTerminalSeen(true);
              }}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
        <div className="pane-actions">
          <span className="meta mono">{taskId}</span>
          <ThemeToggle value={theme} onChange={setTheme} label="Workspace pane theme" />
        </div>
      </header>
      <div className="workspace-body">
        <div hidden={tab !== "editor"} className="tab-panel">
          <FileEditor taskId={taskId} />
        </div>
        <div hidden={tab !== "terminal"} className="tab-panel">
          {(terminalSeen || shells.length > 0) && <TerminalTabs taskId={taskId} kind="shell" terminals={shells} wsBase={wsBase} visible={tab === "terminal"} />}
        </div>
        <div hidden={tab !== "diff"} className="tab-panel">
          <DiffView taskId={taskId} active={tab === "diff"} />
        </div>
      </div>
    </section>
  );
}
