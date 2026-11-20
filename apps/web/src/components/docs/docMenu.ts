"use client";
import { Archive, ClipboardCopy, Copy, ExternalLink, FolderInput, FolderMinus, Pencil, Trash2 } from "lucide-react";
import { addTaskLink, archiveDoc, deleteDoc, duplicateDoc, removeTaskLink, taskTargets } from "@/lib/actions";
import { openContextMenu, type MenuItem } from "../ContextMenu";

/**
 * A doc's context menu, the same in the sidebar and on a task's doc tab: rename, duplicate,
 * move (to a task, or out of this one), copy its link, archive, delete.
 */
export interface DocMenuContext {
  doc: { id: string; title: string };
  /** Where it was opened (the second menu, of tasks, opens there too). */
  at: { clientX: number; clientY: number };
  rename: () => void;
  /** After a duplicate: open the copy. */
  opened: (id: string) => void;
  /** After archive or delete (and a move out of the task): drop it from view. */
  gone: () => void;
  /** On a task's tab: the task it is in, and how to open the doc on its own page. */
  task?: { id: string; machine: string; openInDocs: () => void };
  onError: (e: string) => void;
}

export function docMenu(c: DocMenuContext): MenuItem[] {
  const link = `doc:${c.doc.id}`;
  const moveMenu = async () => {
    const tasks = (await taskTargets()).filter((t) => !(c.task && t.id === c.task.id && t.machine === c.task.machine));
    const several = new Set(tasks.map((t) => t.machine)).size > 1;
    const items: MenuItem[] = tasks.length
      ? [
          { header: c.task ? "Move to task" : "Add to task" },
          ...tasks.map((t) => ({
            label: `${t.id} ${t.title}`.slice(0, 60),
            hint: several ? t.machineLabel : undefined,
            run: async () => {
              const r = await addTaskLink(t.id, link, t.machine === "local" ? "local" : t.machine);
              if ("error" in r) return c.onError(r.error);
              if (c.task) {
                await removeTaskLink(c.task.id, link, c.task.machine);
                c.gone();
              }
            },
          })),
        ]
      : [{ header: "No other open tasks" }];
    openContextMenu({ ...c.at, preventDefault: () => {} }, items);
  };
  return [
    { label: "Rename", icon: Pencil, run: c.rename },
    {
      label: "Duplicate",
      icon: Copy,
      run: async () => {
        const d = await duplicateDoc(c.doc.id);
        if ("error" in d) return c.onError(d.error);
        if (c.task) await addTaskLink(c.task.id, `doc:${d.id}`, c.task.machine);
        c.opened(d.id);
      },
    },
    { label: c.task ? "Move to another task…" : "Add to a task…", icon: FolderInput, run: () => void moveMenu() },
    ...(c.task
      ? [
          {
            label: "Remove from this task",
            icon: FolderMinus,
            run: async () => {
              await removeTaskLink(c.task!.id, link, c.task!.machine);
              c.gone();
            },
          } satisfies MenuItem,
          { label: "Open in Docs", icon: ExternalLink, run: c.task.openInDocs } satisfies MenuItem,
        ]
      : []),
    { label: "Copy link for a task", icon: ClipboardCopy, hint: link, run: () => void navigator.clipboard.writeText(link).catch(() => {}) },
    { divider: true },
    {
      label: "Archive",
      icon: Archive,
      run: async () => {
        await archiveDoc(c.doc.id);
        c.gone();
      },
    },
    {
      label: "Delete",
      icon: Trash2,
      danger: true,
      confirm: "Delete this doc for good, with its versions, comments and suggestions?",
      run: async () => {
        const r = await deleteDoc(c.doc.id);
        if ("error" in r) return c.onError(r.error);
        c.gone();
      },
    },
  ];
}
