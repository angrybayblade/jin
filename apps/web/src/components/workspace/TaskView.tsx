"use client";
import { useCallback, useRef, useState } from "react";
import type { TerminalInfo } from "@/lib/daemon";
import { Panes } from "../Panes";
import { FilesPanel } from "./FilesPanel";
import { TaskWorkspace, type TaskWorkspaceHandle } from "./TaskWorkspace";

/** A task: one row of tabs (sessions, terminals, files, diff) and the file tree on the right. */
export function TaskView({ taskId, subtitle, terminals, wsBase }: { taskId: string; subtitle: string; terminals: TerminalInfo[]; wsBase: string }) {
  const handle = useRef<TaskWorkspaceHandle | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const bind = useCallback((h: TaskWorkspaceHandle) => void (handle.current = h), []);
  return (
    <Panes
      id="task"
      defaultSplit={78}
      minLeft={480}
      minRight={200}
      left={<TaskWorkspace taskId={taskId} subtitle={subtitle} terminals={terminals} wsBase={wsBase} bindHandle={bind} onActiveFile={setOpenPath} />}
      right={<FilesPanel taskId={taskId} subtitle={subtitle} openPath={openPath} onOpen={(p) => handle.current?.openFile(p)} onShowChanges={() => handle.current?.showChanges()} />}
    />
  );
}
