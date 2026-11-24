"use client";
import { ArrowUp, AtSign, Check, Copy, Eye, FileCode, FileText, GitCompare, GitPullRequest, ListChecks, MoreHorizontal, Pencil, Pin, PinOff, Plus, RotateCcw, Square, SquareKanban, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { decideRoomApproval, getRoom, modelChoices, pinRoomMessage, postRoomMessage, roomAgentAction, roomAgentEvents, roomTagOptions, saveRoomAgent, type RoomTag } from "@/lib/actions";
import type { ModelChoices, RoomAgent, RoomApproval, RoomMessage, RoomProfile, SessionEvent } from "@/lib/daemon";
import { openContextMenu, type MenuItem } from "../ContextMenu";
import { Markdown } from "../Markdown";
import { ActionMark } from "../ThermalMark";
import { Transcript } from "../Transcript";
import { AGENT_LABEL, fromRoom } from "@/lib/agent-state";
import { AgentGlob, globState } from "@/components/AgentGlob";

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const busy = (a: RoomAgent) => a.state === "running" || a.state === "waiting_approval" || a.state === "queued";

/** The agents a message names, in order (as the daemon reads it): @all is everyone. */
function named(text: string, agents: RoomAgent[]): RoomAgent[] {
  const out: RoomAgent[] = [];
  for (const m of text.matchAll(/(^|[^\w@/.])@([a-z][\w-]*)/gi)) {
    const h = m[2]!.toLowerCase();
    for (const a of h === "all" || h === "everyone" ? agents : agents.filter((x) => x.handle === h)) if (!out.includes(a)) out.push(a);
  }
  return out;
}

const STATE = (s: RoomAgent["state"]) => AGENT_LABEL[fromRoom(s)];

type Side = { view: "roster" } | { view: "edit"; id: string | null } | { view: "activity"; id: string };

/**
 * A task's agent room: you and several agents, each with a role. An agent takes a turn only when
 * you @-mention it; it is given the room since its last turn, and of the others only what they
 * said last (their steps stay in their own sessions: the eye shows you them).
 */
export function RoomPanel({ taskId, intent, onOpenDoc, onOpenChanges, onOpenFile, onSeen }: { /** Open a file of the task (as a tab). */ onOpenFile?: (path: string) => void; /** Show the task's diff (what a writer's turn changed). */ onOpenChanges?: () => void; taskId: string; /** Asked from the Room tab's menu: open the new-agent form (n changes each time). */ intent?: { n: number; action: "add-agent" } | null; /** Open a jin doc (as a tab of the task). */ onOpenDoc?: (id: string) => void; /** The last message shown (the tab's unread mark follows it). */ onSeen?: (seq: number) => void }) {
  const [agents, setAgents] = useState<RoomAgent[]>([]);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [pinned, setPinned] = useState<RoomMessage[]>([]);
  const [approvals, setApprovals] = useState<RoomApproval[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<Side>({ view: "roster" });
  const last = useRef(0);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const refresh = useCallback(async () => {
    const r = await getRoom(taskId, last.current);
    if ("error" in r) return setError(r.error);
    setError(null);
    setLoaded(true);
    setAgents(r.agents);
    setPinned(r.pinned);
    setApprovals(r.approvals);
    if (r.messages.length) {
      last.current = Math.max(last.current, r.lastSeq);
      setMessages((m) => {
        const have = new Set(m.map((x) => x.seq));
        return [...m, ...r.messages.filter((x) => !have.has(x.seq))].sort((a, b) => a.seq - b.seq);
      });
    }
  }, [taskId]);

  useEffect(() => {
    last.current = 0;
    setMessages([]);
    setLoaded(false);
    void refresh();
    return undefined;
  }, [refresh]);
  // Read again every second and a half while it is on screen; faster while an agent works (its reply forms as you watch).
  const anyWorking = agents.some((a) => a.state === "running");
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && void refresh(), anyWorking ? 600 : 1500);
    return () => clearInterval(t);
  }, [refresh, anyWorking]);

  // New messages keep the log at its end, unless you scrolled up to read.
  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, agents.map((a) => `${a.state}${a.draft?.length ?? 0}`).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (intent?.action === "add-agent") setSide({ view: "edit", id: null });
  }, [intent?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (messages.length) onSeen?.(messages.at(-1)!.seq);
  }, [messages.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Esc closes the profile form or the steps view.
  useEffect(() => {
    if (side.view === "roster") return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && setSide({ view: "roster" });
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [side.view]);
  const [copied, setCopied] = useState<number | null>(null);
  const copyText = (m: RoomMessage) => {
    void navigator.clipboard?.writeText(m.text);
    setCopied(m.seq);
    setTimeout(() => setCopied((c) => (c === m.seq ? null : c)), 1200);
  };

  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const working = agents.filter(busy);
  const pinnedSeqs = useMemo(() => new Set(pinned.map((p) => p.seq)), [pinned]);

  const togglePin = async (m: RoomMessage) => {
    const on = !pinnedSeqs.has(m.seq);
    setPinned((p) => (on ? [...p, m].sort((a, b) => a.seq - b.seq) : p.filter((x) => x.seq !== m.seq)));
    const r = await pinRoomMessage(taskId, m.seq, on);
    if ("error" in r) setError(r.error);
  };

  const act = async (a: RoomAgent, action: "remove" | "stop" | "fresh") => {
    const r = await roomAgentAction(taskId, a.id, action);
    if ("error" in r) setError(r.error);
    void refresh();
  };

  const composer = useRef<{ insert: (handle: string) => void }>(null);
  const agentMenu = (a: RoomAgent): MenuItem[] => [
    { label: `Mention @${a.handle}`, icon: AtSign, run: () => composer.current?.insert(a.handle) },
    { label: "What it did", icon: Eye, hint: "its own steps", run: () => setSide({ view: "activity", id: a.id }) },
    { label: "Edit profile", icon: Pencil, run: () => setSide({ view: "edit", id: a.id }) },
    { divider: true },
    ...(a.state === "running" || a.state === "waiting_approval" ? [{ label: "Stop its turn", icon: Square, run: () => act(a, "stop") }] : []),
    { label: "Fresh start", icon: RotateCcw, hint: "a new session", disabled: busy(a), run: () => act(a, "fresh") },
    { label: "Remove from the room", icon: Trash2, danger: true, confirm: `Remove @${a.handle}? Its messages stay.`, disabled: busy(a), run: () => act(a, "remove") },
  ];

  return (
    <div className={`room ${side.view === "activity" ? "is-wide-side" : ""}`}>
      <div className="room-main">
        <div
          className="room-log"
          data-scroll="y"
          ref={log}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {loaded && !messages.length && (
            <div className="room-empty">
              <p className="room-empty-title">The agent room</p>
              <p>
                Each agent has a role and works in this task. One takes a turn only when you @-mention it, and the others see just its final reply. Name several to hear from each: readers answer at the same time; with a writer they go in the order you name them.
              </p>
              <p className="room-empty-handles">
                {agents.map((a) => (
                  <button key={a.id} type="button" className="room-handle" data-color={a.color} onClick={() => composer.current?.insert(a.handle)} title={a.brief}>
                    @{a.handle}
                  </button>
                ))}
              </p>
            </div>
          )}
          {messages.map((m) =>
            m.kind === "note" ? (
              <p key={m.seq} className="room-note">
                <span>{m.text}</span>
                <Refs refs={m.refs} onOpenDoc={onOpenDoc} onOpenChanges={onOpenChanges} onOpenFile={onOpenFile} />
              </p>
            ) : (
              <article key={m.seq} id={`room-msg-${m.seq}`} className={`room-msg ${m.author === "you" ? "is-you" : ""}`} data-color={byId.get(m.author)?.color ?? (m.author === "you" ? undefined : "gone")}>
                <header className="room-msg-head">
                  {m.author === "you" ? (
                    <AgentGlob id="you" color="you" size={22} animated={false} />
                  ) : (
                    <AgentGlob id={m.author} color={byId.get(m.author)?.color ?? "gone"} size={22} state={byId.get(m.author) ? globState(fromRoom(byId.get(m.author)!.state)) : "idle"} animated={byId.has(m.author)} />
                  )}
                  <span className="room-msg-name">{m.author === "you" ? "You" : m.authorName}</span>
                  {m.authorHandle && <span className="meta">@{m.authorHandle}</span>}
                  <span className="meta">{clock(m.at)}</span>
                  <button type="button" className="room-pin" onClick={() => copyText(m)} title="Copy" aria-label="Copy the message">
                    {copied === m.seq ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                  <button type="button" className={`room-pin ${pinnedSeqs.has(m.seq) ? "is-on" : ""}`} onClick={() => void togglePin(m)} title={pinnedSeqs.has(m.seq) ? "Unpin" : "Pin as a decision"} aria-label={pinnedSeqs.has(m.seq) ? "Unpin" : "Pin"}>
                    {pinnedSeqs.has(m.seq) ? <PinOff size={12} /> : <Pin size={12} />}
                  </button>
                </header>
                <div className="room-msg-body">
                  {m.author === "you" ? <YourText text={m.text} agents={agents} refs={m.refs} /> : <Markdown content={m.text} />}
                  <Refs refs={m.refs} onOpenDoc={onOpenDoc} onOpenChanges={onOpenChanges} onOpenFile={onOpenFile} />
                </div>
              </article>
            ),
          )}
          {working.map((a) => (
            <div key={a.id} className={`room-working ${a.draft ? "has-draft" : ""}`} data-color={a.color}>
              {a.draft && (
                <div className="room-draft" title="What it is writing now. Only its final message goes to the room.">
                  <Markdown content={a.draft} streaming />
                </div>
              )}
              <AgentGlob id={a.id} color={a.color} size={22} state={globState(fromRoom(a.state))} label={`${a.name}: ${STATE(a.state)}`} />
              <span className="room-msg-name">{a.name}</span>
              <span className="meta room-working-what">{a.state === "queued" ? "waiting its turn" : a.state === "waiting_approval" ? "needs your approval" : (a.activity ?? "working")}</span>
              <button type="button" className="button quiet small" onClick={() => setSide({ view: "activity", id: a.id })}>
                <Eye size={12} /> Watch
              </button>
              {a.state !== "queued" && (
                <button type="button" className="button quiet small" onClick={() => void act(a, "stop")}>
                  <Square size={11} /> Stop
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="composer-area">
          {error && <p className="machine-error">{error}</p>}
          {approvals.length > 0 && (
            <section className="approvals approval-drawer" aria-label="Approvals">
              <ul className="approval-list">
                {approvals.map((p) => (
                  <ApprovalRow key={p.id} approval={p} agent={byId.get(p.agentId)} onDecide={async (d) => (await decideRoomApproval(taskId, p.id, d), void refresh())} />
                ))}
              </ul>
            </section>
          )}
          <Composer
            ref={composer}
            taskId={taskId}
            agents={agents}
            onSend={async (text) => {
              const r = await postRoomMessage(taskId, text);
              if ("error" in r) return setError(r.error), false;
              stick.current = true;
              await refresh();
              return true;
            }}
          />
        </div>
      </div>

      <aside className="room-side" aria-label="Agents">
        {side.view === "edit" ? (
          <ProfileForm taskId={taskId} agent={side.id ? (byId.get(side.id) ?? null) : null} onDone={() => (setSide({ view: "roster" }), void refresh())} />
        ) : side.view === "activity" && byId.get(side.id) ? (
          <AgentActivity taskId={taskId} agent={byId.get(side.id)!} onClose={() => setSide({ view: "roster" })} />
        ) : (
          <>
            <div className="room-side-head">
              <span>Agents</span>
              <button type="button" className="nav-section-action" onClick={() => setSide({ view: "edit", id: null })} title="Add an agent" aria-label="Add an agent">
                <Plus size={14} />
              </button>
            </div>
            <ul className="room-roster">
              {agents.map((a) => (
                <li key={a.id} className="room-agent" data-color={a.color} onContextMenu={(e) => openContextMenu(e, agentMenu(a))}>
                  <button type="button" className="room-agent-main" onClick={() => composer.current?.insert(a.handle)} title={`Mention @${a.handle}\n\n${a.brief}`}>
                    <AgentGlob id={a.id} color={a.color} size={30} state={globState(fromRoom(a.state))} />
                    <span className="room-agent-text">
                      <span className="room-agent-name">
                        {a.name} <span className="meta">@{a.handle}</span>
                      </span>
                      <span className={`meta room-agent-state is-${fromRoom(a.state)}`}>
                        {a.access === "writer" ? "writes code" : "read-only"} · {STATE(a.state)}
                        {a.queued > 0 && a.state !== "queued" ? ` · ${a.queued} queued` : ""}
                      </span>
                    </span>
                  </button>
                  <button type="button" className="button quiet icon-only room-agent-more" onClick={(e) => openContextMenu(e, agentMenu(a))} aria-label={`${a.name}: more`} title="More">
                    <MoreHorizontal size={14} />
                  </button>
                </li>
              ))}
            </ul>
            {pinned.length > 0 && (
              <>
                <div className="room-side-head">
                  <span>Pinned</span>
                </div>
                <ul className="room-pins">
                  {pinned.map((m) => (
                    <li key={m.seq}>
                      <button type="button" onClick={() => document.getElementById(`room-msg-${m.seq}`)?.scrollIntoView({ block: "center", behavior: "smooth" })} title={m.text}>
                        <span className="meta">{m.author === "you" ? "You" : m.authorName}</span>
                        <span className="room-pin-text">{m.text}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

/** What a turn made or changed: its docs, one chip each (opens the doc). */
const TAG_ICON = { pr: GitPullRequest, issue: SquareKanban, task: ListChecks, doc: FileText, file: FileCode } as const;

function Refs({ refs, onOpenDoc, onOpenChanges, onOpenFile }: { refs: RoomMessage["refs"]; onOpenDoc?: (id: string) => void; onOpenChanges?: () => void; onOpenFile?: (path: string) => void }) {
  if (!refs?.length) return null;
  return (
    <span className="room-refs">
      {refs.map((r) =>
        r.kind === "file" ? (
          <button key={`file:${r.path}`} type="button" className="room-ref" onClick={() => onOpenFile?.(r.path)} title={`${r.path}\n\nOpens the file.`}>
            <FileCode size={12} />
            <span className="room-ref-title">{r.path.split("/").pop()}</span>
            <span className="meta">{r.path.split("/").slice(0, -1).join("/") || "file"}</span>
          </button>
        ) : r.kind === "mention" ? (
          (() => {
            const Icon = TAG_ICON[r.what];
            const body = (
              <>
                <Icon size={12} />
                <span className="room-ref-title">{r.title ?? r.label}</span>
                <span className="meta">{[r.label, r.state].filter(Boolean).join(" · ")}</span>
              </>
            );
            return r.url ? (
              <a key={`m:${r.label}`} href={r.url} className="room-ref" target={r.url.startsWith("/") ? undefined : "_blank"} rel="noreferrer" title={`${r.title ?? r.label} (${r.label})`}>
                {body}
              </a>
            ) : (
              <span key={`m:${r.label}`} className="room-ref">
                {body}
              </span>
            );
          })()
        ) : r.kind === "files" ? (
          <button key={`files:${r.repo}`} type="button" className="room-ref" onClick={onOpenChanges} title={`Changed in this turn:\n${r.files.join("\n")}${r.count > r.files.length ? `\n… and ${r.count - r.files.length} more` : ""}\n\nOpens the task's changes.`}>
            <GitCompare size={12} />
            <span className="room-ref-title">{r.repo}</span>
            <span className="meta">
              {r.count} file{r.count === 1 ? "" : "s"} changed
            </span>
          </button>
        ) : (
        <a
          key={r.id}
          href={`/docs/${r.id}`}
          className="room-ref"
          title={`${r.title || "Untitled"}: ${r.did.join(", ")}`}
          onClick={(e) => {
            if (!onOpenDoc || e.metaKey || e.ctrlKey) return;
            e.preventDefault();
            onOpenDoc(r.id);
          }}
        >
          <FileText size={12} />
          <span className="room-ref-title">{r.title || "Untitled"}</span>
          <span className="meta">{r.did.join(", ")}</span>
        </a>
        ),
      )}
    </span>
  );
}

/** What you wrote: the agents you named marked, and what you tagged (a doc by its title). */
function YourText({ text, agents, refs }: { text: string; agents: RoomAgent[]; refs?: RoomMessage["refs"] }) {
  const parts = text.split(/(@[^\s),;!?]+?(?=[),.;:!?]*(?:\s|$)))/g);
  return (
    <p className="room-you-text">
      {parts.map((p, i) => {
        if (!p.startsWith("@")) return p;
        const h = p.slice(1).toLowerCase();
        const a = agents.find((x) => x.handle === h);
        if (a || h === "all")
          return (
            <span key={i} className="room-handle" data-color={a?.color}>
              {p}
            </span>
          );
        if (h.startsWith("doc:")) {
          const doc = refs?.find((r) => r.kind === "doc" && r.id === p.slice(5));
          return (
            <span key={i} className="room-tag" title={p}>
              <FileText size={11} />
              {doc && doc.kind === "doc" ? doc.title || "Untitled" : p.slice(5)}
            </span>
          );
        }
        if (h.startsWith("file:"))
          return (
            <span key={i} className="room-tag mono" title={p.slice(6)}>
              <FileCode size={11} />
              {p.slice(6)}
            </span>
          );
        if (refs?.some((r) => r.kind === "mention" && r.label.toLowerCase() === h))
          return (
            <span key={i} className="room-tag">
              {p.slice(1)}
            </span>
          );
        return p;
      })}
    </p>
  );
}

function ApprovalRow({ approval, agent, onDecide }: { approval: RoomApproval; agent?: RoomAgent; onDecide: (d: "approve" | "reject") => Promise<void> }) {
  const [busyNow, setBusy] = useState(false);
  const input = approval.action.input;
  const what = typeof input.command === "string" ? input.command : `${approval.action.tool} ${JSON.stringify(input)}`;
  const decide = (d: "approve" | "reject") => {
    setBusy(true);
    void onDecide(d).finally(() => setBusy(false));
  };
  return (
    <li className="approval-row">
      <ActionMark tool={approval.action.tool} />
      <div className="approval-body">
        <div className="approval-title">
          {agent ? `${agent.name}: ` : ""}
          {approval.reason}
        </div>
        <code className="approval-command">{what}</code>
      </div>
      <div className="approval-actions">
        <button type="button" className="button quiet" disabled={busyNow} onClick={() => decide("reject")}>
          Decline
        </button>
        <button type="button" className="button primary" disabled={busyNow} onClick={() => decide("approve")}>
          Approve
        </button>
      </div>
    </li>
  );
}

/** The room's composer: @ offers the agents; under it, who will take a turn and how. */
type Pick = { key: string; insert: string; kind: "agent" | RoomTag["kind"]; label: string; hint: string | null; id?: string | null; color?: string };

function Composer({ taskId, agents, onSend, ref }: { taskId: string; agents: RoomAgent[]; onSend: (text: string) => Promise<boolean>; ref: React.Ref<{ insert: (handle: string) => void }> }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pick, setPick] = useState<{ start: number; q: string; at: number } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Where the caret goes once the new draft is in the field (-1: its end).
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = input.current;
    if (caret.current === null || !el) return;
    const at = caret.current < 0 ? el.value.length : caret.current;
    caret.current = null;
    el.focus();
    el.setSelectionRange(at, at);
  }, [draft]);

  const draftNow = useRef(draft);
  draftNow.current = draft;
  const insert = useCallback((handle: string) => {
    const d = draftNow.current;
    setPick(null);
    input.current?.focus();
    // Already named: nothing to add.
    if (new RegExp(`(^|\\s)@${handle}\\b`, "i").test(d)) return;
    caret.current = -1;
    setDraft(`${d}${d && !/\s$/.test(d) ? " " : ""}@${handle} `);
  }, []);
  useImperativeHandle(ref, () => ({ insert }), [insert]);

  // Besides the agents: the task's PRs, issues and tasks, docs and files, as the daemon finds them for what is typed.
  const [tags, setTags] = useState<{ q: string; list: RoomTag[] }>({ q: "", list: [] });
  const q = pick?.q ?? null;
  useEffect(() => {
    if (q === null) return;
    let live = true;
    const t = setTimeout(() => void roomTagOptions(taskId, q).then((list) => live && setTags({ q, list })).catch(() => {}), 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, taskId]);

  const options = useMemo((): Pick[] => {
    if (!pick) return [];
    const who: Pick[] = [...agents.map((a) => ({ key: `a:${a.id}`, insert: a.handle, kind: "agent" as const, id: a.id as string | null, label: a.name, hint: a.access === "writer" ? "writes code" : "read-only", color: a.color as string | undefined })), { key: "a:all", insert: "all", kind: "agent", id: null, label: "Everyone", hint: "every agent" }];
    const agentsNow = who.filter((o) => o.insert.startsWith(pick.q.toLowerCase()));
    const tagsNow = tags.q === pick.q ? tags.list.map((t): Pick => ({ key: `${t.kind}:${t.insert}`, insert: t.insert, kind: t.kind, label: t.label, hint: t.hint })) : [];
    return [...agentsNow, ...tagsNow].slice(0, 14);
  }, [pick, agents, tags]);

  const update = (value: string, caret: number) => {
    setDraft(value);
    const m = /(^|\s)@([\w./#:-]*)$/.exec(value.slice(0, caret));
    setPick(m ? { start: caret - m[2]!.length - 1, q: m[2]!, at: 0 } : null);
  };
  const choose = (handle: string) => {
    if (!pick) return;
    const el = input.current;
    const from = el?.selectionStart ?? draft.length;
    caret.current = pick.start + handle.length + 2;
    setDraft(`${draft.slice(0, pick.start)}@${handle} ${draft.slice(from)}`);
    setPick(null);
  };
  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    const ok = await onSend(text);
    setSending(false);
    if (ok) setDraft("");
  };

  const going = named(draft, agents);
  const inOrder = going.some((a) => a.access === "writer") && going.length > 1;
  const plan = !draft.trim()
    ? "@ an agent to give it a turn · @ a PR, issue, doc or file to hand it over"
    : !going.length
      ? "Nobody is mentioned: it is said to the room, and no agent runs"
      : going.length === 1
        ? `${going[0]!.name} takes a turn${busy(going[0]!) ? " (after the one it is on)" : ""}`
        : inOrder
          ? `In order: ${going.map((a) => a.name).join(" → ")}`
          : `At the same time: ${going.map((a) => a.name).join(", ")}`;

  return (
    <form
      className="composer room-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {pick && options.length > 0 && (
        <ul className="room-pick" role="listbox" aria-label="Agents and what to tag">
          {options.map((o, i) => {
            const Icon = o.kind === "agent" ? null : TAG_ICON[o.kind];
            return (
              <li key={o.key} role="option" aria-selected={i === pick.at}>
                <button type="button" className={i === pick.at ? "is-active" : ""} onMouseDown={(e) => (e.preventDefault(), choose(o.insert))} data-color={o.color}>
                  {Icon ? <Icon size={14} className="room-pick-icon" /> : o.id ? <AgentGlob id={o.id} color={o.color} size={16} /> : <span className="room-dot" aria-hidden="true" />}
                  <span className={o.kind === "agent" ? undefined : "room-pick-label"}>{o.kind === "agent" ? `@${o.insert}` : o.label}</span>
                  <span className="meta">{o.kind === "agent" ? `${o.label} · ${o.hint}` : o.hint}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <textarea
        ref={input}
        value={draft}
        rows={1}
        aria-label="Message the room"
        placeholder="Message the room… @ an agent; @ a PR, doc or file to tag it"
        onChange={(e) => update(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onBlur={() => setTimeout(() => setPick(null), 120)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (pick && options.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              return setPick({ ...pick, at: (pick.at + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length });
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              return choose(options[Math.min(pick.at, options.length - 1)]!.insert);
            }
            if (e.key === "Escape") return setPick(null);
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="composer-bottom">
        <span className="composer-engine">{plan}</span>
        <button type="submit" className="send-button" aria-label="Send" disabled={!draft.trim() || sending}>
          <ArrowUp size={16} />
        </button>
      </div>
    </form>
  );
}

/** An agent's profile: its handle, role, whether it changes the code, and what it runs with. */
function ProfileForm({ taskId, agent, onDone }: { taskId: string; agent: RoomAgent | null; onDone: () => void }) {
  const [p, setP] = useState<RoomProfile>({
    handle: agent?.handle ?? "",
    name: agent?.name ?? "",
    brief: agent?.brief ?? "",
    access: agent?.access ?? "read-only",
    model: agent?.model ?? "",
    effort: agent?.effort ?? "default",
  });
  const [choices, setChoices] = useState<ModelChoices | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void modelChoices().then(setChoices, () => {});
  }, []);
  const set = <K extends keyof RoomProfile>(k: K, v: RoomProfile[K]) => setP((x) => ({ ...x, [k]: v }));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const r = await saveRoomAgent(taskId, agent?.id ?? null, { ...p, name: p.name.trim() || p.handle });
    setSaving(false);
    if ("error" in r) return setError(r.error);
    onDone();
  };
  return (
    <form className="room-profile" onSubmit={save}>
      <div className="room-side-head">
        <span>{agent ? `Edit ${agent.name}` : "New agent"}</span>
        <button type="button" className="nav-section-action" onClick={onDone} aria-label="Close" title="Close">
          <X size={14} />
        </button>
      </div>
      <label className="field">
        <span>Handle</span>
        <input value={p.handle} onChange={(e) => set("handle", e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))} placeholder="security" required autoFocus={!agent} />
      </label>
      <label className="field">
        <span>Name</span>
        <input value={p.name} onChange={(e) => set("name", e.target.value)} placeholder="Security reviewer" />
      </label>
      <label className="field">
        <span>Access</span>
        <select value={p.access} onChange={(e) => set("access", e.target.value as RoomProfile["access"])}>
          <option value="read-only">Read-only: reads, runs checks, writes docs</option>
          <option value="writer">Writer: changes the code</option>
        </select>
      </label>
      <label className="field">
        <span>Role</span>
        <textarea value={p.brief} onChange={(e) => set("brief", e.target.value)} rows={9} placeholder="What this agent is for, how it works, what it must not do." required />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Model</span>
          <select value={p.model} onChange={(e) => set("model", e.target.value)}>
            <option value="">jin's default</option>
            {choices?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Effort</span>
          <select value={p.effort} onChange={(e) => set("effort", e.target.value)}>
            <option value="default">default</option>
            {choices?.efforts.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
      </div>
      {agent && <p className="meta">A changed role applies from its next turn.</p>}
      {error && <p className="field-error">{error}</p>}
      <div className="room-profile-actions">
        <button type="button" className="button quiet" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={saving || !p.handle || !p.brief.trim()}>
          {agent ? "Save" : "Add agent"}
        </button>
      </div>
    </form>
  );
}

/** What an agent did, step by step: its own session, which the other agents never see. */
function AgentActivity({ taskId, agent, onClose }: { taskId: string; agent: RoomAgent; onClose: () => void }) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const last = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    last.current = 0;
    setEvents([]);
    let live = true;
    const load = async () => {
      const more = await roomAgentEvents(taskId, agent.id, last.current);
      if (!live || !more.length) return;
      last.current = more.at(-1)!.seq;
      setEvents((e) => [...e, ...more]);
      requestAnimationFrame(() => end.current?.scrollIntoView({ block: "end" }));
    };
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [taskId, agent.id, agent.sessionId]);
  // The same transcript as any chat: its turns, the work folded under "Worked for …", its answers.
  // What it was handed (the room since its last turn) is folded: it is long, and generated.
  return (
    <div className="room-activity">
      <div className="room-side-head">
        <span>
          {agent.name} <span className="meta">its own steps · {STATE(agent.state)}</span>
        </span>
        <button type="button" className="nav-section-action" onClick={onClose} aria-label="Close" title="Close">
          <X size={14} />
        </button>
      </div>
      <div className="room-activity-log" data-scroll="y">
        <Transcript events={events} state={agent.state === "new" || agent.state === "queued" ? "idle" : agent.state} foldPrompts empty="Nothing yet: it has not taken a turn." />
        <div ref={end} />
      </div>
    </div>
  );
}
