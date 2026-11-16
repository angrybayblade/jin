"use client";
import { ArrowUp, Check, ChevronRight, Square, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createChat, sendMessage, startTaskSession, stopSession, streamTicket } from "@/app/actions";
import type { Approval, ChatKind, Session, SessionEvent, SessionKind, SessionState } from "@/lib/daemon";
import { Approvals } from "./Approvals";
import { ChatTabs } from "./ChatTabs";
import { Markdown } from "./Markdown";
import { StatusMark, ThermalMark } from "./ThermalMark";

type Item =
  | { type: "user"; seq: number; text: string }
  | { type: "agent"; seq: number; text: string }
  | { type: "tool"; seq: number; tool: string; input: Record<string, any>; status: "running" | "done" | "denied" | "waiting"; reason?: string }
  | { type: "note"; seq: number; tone: "error" | "meta"; text: string };

/** Turn the event log into chat items: messages, one row per tool call, and notes. */
function toItems(events: SessionEvent[]): Item[] {
  const items: Item[] = [];
  const openTools: Extract<Item, { type: "tool" }>[] = [];
  const key = (tool: string, input: unknown) => `${tool}:${JSON.stringify(input)}`;
  for (const e of events) {
    const p = e.payload;
    switch (e.kind) {
      case "prompt":
        items.push({ type: "user", seq: e.seq, text: p.text });
        break;
      case "message":
        items.push({ type: "agent", seq: e.seq, text: p.text });
        break;
      case "tool.requested": {
        const row = { type: "tool" as const, seq: e.seq, tool: p.tool, input: p.input ?? {}, status: "running" as const };
        items.push(row);
        openTools.push(row);
        break;
      }
      case "approval.requested": {
        const row = openTools.findLast((t) => key(t.tool, t.input) === key(p.tool, p.input));
        if (row) row.status = "waiting";
        break;
      }
      case "tool.denied": {
        const i = openTools.findLastIndex((t) => key(t.tool, t.input) === key(p.tool, p.input));
        if (i >= 0) {
          openTools[i]!.status = "denied";
          openTools[i]!.reason = p.reason;
          openTools.splice(i, 1);
        }
        break;
      }
      case "tool.allowed": {
        const row = openTools.findLast((t) => key(t.tool, t.input) === key(p.tool, p.input));
        if (row) row.status = "running";
        break;
      }
      case "tool.result": {
        const row = openTools.shift();
        if (row) row.status = "done";
        break;
      }
      case "session.failed":
        items.push({ type: "note", seq: e.seq, tone: "error", text: p.error });
        break;
      // The SDK's per-turn cost is a list-price estimate, not what a Claude subscription bills: not shown.
    }
  }
  // Tools still open when the session stopped did finish (results without ids are not matched).
  return items;
}

function stateFrom(events: SessionEvent[], initial: SessionState): SessionState {
  let state = initial;
  for (const e of events) {
    if (e.kind === "prompt" || e.kind === "approval.decided") state = "running";
    else if (e.kind === "approval.requested") state = "waiting_approval";
    else if (e.kind === "session.idle") state = "idle";
    else if (e.kind === "session.failed") state = "failed";
  }
  return state;
}

function toolLine(t: Extract<Item, { type: "tool" }>): string {
  if (typeof t.input.command === "string") return t.input.command;
  if (typeof t.input.file_path === "string") return `${t.tool} ${t.input.file_path}`;
  if (typeof t.input.pattern === "string") return `${t.tool} ${t.input.pattern}`;
  return t.tool.replace(/^mcp__/, "").replace(/__/g, " · ");
}

function ToolRow({ t }: { t: Extract<Item, { type: "tool" }> }) {
  const icon = t.status === "done" ? <Check size={14} /> : t.status === "denied" ? <X size={14} /> : <ThermalMark size={14} state={t.status === "waiting" ? "waiting" : "working"} variant="command" />;
  return (
    <div className={`tool-row is-${t.status}`}>
      <span className="tool-icon">{icon}</span>
      <code className="tool-line">{toolLine(t)}</code>
      {t.status === "denied" && t.reason && <span className="tool-reason">{t.reason}</span>}
      {t.status === "waiting" && <span className="tool-reason">waiting for your approval</span>}
    </div>
  );
}

export interface ChatProps {
  kind: SessionKind;
  taskId?: string;
  session: Session | null;
  initialEvents: SessionEvent[];
  /** Approvals to show above the composer (this chat's, or every pending one on jin's home). */
  approvals: Approval[];
  wsBase: string;
  title: string;
  subtitle?: ReactNode;
  welcome: { overline?: string; heading: string; body: string; suggestions: string[] };
  placeholder: string;
  /** Every open chat of this kind, shown as tabs in the top bar (jin's chat and the desks). */
  chats?: Session[];
}

