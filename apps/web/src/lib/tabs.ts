"use client";
import { useSyncExternalStore } from "react";

/** An open tab anywhere in the workspace: an agent session, a shell or a file. */
export interface TabEntry {
  id: string;
  group: "agent" | "shell" | "file";
  label: string;
  detail?: string;
  /** Bring it to front (switch the pane's tab, focus it). */
  activate: () => void;
  lastActive: number;
}

const owners = new Map<string, TabEntry[]>();
const lastActive = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshot: TabEntry[] = [];

function publish() {
  snapshot = [...owners.values()].flat().map((t) => ({ ...t, lastActive: lastActive.get(t.id) ?? 0 }));
  for (const l of listeners) l();
}

/** Replace the tabs an owner (a tab bar) currently has open. */
export function registerTabs(owner: string, entries: Omit<TabEntry, "lastActive">[]) {
  owners.set(owner, entries as TabEntry[]);
  publish();
}

export function unregisterTabs(owner: string) {
  owners.delete(owner);
  publish();
}

/** Mark a tab as just used, for the switcher's most-recent-first order. */
export function touchTab(id: string) {
  lastActive.set(id, Date.now());
  publish();
}

export function useTabs(): TabEntry[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}

// ---------------------------------------------------------------- workspace events

/** Open a file in the task's editor (from the finder or search), optionally at a line. */
export function openFileInEditor(taskId: string, path: string, line?: number) {
  window.dispatchEvent(new CustomEvent("jin:open-file", { detail: { taskId, path, line } }));
}

export function openNewTaskDialog() {
  window.dispatchEvent(new Event("jin:new-task"));
}
