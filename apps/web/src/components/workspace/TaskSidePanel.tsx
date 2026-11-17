"use client";
import { ActivityPanel } from "./ActivityPanel";
import { FilesPanel } from "./FilesPanel";
import { JournalPanel } from "./JournalPanel";

export type SideTab = "files" | "journal" | "activity";

/** The task's right panel: its files, the work journal (what Claude Code decided and did), or its Activity (what it follows). The top bar switches it. */
export function TaskSidePanel({ tab, taskId, openPath, onOpen }: { tab: SideTab; taskId: string; openPath: string | null; onOpen: (path: string) => void }) {
  return (
    <div className="task-side">
      {tab === "files" ? <FilesPanel taskId={taskId} openPath={openPath} onOpen={onOpen} /> : tab === "journal" ? <JournalPanel taskId={taskId} onOpen={onOpen} /> : <ActivityPanel taskId={taskId} />}
    </div>
  );
}
