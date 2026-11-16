"use client";
import { Archive, ArchiveRestore, MessageSquarePlus, Pencil, Plus, Trash2, X, XCircle } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { archivedChats, deleteSession, updateSession } from "@/app/actions";
import type { ChatKind, Session, SessionState } from "@/lib/daemon";
import { useTabShortcuts } from "@/lib/shortcuts";
import { contextMenu, openContextMenu, type MenuItem } from "./ContextMenu";
import { RenameInput } from "./RenameInput";
import { StatusMark } from "./ThermalMark";

const label = (s: Session) => s.title?.trim() || "New chat";

/**
 * A chat pane's tabs, in its top bar: one per chat (oldest left), plus a "New chat" tab while
 * one is being started. The open chat is in the URL (?chat=<id>, or ?chat=new).
 */
export function ChatTabs({ kind, chats, activeId, activeState }: { kind: ChatKind; chats: Session[]; activeId: string | null; activeState: SessionState }) {
  const router = useRouter();
  const path = usePathname();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const bar = useRef<HTMLDivElement>(null);
  const tabs = [...chats].filter((s) => !gone.has(s.id)).reverse();
  const go = (chat: string) => router.push(`${path}?chat=${encodeURIComponent(chat)}`);

  // Keep the open tab in view.
  useEffect(() => {
    bar.current?.querySelector<HTMLElement>(".chat-tab.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  /** Archive or delete a tab; leaving the open one moves to its neighbour. */
  const drop = async (s: Session, how: "archive" | "delete") => {
    const at = tabs.findIndex((t) => t.id === s.id);
    setGone((g) => new Set(g).add(s.id));
    if (s.id === activeId) {
      const next = tabs[at + 1] ?? tabs[at - 1];
      go(next ? next.id : "new");
    }
    await (how === "archive" ? updateSession(s.id, { archived: true }) : deleteSession(s.id)).catch(() => {});
    router.refresh();
  };

  // ⌘T a new chat, ⌘W archive the open one (as its × does), ⌘1–9 a chat.
  useTabShortcuts({
    count: tabs.length,
    create: () => go("new"),
    select: (i) => tabs[i] && go(tabs[i]!.id),
    close: () => {
      const s = tabs.find((t) => t.id === activeId);
      if (s) void drop(s, "archive");
    },
  });

  const menu = (s: Session): MenuItem[] => [
    { header: label(s) },
    { label: "Rename", icon: Pencil, run: () => setRenaming(s.id) },
    { label: "New chat", icon: MessageSquarePlus, run: () => go("new") },
    { divider: true },
    { label: "Archive", icon: Archive, hint: "keeps its history", run: () => drop(s, "archive") },
    {
      label: "Archive others",
      icon: XCircle,
      disabled: tabs.length < 2,
      run: async () => {
        go(s.id);
        for (const o of tabs) if (o.id !== s.id) await drop(o, "archive");
      },
    },
    { label: "Delete", icon: Trash2, danger: true, confirm: "Delete this chat and its history?", run: () => drop(s, "delete") },
  ];

  /** Right-click "+": start a chat, or bring back an archived one. */
  const plusMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const point = { clientX: e.clientX, clientY: e.clientY };
    const items: MenuItem[] = [{ label: "New chat", icon: Plus, run: () => go("new") }];
    const old = await archivedChats(kind).catch(() => [] as Session[]);
    if (old.length) {
      items.push({ divider: true }, { header: "Archived chats" });
      for (const s of old.slice(0, 12))
        items.push({
          label: label(s),
          icon: ArchiveRestore,
          hint: new Date(s.createdAt).toLocaleDateString(),
          run: async () => {
            await updateSession(s.id, { archived: false });
            go(s.id);
            router.refresh();
          },
        });
    }
    openContextMenu(point, items);
  };

  return (
    <div className="chat-tabs" role="tablist" aria-label="Chats" ref={bar}>
      {tabs.map((s) => {
        const active = s.id === activeId;
        const state = active ? activeState : s.state;
        return (
          <div
            key={s.id}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            className={`chat-tab ${active ? "is-active" : ""}`}
            title={label(s)}
            onClick={() => !active && go(s.id)}
            onDoubleClick={() => setRenaming(s.id)}
            onAuxClick={(e) => e.button === 1 && void drop(s, "archive")}
            {...contextMenu(() => menu(s))}
          >
            {(state === "running" || state === "waiting_approval" || state === "failed") && <StatusMark state={state} />}
            {renaming === s.id ? (
              <RenameInput
                value={label(s)}
                label={`Rename ${label(s)}`}
                onCancel={() => setRenaming(null)}
                onSave={(v) => {
                  setRenaming(null);
                  void updateSession(s.id, { title: v }).then(() => router.refresh());
                }}
              />
            ) : (
              <span className="chat-tab-name">{label(s)}</span>
            )}
            <button
              type="button"
              className="file-tab-close"
              aria-label={`Archive ${label(s)}`}
              title="Archive (keeps its history)"
              onClick={(e) => {
                e.stopPropagation();
                void drop(s, "archive");
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      {activeId === null && (
        <div role="tab" aria-selected className="chat-tab is-active is-new">
          <span className="chat-tab-name">New chat</span>
        </div>
      )}
      <button type="button" className="term-tab-new" onClick={() => go("new")} onContextMenu={(e) => void plusMenu(e)} title="New chat (right-click to restore an archived one)" aria-label="New chat">
        <Plus size={14} />
      </button>
    </div>
  );
}
