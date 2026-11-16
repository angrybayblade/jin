"use client";
import type { TerminalInfo } from "@/lib/daemon";
import { TaskWorkspace } from "./TaskWorkspace";

/** A task: one bar of tabs across the top, the open tab below, and the file tree on the right. */
export function TaskView(props: { taskId: string; subtitle: string; terminals: TerminalInfo[]; wsBase: string }) {
  return <TaskWorkspace {...props} />;
}
