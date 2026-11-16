"use client";
import { ArrowUp, ChevronRight, FilePen, Search, ShieldAlert, Square, SquareTerminal, Wrench } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createChat, sendMessage, startTaskSession, stopSession, streamTicket } from "@/app/actions";
import type { Approval, ChatKind, Session, SessionEvent, SessionKind, SessionState } from "@/lib/daemon";
import { Approvals } from "./Approvals";
import { ChatTabs } from "./ChatTabs";
import { Markdown } from "./Markdown";
import { StatusMark, ThermalMark } from "./ThermalMark";

type Item =
  | { type: "user"; seq: number; text: string; at: string }
  | { type: "agent"; seq: number; text: string }
  | { type: "tool"; seq: number; tool: string; input: Record<string, any>; status: "running" | "done" | "denied" | "waiting"; reason?: string }
  | { type: "note"; seq: number; tone: "error" | "meta"; text: string }
  | { type: "end"; seq: number; at: string };

/** Turn the event log into chat items: messages, one row per tool call, and notes. */
function toItems(events: SessionEvent[]): Item[] {
  const items: Item[] = [];
  const openTools: Extract<Item, { type: "tool" }>[] = [];
  const key = (tool: string, input: unknown) => `${tool}:${JSON.stringify(input)}`;
  for (const e of events) {
    const p = e.payload;
    switch (e.kind) {
      case "prompt":
        items.push({ type: "user", seq: e.seq, text: p.text, at: e.at });
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
        items.push({ type: "end", seq: e.seq + 0.5, at: e.at });
        break;
      case "session.idle":
        items.push({ type: "end", seq: e.seq, at: e.at });
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

type Tool = Extract<Item, { type: "tool" }>;
type Step = Extract<Item, { type: "agent" }> | Extract<Item, { type: "note" }> | { type: "tools"; seq: number; tools: Tool[] };

/** One exchange: the prompt, the work in between, and the answer it ended with. */
interface Turn {
  user: Extract<Item, { type: "user" }> | null;
  steps: Step[];
  answer: Extract<Item, { type: "agent" }> | null;
  error: Extract<Item, { type: "note" }> | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** Group items into turns. A finished turn's last message is its answer; the rest is its work. */
function toTurns(items: Item[]): Turn[] {
  const turns: Turn[] = [];
  let turn: Turn | null = null;
  const open = () => (turn ??= (turns.push({ user: null, steps: [], answer: null, error: null, startedAt: null, endedAt: null }), turns.at(-1)!));
  for (const it of items) {
    if (it.type === "user") {
      turn = { user: it, steps: [], answer: null, error: null, startedAt: it.at, endedAt: null };
      turns.push(turn);
      continue;
    }
    const t = open();
    if (it.type === "end") {
      t.endedAt = it.at;
      // The answer is the closing message; an error is shown outside the fold.
      const last = t.steps.at(-1);
      if (last?.type === "note" && last.tone === "error") t.error = t.steps.pop() as Turn["error"];
      const final = t.steps.at(-1);
      if (final?.type === "agent") t.answer = t.steps.pop() as Turn["answer"];
      turn = null;
    } else if (it.type === "tool") {
      const last = t.steps.at(-1);
      if (last?.type === "tools") last.tools.push(it);
      else t.steps.push({ type: "tools", seq: it.seq, tools: [it] });
    } else {
      t.steps.push(it);
    }
  }
  return turns;
}

const READS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"]);
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function groupLabel(tools: Tool[]): string {
  const n = tools.length;
  if (tools.every((t) => t.tool === "Bash")) return `Ran ${plural(n, "command")}`;
  if (tools.every((t) => READS.has(t.tool))) return `Explored ${plural(n, "item")}`;
  if (tools.every((t) => EDITS.has(t.tool))) return `Edited ${plural(n, "file")}`;
  if (tools.every((t) => t.tool.startsWith("mcp__jin__"))) return `Used jin ${plural(n, "time")}`;
  return `Used ${plural(n, "tool")}`;
}

function toolLine(t: Tool): string {
  if (typeof t.input.command === "string") return t.input.command;
  if (typeof t.input.file_path === "string") return `${t.tool} ${t.input.file_path}`;
  if (typeof t.input.pattern === "string") return `${t.tool} ${t.input.pattern}`;
  return t.tool.replace(/^mcp__/, "").replace(/__/g, " · ");
}

function ToolIcon({ t }: { t: Tool }) {
  if (t.status === "denied") return <ShieldAlert size={13} />;
  if (t.status === "running" || t.status === "waiting") return <ThermalMark size={13} state={t.status === "waiting" ? "waiting" : "working"} variant="command" />;
  return t.tool === "Bash" ? <SquareTerminal size={13} /> : EDITS.has(t.tool) ? <FilePen size={13} /> : READS.has(t.tool) ? <Search size={13} /> : <Wrench size={13} />;
}

/**
 * A run of tool calls as one quiet line ("Ran 3 commands"), expandable to the calls.
 * Denied and waiting calls always show: they are the ones that need you.
 */
function ToolGroup({ tools }: { tools: Tool[] }) {
  const [open, setOpen] = useState(false);
  const loud = tools.filter((t) => t.status === "denied" || t.status === "waiting");
  const quiet = tools.filter((t) => t.status === "done" || t.status === "running");
  const live = quiet.some((t) => t.status === "running");
  return (
    <div className="tool-group">
      {quiet.length > 0 && (
        <button type="button" className={`step-line ${live ? "is-live" : ""}`} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {live ? <ThermalMark size={13} state="working" variant="command" /> : <ToolIcon t={quiet[0]!} />}
          <span className="step-label">{live ? toolLine(quiet.findLast((t) => t.status === "running")!) : groupLabel(quiet)}</span>
          <ChevronRight size={12} className={`step-chevron ${open ? "is-open" : ""}`} />
        </button>
      )}
      {open && (
        <div className="tool-calls">
          {quiet.map((t) => (
            <div key={t.seq} className="tool-call">
              <ToolIcon t={t} />
              <code>{toolLine(t)}</code>
            </div>
          ))}
        </div>
      )}
      {loud.map((t) => (
        <div key={t.seq} className={`step-line is-${t.status}`} title={toolLine(t)}>
          <ToolIcon t={t} />
          <span className="step-label">
            {t.status === "denied" ? `Declined by jin: ${toolLine(t)}` : `Waiting for your approval: ${toolLine(t)}`}
            {t.status === "denied" && t.reason ? ` — ${t.reason}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

const duration = (from: string, to: string | number) => {
  const s = Math.max(0, Math.round(((typeof to === "number" ? to : Date.parse(to)) - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** A turn: the prompt, its work folded under "Worked for …" once done, and the answer. */
function TurnView({ turn, live, streaming, waiting }: { turn: Turn; live: boolean; streaming: string; waiting: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  const expanded = open ?? live; // working turns show their steps; finished ones fold them
  const hasWork = turn.steps.length > 0 || live;
  const needsYou = turn.steps.some((s) => s.type === "tools" && s.tools.some((t) => t.status === "waiting" || t.status === "denied"));
  return (
    <div className="turn">
      {turn.user && <div className="message user">{turn.user.text}</div>}
      {hasWork && (
        <button type="button" className="work-toggle" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
          {live && <ThermalMark size={14} state={waiting ? "waiting" : "working"} />}
          <span>
            {live ? (waiting ? "Waiting for your approval" : "Working") : "Worked"}
            {turn.startedAt ? ` for ${duration(turn.startedAt, turn.endedAt ?? now)}` : ""}
          </span>
          {needsYou && !expanded && <ShieldAlert size={12} className="work-flag" />}
          <ChevronRight size={13} className={`step-chevron ${expanded ? "is-open" : ""}`} />
        </button>
      )}
      {expanded && turn.steps.length > 0 && (
        <div className="work">
          {turn.steps.map((st) =>
            st.type === "tools" ? (
              <ToolGroup key={st.seq} tools={st.tools} />
            ) : st.type === "agent" ? (
              <div key={st.seq} className="step-text">
                <Markdown content={st.text} />
              </div>
            ) : (
              <div key={st.seq} className={`chat-note is-${st.tone}`}>
                {st.text}
              </div>
            ),
          )}
        </div>
      )}
      {live && streaming && (
        <div className="message assistant is-streaming" aria-live="polite">
          <Markdown content={streaming} streaming />
        </div>
      )}
      {turn.answer && (
        <div className="message assistant">
          <Markdown content={turn.answer.text} />
        </div>
      )}
      {turn.error && <div className="chat-note is-error">{turn.error.text}</div>}
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
  welcome: { overline?: string; heading: string; body: string; suggestions: string[]; /** Shown when the desk cannot reach its service. */ notice?: string };
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
            {props.welcome.notice && <p className="welcome-notice">{props.welcome.notice}</p>}
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
