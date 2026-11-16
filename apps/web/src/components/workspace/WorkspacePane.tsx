"use client";
import { Code2, GitCompare, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { DiffView } from "./DiffView";
import { FileEditor } from "./FileEditor";
import { TerminalView } from "./TerminalView";

const TABS = [
  { id: "editor", label: "Editor", icon: Code2 },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "diff", label: "Diff", icon: GitCompare },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** The task's workspace: editor, terminal and diff, on the dark coding surface. */
export function WorkspacePane({ taskId, wsBase }: { taskId: string; wsBase: string }) {
  const [tab, setTab] = useState<Tab>("editor");
  // The terminal stays mounted once opened, so its shell survives tab switches.
  const [terminalOpened, setTerminalOpened] = useState(false);
  return (
    <section className="workspace-pane" data-theme="dark" aria-label="Workspace">
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
                if (id === "terminal") setTerminalOpened(true);
              }}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
        <span className="meta mono">{taskId}</span>
      </header>
      <div className="workspace-body">
        <div hidden={tab !== "editor"} className="tab-panel">
          <FileEditor taskId={taskId} />
        </div>
        <div hidden={tab !== "terminal"} className="tab-panel">
          {terminalOpened && <TerminalView taskId={taskId} wsBase={wsBase} active={tab === "terminal"} />}
        </div>
        <div hidden={tab !== "diff"} className="tab-panel">
          <DiffView taskId={taskId} active={tab === "diff"} />
        </div>
      </div>
    </section>
  );
}