export function Chat(props: ChatProps) {
  const router = useRouter();
  const path = usePathname();
  const [sessionId, setSessionId] = useState(props.session?.id ?? null);
  const [events, setEvents] = useState<SessionEvent[]>(props.initialEvents);
  const [draft, setDraft] = useState("");
  // Text of the message being written right now (live deltas, replaced by the recorded message).
  const [streaming, setStreaming] = useState("");
  const [busySending, setBusySending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const lastSeq = useRef(props.initialEvents.at(-1)?.seq ?? 0);

  const state = stateFrom(events, props.session?.state ?? "idle");
  const items = useMemo(() => toItems(events), [events]);
  const working = state === "running" || state === "waiting_approval";

  // Live events over a websocket to the daemon, opened with a one-time ticket.
  useEffect(() => {
    if (!sessionId) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const ticket = await streamTicket(sessionId);
        if (closed) return;
        ws = new WebSocket(`${props.wsBase}/api/sessions/${sessionId}/stream?after=${lastSeq.current}&ticket=${ticket}`);
        ws.onmessage = (m) => {
          const data = JSON.parse(String(m.data)) as SessionEvent | { ephemeral: true; kind: string; payload: { text?: string } };
          if ("ephemeral" in data) {
            if (data.kind === "message.delta" && data.payload.text) setStreaming((prev) => prev + data.payload.text);
            return;
          }
          const e = data;
          if (e.seq <= lastSeq.current) return;
          lastSeq.current = e.seq;
          // The recorded message (or the end of the turn) replaces the live text.
          if (e.kind === "message" || e.kind === "session.idle" || e.kind === "session.failed" || e.kind === "tool.requested") setStreaming("");
          setEvents((prev) => [...prev, e]);
          if (e.kind === "session.idle" || e.kind === "session.failed" || e.kind === "approval.requested") router.refresh();
        };
        ws.onclose = () => {
          if (!closed) retry = setTimeout(connect, 1500);
        };
      } catch {
        if (!closed) retry = setTimeout(connect, 3000);
      }
    };
    void connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [sessionId, props.wsBase, router]);

  // Keep the newest message in view while the reader is near the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [items.length, streaming]);

  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || busySending) return;
      setBusySending(true);
      setError(null);
      try {
        if (!sessionId) {
          const s = props.taskId ? await startTaskSession(props.taskId, prompt) : await createChat(props.kind as ChatKind, prompt);
          lastSeq.current = 0;
          setEvents([]);
          setSessionId(s.id);
          // The new chat becomes a tab of its own.
          if (props.chats) router.replace(`${path}?chat=${encodeURIComponent(s.id)}`);
        } else {
          await sendMessage(sessionId, prompt);
        }
        setDraft("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusySending(false);
      }
    },
    [busySending, sessionId, props.taskId, props.kind, props.chats, path, router],
  );

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };

  return (
    <section className="chat-panel" aria-label={props.title}>
      {props.chats && props.kind !== "task" ? (
        <header className="pane-header has-tabs">
          <ChatTabs kind={props.kind as ChatKind} chats={props.chats} activeId={sessionId} activeState={state} />
        </header>
      ) : (
        <header className="pane-header">
          <div className="pane-title">
            {sessionId ? <StatusMark state={state} /> : null}
            <span className="pane-name">{props.title}</span>
            {props.subtitle && <span className="meta">{props.subtitle}</span>}
          </div>
        </header>
      )}

      <div className="chat-scroll" ref={scroller} data-scroll="y">
        {items.length === 0 ? (
          <div className="chat-welcome">
            {props.welcome.overline && <div className="welcome-overline">{props.welcome.overline}</div>}
            <h1>{props.welcome.heading}</h1>
            <p>{props.welcome.body}</p>
            <div className="suggestions">
              {props.welcome.suggestions.map((s) => (
                <button key={s} type="button" onClick={() => void send(s)} disabled={busySending}>
                  <span>{s}</span>
                  <ChevronRight size={14} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="messages">
            {items.map((it) =>
              it.type === "user" ? (
                <div key={it.seq} className="message user">
                  <div className="message-meta">
                    <strong>You</strong>
                  </div>
                  <div className="message-body">{it.text}</div>
                </div>
              ) : it.type === "agent" ? (
                <div key={it.seq} className="message assistant">
                  <div className="message-meta">
                    <ThermalMark size={16} variant="blob" animated={false} />
                    <strong>{props.kind === "task" ? "Agent" : "jin"}</strong>
                  </div>
                  <Markdown content={it.text} />
                </div>
              ) : it.type === "tool" ? (
                <ToolRow key={it.seq} t={it} />
              ) : (
                <div key={it.seq} className={`chat-note is-${it.tone}`}>
                  {it.text}
                </div>
              ),
            )}
            {streaming && (
              <div className="message assistant is-streaming" aria-live="polite">
                <div className="message-meta">
                  <ThermalMark size={16} variant="blob" state="working" />
                  <strong>{props.kind === "task" ? "Agent" : "jin"}</strong>
                </div>
                <Markdown content={streaming} streaming />
              </div>
            )}
            {working && !streaming && (
              <div className="working-row" role="status">
                <ThermalMark size={18} state={state === "waiting_approval" ? "waiting" : "working"} />
                <span>{state === "waiting_approval" ? "Waiting for your approval" : "Working…"}</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="composer-area">
        <Approvals approvals={props.approvals} drawer />
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={props.placeholder}
            rows={1}
            aria-label="Message"
          />
          <div className="composer-bottom">
            <span className="composer-engine">{error ? <span className="composer-error">{error}</span> : props.kind === "task" ? "Coding agent · commands checked by jin" : "Claude · outward actions need your approval"}</span>
            {working && sessionId ? (
              <button type="button" className="send-button stop" aria-label="Stop" onClick={() => void stopSession(sessionId)}>
                <Square size={12} />
              </button>
            ) : (
              <button type="submit" className="send-button" aria-label="Send" disabled={!draft.trim() || busySending}>
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}
