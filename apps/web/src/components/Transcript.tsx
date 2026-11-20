"use client";
import { ChevronRight, FilePen, Search, ShieldAlert, SquareTerminal, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatSkill, Mention, SessionEvent, SessionState } from "@/lib/daemon";
import { WithMentions } from "./Mentions";
import { Markdown } from "./Markdown";
import { ThermalMark } from "./ThermalMark";

/**
 * What an agent did, from its session's events: turns (the prompt, the work in between folded
 * under "Worked for …", the answer). One view for every headless agent: jin's chat, the desk, a
 * doc's chat, and a room agent's own steps.
 */

type Item =
  | { type: "user"; seq: number; text: string; at: string; mentions?: Mention[]; skills?: ChatSkill[] }
  | { type: "agent"; seq: number; text: string }
  | { type: "tool"; seq: number; tool: string; input: Record<string, any>; status: "running" | "done" | "denied" | "waiting"; reason?: string }
  | { type: "note"; seq: number; tone: "error" | "meta"; text: string }
  | { type: "end"; seq: number; at: string };

/** Turn the event log into chat items: messages, one row per tool call, and notes. */
export function toItems(events: SessionEvent[]): Item[] {
  const items: Item[] = [];
  const openTools: Extract<Item, { type: "tool" }>[] = [];
  const key = (tool: string, input: unknown) => `${tool}:${JSON.stringify(input)}`;
  for (const e of events) {
    const p = e.payload;
    switch (e.kind) {
      case "prompt":
        items.push({ type: "user", seq: e.seq, text: p.text, at: e.at });
        break;
      case "prompt.mentions": {
        // jin resolved the message's @mentions: they show as chips on it.
        const u = items.findLast((x) => x.type === "user");
        if (u && u.type === "user") u.mentions = p.mentions;
        break;
      }
      case "prompt.skills": {
        // The /skills the message named: chips too.
        const u = items.findLast((x) => x.type === "user");
        if (u && u.type === "user") u.skills = p.skills;
        break;
      }
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

export function stateFrom(events: SessionEvent[], initial: SessionState): SessionState {
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
export interface Turn {
  user: Extract<Item, { type: "user" }> | null;
  steps: Step[];
  answer: Extract<Item, { type: "agent" }> | null;
  error: Extract<Item, { type: "note" }> | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** Group items into turns. A finished turn's last message is its answer; the rest is its work. */
export function toTurns(items: Item[]): Turn[] {
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
export function TurnView({ turn, live, streaming, waiting, foldPrompt = false }: { turn: Turn; live: boolean; streaming: string; waiting: boolean; /** The prompt is generated (a room agent's turn is handed the room): folded to one line. */ foldPrompt?: boolean }) {
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
      {turn.user &&
        (foldPrompt ? (
          <details className="turn-prompt">
            <summary>What it was given{turn.startedAt ? ` at ${new Date(turn.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</summary>
            <pre>{turn.user.text}</pre>
          </details>
        ) : (
          <div className="message user">
            <WithMentions text={turn.user.text} mentions={turn.user.mentions} skills={turn.user.skills} />
          </div>
        ))}
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


/** A whole transcript, read-only: every turn of a session's events. */
export function Transcript({ events, state = "idle", foldPrompts = false, empty }: { events: SessionEvent[]; state?: SessionState; foldPrompts?: boolean; empty?: string }) {
  const turns = toTurns(toItems(events));
  const working = stateFrom(events, state) === "running" || stateFrom(events, state) === "waiting_approval";
  if (!turns.length) return empty ? <p className="meta transcript-empty">{empty}</p> : null;
  return (
    <div className="transcript">
      {turns.map((t, i) => (
        <TurnView key={t.user?.seq ?? `t${i}`} turn={t} live={i === turns.length - 1 && working && !t.endedAt} streaming="" waiting={stateFrom(events, state) === "waiting_approval"} foldPrompt={foldPrompts} />
      ))}
    </div>
  );
}
