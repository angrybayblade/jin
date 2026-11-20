"use client";
import { act } from "@/lib/notices";
import { Archive, ArchiveRestore, MessageSquarePlus, Pencil, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
  return <ChatList kind={kind} chats={chats} activeId={activeId} activeState={activeState} layout="bar" />;
}

/**
 * The sidebar's Chats: jin's chats as a list (newest first) under a "Chats" heading with its
 * "+". The open one is the URL's (?chat=<id>, ?chat=new, else the newest) while on `base`.
 */
export function SidebarChats({ kind, chats, base, pending = 0 }: { kind: ChatKind; chats: Session[]; base: string; pending?: number }) {
  const path = usePathname();
  const want = useSearchParams().get("chat");
  const here = path === base;
  const activeId = !here ? undefined : want === "new" ? null : (chats.find((c) => c.id === want) ?? chats[0])?.id ?? null;
  const active = chats.find((c) => c.id === activeId);
  return <ChatList kind={kind} chats={chats} activeId={activeId} activeState={active?.state ?? "idle"} layout="list" base={base} pending={pending} />;
}

/** `activeId` undefined: none of these is open (another page is); null: a new chat is. */
function ChatList({ kind, chats, activeId, activeState, layout, base, pending = 0 }: { kind: ChatKind; chats: Session[]; activeId: string | null | undefined; activeState: SessionState; layout: "bar" | "list"; base?: string; pending?: number }) {
  const router = useRouter();
  const current = usePathname();
  const path = base ?? current;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const bar = useRef<HTMLDivElement>(null);
  // The bar: oldest left; the list: newest on top.
  const live = [...chats].filter((s) => !gone.has(s.id));
  const tabs = layout === "bar" ? live.reverse() : live;
  const go = (chat: string) => router.push(`${path}?chat=${encodeURIComponent(chat)}`);

  // Keep the open tab in view.
  useEffect(() => {
    if (layout !== "bar") return;
    bar.current?.querySelector<HTMLElement>(".chat-tab.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length, layout]);

  /** Archive or delete a tab; leaving the open one moves to its neighbour. */
  const drop = async (s: Session, how: "archive" | "delete") => {
    const at = tabs.findIndex((t) => t.id === s.id);
    setGone((g) => new Set(g).add(s.id));
    if (s.id === activeId) {
      const next = tabs[at + 1] ?? tabs[at - 1];
      go(next ? next.id : "new");
    }
    await act(how === "archive" ? "Couldn't archive the chat" : "Couldn't delete the chat", () => (how === "archive" ? updateSession(s.id, { archived: true }) : deleteSession(s.id)));
    router.refresh();
  };

  // ⌘T a new chat, ⌘W archive the open one (as its × does), ⌘1–9 a chat; only while these chats are open.
  useTabShortcuts({
    count: activeId === undefined ? 0 : tabs.length,
    create: () => activeId !== undefined && go("new"),
    select: (i) => tabs[i] && go(tabs[i]!.id),
    close: () => {
      const s = tabs.find((t) => t.id === activeId);
      if (s) void drop(s, "archive");
    },
  });

  const menu = (s: Session): MenuItem[] => [
    { label: "Rename", icon: Pencil, run: () => setRenaming(s.id) },
    { label: "New chat", icon: MessageSquarePlus, run: () => go("new") },
    { divider: true },
    { label: "Archive", icon: Archive, run: () => drop(s, "archive") },
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

  if (layout === "list") {
    return (
      <>
        <div className="nav-section">
          <Link href={path} className="nav-section-link" title={pending > 0 ? `${pending} approval${pending === 1 ? "" : "s"} waiting` : "Jin, your orchestrator"}>
            Chats
            {pending > 0 && <span className="nav-count">{pending}</span>}
          </Link>
          <button type="button" className="nav-section-action" onClick={() => go("new")} onContextMenu={(e) => void plusMenu(e)} title="New chat (right-click to restore an archived one)" aria-label="New chat">
            <Plus size={13} />
          </button>
        </div>
        {activeId === null && (
          <div className="nav-item is-chat active">
            <span className="status-dot" aria-hidden="true" />
            <span className="nav-label">New chat</span>
          </div>
        )}
        {tabs.map((s) => {
          const active = s.id === activeId;
          const state = active ? activeState : s.state;
          return (
            <Link
              key={s.id}
              href={`${path}?chat=${encodeURIComponent(s.id)}`}
              className={`nav-item is-chat ${active ? "active" : ""}`}
              title={label(s)}
              onDoubleClick={(e) => {
                e.preventDefault();
                setRenaming(s.id);
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                void drop(s, "archive");
              }}
              {...contextMenu(() => menu(s))}
            >
              {state === "running" || state === "waiting_approval" || state === "failed" ? <StatusMark state={state} /> : <span className="status-dot" aria-hidden="true" />}
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
                <span className="nav-label">{label(s)}</span>
              )}
            </Link>
          );
        })}
        {tabs.length === 0 && activeId !== null && <p className="sidebar-empty">No chats yet. Press + to ask jin something.</p>}
      </>
    );
  }

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
