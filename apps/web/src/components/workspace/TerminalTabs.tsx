"use client";
import { Play, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { closeTerminal, openTerminal, startTerminal } from "@/app/actions";
import type { AgentStatus, TerminalInfo } from "@/lib/daemon";
import { useArmedConfirm } from "@/lib/confirm";
import { registerTabs, touchTab, unregisterTabs } from "@/lib/tabs";
import { StatusMark, ThermalMark } from "../ThermalMark";
import { TerminalView } from "./TerminalView";

const MARK: Record<AgentStatus, "running" | "waiting_approval" | "idle" | "interrupted"> = {
  starting: "running",
  working: "running",
  waiting: "waiting_approval",
  idle: "idle",
  exited: "interrupted",
  interrupted: "interrupted",
};

const running = (t: TerminalInfo) => t.status !== "exited" && t.status !== "interrupted";

// Opening is not idempotent and React runs effects twice in development: one request per key.
const pending = new Map<string, Promise<TerminalInfo>>();
function once(key: string, fn: () => Promise<TerminalInfo>): Promise<TerminalInfo> {
  let p = pending.get(key);
  if (!p) {
    p = fn().finally(() => setTimeout(() => pending.delete(key), 1500));
    pending.set(key, p);
  }
  return p;
}

/**
 * Several persistent terminals for a task, as tabs: Claude Code sessions or shells. Tabs
 * survive reloads and daemon restarts; an interrupted tab starts again when shown (Claude
 * Code resumes its conversation).
 */
export function TerminalTabs({
  taskId,
  kind,
  terminals,
  wsBase,
  visible = true,
}: {
  taskId: string;
  kind: "claude" | "shell";
  terminals: TerminalInfo[];
  wsBase: string;
  visible?: boolean;
}) {
  const router = useRouter();
  const storageKey = `jin-tab:${taskId}:${kind}`;
  const [local, setLocal] = useState<Record<string, TerminalInfo>>({});
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(new Set<string>());

  // Server list (refreshed by the shell), overlaid with what this view just created or started.
  const tabs = useMemo(() => {
    const byId = new Map(terminals.map((t) => [t.id, t]));
    for (const t of Object.values(local)) {
      const server = byId.get(t.id);
      // Prefer the local copy until the server reports the tab running.
      if (!server || (!running(server) && running(t))) byId.set(t.id, t);
    }
    return [...byId.values()].filter((t) => !closed.has(t.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [terminals, local, closed]);

  useEffect(() => {
    try {
      setSelected(localStorage.getItem(storageKey));
    } catch {}
  }, [storageKey]);
  const current = tabs.find((t) => t.id === selected) ?? tabs.at(-1) ?? null;
  useEffect(() => {
    if (!current) return;
    touchTab(current.id);
    try {
      localStorage.setItem(storageKey, current.id);
    } catch {}
  }, [current?.id, storageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const remember = (t: TerminalInfo) => setLocal((l) => ({ ...l, [t.id]: t }));

  // The tab switcher (⌘E) lists these tabs and can bring one to front.
  const owner = `term:${taskId}:${kind}`;
  useEffect(() => {
    registerTabs(
      owner,
      tabs.map((t) => ({
        id: t.id,
        group: kind,
        label: t.title,
        detail: `${taskId} · ${kind === "claude" ? `Claude Code · ${t.status}` : "shell"}`,
        activate: () => {
          setSelected(t.id);
          if (kind === "shell") window.dispatchEvent(new CustomEvent("jin:show-pane-tab", { detail: { taskId, tab: "terminal" } }));
        },
      })),
    );
  }, [owner, tabs, kind, taskId]);
  useEffect(() => () => unregisterTabs(owner), [owner]);

  const create = () =>
    once(`${taskId}:${kind}:new:${tabs.length}`, () => openTerminal({ taskId, kind }))
      .then((t) => {
        remember(t);
        setSelected(t.id);
        router.refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  const start = (id: string) =>
    once(`start:${id}`, () => startTerminal(id))
      .then(remember)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  // A task always has one Claude Code tab; the shell opens the first time it is shown.
  useEffect(() => {
    if (visible && tabs.length === 0) void create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, tabs.length]);

  // An interrupted tab (daemon restart) starts again when shown, once.
  useEffect(() => {
    if (visible && current?.status === "interrupted" && !started.current.has(current.id)) {
      started.current.add(current.id);
      void start(current.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, current?.id, current?.status]);

  const confirmClose = useArmedConfirm();
  const close = async (t: TerminalInfo) => {
    // A running Claude Code session ends when its tab closes: the first click asks, the second closes.
    if (kind === "claude" && running(t) && !confirmClose.ask(t.id)) return;
    setClosed((c) => new Set(c).add(t.id));
    await closeTerminal(t.id).catch(() => {});
    router.refresh();
  };

  return (
    <div className="terminal-tabs">
      <div className="term-tabbar" role="tablist" aria-label={kind === "claude" ? "Claude Code sessions" : "Terminals"}>
        {tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === current?.id} className={`term-tab ${t.id === current?.id ? "is-active" : ""}`} onClick={() => setSelected(t.id)}>
            {kind === "claude" && <StatusMark state={MARK[t.status]} />}
            <span className="term-tab-name">{t.title}</span>
            <button
              type="button"
              className={`file-tab-close ${confirmClose.armed === t.id ? "is-armed" : ""}`}
              aria-label={confirmClose.armed === t.id ? `Click again to close ${t.title} and end its session` : `Close ${t.title}`}
              title={confirmClose.armed === t.id ? "Click again to close; the Claude Code session ends" : `Close ${t.title}`}
              onClick={(e) => {
                e.stopPropagation();
                void close(t);
              }}
            >
              {confirmClose.armed === t.id ? "Close?" : <X size={12} />}
            </button>
          </div>
        ))}
        <button type="button" className="term-tab-new" onClick={() => void create()} title={kind === "claude" ? "New Claude Code session" : "New terminal"} aria-label={kind === "claude" ? "New Claude Code session" : "New terminal"}>
          <Plus size={14} />
        </button>
      </div>
      <div className="term-body">
        {current && running(current) ? (
          <TerminalView
            key={current.id}
            terminalId={current.id}
            wsBase={wsBase}
            active={visible}
            autoFocus={kind === "claude"}
            onState={(s) => s === "exited" && remember({ ...current, status: "exited" })}
          />
        ) : current?.status === "exited" ? (
          <div className="editor-empty">
            <p>{kind === "claude" ? "Claude Code exited." : "The shell exited."}</p>
            <button type="button" className="button" onClick={() => void start(current.id)}>
              <Play size={13} /> {kind === "claude" && current.claudeSessionId ? "Resume the conversation" : "Start again"}
            </button>
          </div>
        ) : (
          <div className="editor-empty">
            {error ?? (
              <>
                <ThermalMark size={24} state="working" /> {current?.status === "interrupted" ? (kind === "claude" ? "Resuming Claude Code…" : "Starting the shell…") : "Starting…"}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
