"use client";
import { useEffect, useState } from "react";
import { FilesPanel } from "./FilesPanel";
import { JournalPanel } from "./JournalPanel";

type Tab = "files" | "journal";
const KEY = "jin-task-side";

/** The task's right panel: its files, or the work journal (what Claude Code decided and did). */
export function TaskSidePanel({ taskId, openPath, onOpen }: { taskId: string; openPath: string | null; onOpen: (path: string) => void }) {
  const [tab, setTab] = useState<Tab>("files");
  useEffect(() => {
    try {
      const t = localStorage.getItem(KEY);
      if (t === "files" || t === "journal") setTab(t);
    } catch {}
  }, []);
  const choose = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem(KEY, t);
    } catch {}
  };
  return (
    <div className="task-side">
      <div className="task-side-tabs" role="tablist">
        {(["files", "journal"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "is-active" : ""} onClick={() => choose(t)}>
            {t === "files" ? "Files" : "Journal"}
          </button>
        ))}
      </div>
      <div className="task-side-body">{tab === "files" ? <FilesPanel taskId={taskId} openPath={openPath} onOpen={onOpen} /> : <JournalPanel taskId={taskId} onOpen={onOpen} />}</div>
    </div>
  );
}
