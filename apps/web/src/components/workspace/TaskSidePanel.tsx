"use client";
import { FilesPanel } from "./FilesPanel";
import { JournalPanel } from "./JournalPanel";

export type SideTab = "files" | "journal";

/** The task's right panel: its files, or the work journal (what Claude Code decided and did). The top bar switches it. */
export function TaskSidePanel({ tab, taskId, openPath, onOpen }: { tab: SideTab; taskId: string; openPath: string | null; onOpen: (path: string) => void }) {
  return <div className="task-side">{tab === "files" ? <FilesPanel taskId={taskId} openPath={openPath} onOpen={onOpen} /> : <JournalPanel taskId={taskId} onOpen={onOpen} />}</div>;
}
