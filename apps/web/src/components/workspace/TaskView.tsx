"use client";
import type { TaskPR, TerminalInfo } from "@/lib/daemon";
import { TaskWorkspace } from "./TaskWorkspace";

/** A task: one bar of tabs across the top, the open tab below, and the file tree on the right. */
export function TaskView(props: { machine: string; taskId: string; subtitle: string; terminals: TerminalInfo[]; prs: TaskPR[]; wsBase: string }) {
  return <TaskWorkspace {...props} />;
}
