"use client";
import { Code2, GitCompare, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { openTerminal } from "@/app/actions";
import type { TerminalInfo } from "@/lib/daemon";
import { DiffView } from "./DiffView";
import { FileEditor } from "./FileEditor";
import { TerminalView } from "./TerminalView";

const TABS = [
  { id: "editor", label: "Editor", icon: Code2 },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "diff", label: "Diff", icon: GitCompare },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** The task's workspace: editor, a shell of your own, and the diff, on the dark coding surface. */
export function WorkspacePane({ taskId, wsBase, initialShell }: { taskId: string; wsBase: string; initialShell: TerminalInfo | null }) {
  const [tab, setTab] = useState<Tab>("editor");
  const [shell, setShell] = useState<TerminalInfo | null>(initialShell);
  const [opening, setOpening] = useState(false);

  const show = async (id: Tab) => {
    setTab(id);
    if (id === "terminal" && (!shell || shell.status === "exited") && !opening) {
      setOpening(true);
      try {
        setShell(await openTerminal({ taskId, kind: "shell" }));
      } finally {
        setOpening(false);
      }
    }
  };

  return (
    <section className="workspace-pane" data-theme="dark" aria-label="Workspace">
      <header className="pane-header">
        <div className="tabs" role="tablist">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`tab ${tab === id ? "is-selected" : ""}`} onClick={() => void show(id)}>
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
          {shell && shell.status !== "exited" ? (
            <TerminalView key={shell.id} terminalId={shell.id} wsBase={wsBase} active={tab === "terminal"} onState={(s) => s === "exited" && setShell((x) => (x ? { ...x, status: "exited" } : x))} />
          ) : (
            <div className="editor-empty">{opening ? "Starting a shell…" : "The shell exited. Switch tabs to start a new one."}</div>
          )}
        </div>
        <div hidden={tab !== "diff"} className="tab-panel">
          <DiffView taskId={taskId} active={tab === "diff"} />
        </div>
      </div>
    </section>
  );
}
