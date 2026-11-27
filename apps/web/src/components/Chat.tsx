"use client";
import { fromSession } from "@/lib/agent-state";
import { ArrowUp, ChevronRight, Square } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createChat, sendMessage, startTaskSession, stopSession, streamTicket } from "@/lib/actions";
import type { Approval, ChatKind, RunChoice, Session, SessionEvent, SessionKind } from "@/lib/daemon";
import { useMentionPicker } from "./Mentions";
import { useSkillPicker } from "./SkillPicker";
import { useModelChoice } from "./ModelPicker";
import { Approvals } from "./Approvals";
import { CHAT_EVENT } from "./ChatRefs";
import { COMPOSE_EVENT } from "@/lib/desk-events";
import { ChatTabs } from "./ChatTabs";
import { StatusMark } from "./ThermalMark";
import { stateFrom, toItems, toTurns, TurnView } from "./Transcript";

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
  welcome: { overline?: string; heading: string; body: string; suggestions: string[]; /** Shown when the desk cannot reach its service (text, or content that streams in later). */ notice?: React.ReactNode };
  placeholder: string;
  /** Every open chat of this kind, shown as tabs in the top bar (jin's chat and the desks). */
  chats?: Session[];
  /** Starts the chat with its first message, when it is not an ordinary chat of its kind (a doc's chat). */
  start?: (prompt: string, choice: RunChoice) => Promise<{ id: string }>;
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
  // The message just sent, shown at once until the home records it (a round trip away).
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const lastSeq = useRef(props.initialEvents.at(-1)?.seq ?? 0);

  const shown = useMemo(() => (sent === null ? events : [...events, { seq: Number.MAX_SAFE_INTEGER, kind: "prompt", payload: { text: sent }, at: new Date().toISOString() }]), [events, sent]);
  const state = stateFrom(shown, props.session?.state ?? "idle");
  const items = useMemo(() => toItems(shown), [shown]);
  const turns = useMemo(() => toTurns(items), [items]);
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
          // The message sent is recorded: it shows from the log now.
          if (e.kind === "prompt") setSent(null);
          // The recorded message (or the end of the turn) replaces the live text.
          if (e.kind === "message" || e.kind === "session.idle" || e.kind === "session.failed" || e.kind === "tool.requested") setStreaming("");
          setEvents((prev) => [...prev, e]);
          // jin's right pane reads what the chat mentioned again.
          if (e.kind === "message" || e.kind === "prompt.mentions" || e.kind === "session.idle") window.dispatchEvent(new CustomEvent(CHAT_EVENT, { detail: { sessionId } }));
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

  // The model and effort the next message runs with.
  const picker = useModelChoice(props.session);
  const { choice } = picker;

  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || busySending) return;
      setBusySending(true);
      setError(null);
      // Shown and out of the box at once; back in the box if it could not be sent.
      setSent(prompt);
      setDraft("");
      try {
        if (!sessionId) {
          const s = props.start ? await props.start(prompt, choice) : props.taskId ? await startTaskSession(props.taskId, prompt, choice) : await createChat(props.kind as ChatKind, prompt, choice);
          lastSeq.current = 0;
          setEvents([]);
          setSessionId(s.id);
          // The new chat becomes a tab of its own.
          if (props.chats) router.replace(`${path}?chat=${encodeURIComponent(s.id)}`);
        } else {
          await sendMessage(sessionId, prompt, choice);
        }
      } catch (err) {
        setSent(null);
        setDraft((d) => d || prompt);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusySending(false);
      }
    },
    [busySending, sessionId, props.taskId, props.kind, props.chats, path, router, choice],
  );

  // Typing @… offers what to mention (PRs, issues, jin tasks).
  const input = useRef<HTMLTextAreaElement>(null);

  // The desk's Activity asks its agent about a thread: sent now, or left in the box while it works.
  const latestSend = useRef({ send, busy: false });
  latestSend.current = { send, busy: busySending || working };
  useEffect(() => {
    if (props.kind !== "desk") return;
    const onCompose = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text;
      if (!text) return;
      if (latestSend.current.busy) {
        setDraft(text);
        input.current?.focus();
      } else void latestSend.current.send(text);
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, [props.kind]);
  const mention = useMentionPicker(draft, setDraft, input);
  const skill = useSkillPicker(props.kind, draft, setDraft, input);

  // The box grows with what is written, up to its max height, then scrolls.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.onKey(e) || skill.onKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };

  return (
    <section className="chat-panel" aria-label={props.title}>
      {/* jin's own chats are listed in the sidebar; a desk keeps its chats as tabs here. */}
      {props.chats && props.kind !== "task" && props.kind !== "jin" ? (
        <header className="pane-header has-tabs">
          <ChatTabs kind={props.kind as ChatKind} chats={props.chats} activeId={sessionId} activeState={state} />
        </header>
      ) : (
        <header className="pane-header">
          <div className="pane-title">
            {sessionId ? <StatusMark state={fromSession(state)} /> : null}
            {props.kind === "jin" && props.chats ? (
              // jin's chats are listed in the sidebar: the header names the open one.
              <span className="pane-name">{props.chats.find((c) => c.id === sessionId)?.title?.trim() || "New chat"}</span>
            ) : (
              <>
                <span className="pane-name">{props.title}</span>
                {props.subtitle && <span className="meta">{props.subtitle}</span>}
              </>
            )}
          </div>
        </header>
      )}

      <div className="chat-scroll" ref={scroller} data-scroll="y">
        {items.length === 0 ? (
          <div className="chat-welcome">
            {props.welcome.overline && <div className="welcome-overline">{props.welcome.overline}</div>}
            <h1>{props.welcome.heading}</h1>
            <p>{props.welcome.body}</p>
            {typeof props.welcome.notice === "string" ? <p className="welcome-notice">{props.welcome.notice}</p> : props.welcome.notice}
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
            {turns.map((t, i) => {
              const last = i === turns.length - 1;
              return <TurnView key={t.user?.seq ?? `t${i}`} turn={t} live={last && working && !t.endedAt} streaming={last ? streaming : ""} waiting={state === "waiting_approval"} />;
            })}
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
          {mention.picker}
          {skill.picker}
          <textarea
            ref={input}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              mention.update(e.target.value, e.target.selectionStart ?? e.target.value.length);
              skill.update(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={onKey}
            onBlur={() => setTimeout(() => (mention.close(), skill.close()), 120)}
            placeholder={props.placeholder}
            rows={1}
            aria-label="Message"
          />
          <div className="composer-bottom">
            {error ? <span className="composer-engine composer-error">{error}</span> : picker.buttons}
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
