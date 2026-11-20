"use client";
import { Archive, Check, Clipboard, Download, FileText, History, MessageSquare, MoreHorizontal, PanelRightClose, PanelRightOpen, RotateCcw, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { archiveDoc, askDoc, commentDoc, decideDocSuggestion, docChat, docVersion, docVersions, getDoc, replyDoc, resolveDocThread, restoreDocVersion, saveDoc } from "@/lib/actions";
import { Chat } from "@/components/Chat";
import { openContextMenu } from "@/components/ContextMenu";
import { Panes } from "@/components/Panes";
import type { Doc, DocAnchor, DocFull, DocSuggestion, DocThread, DocVersion, Session, SessionEvent } from "@/lib/daemon";
import { type Annotation, DocEditor, type DocEditorHandle, displayText } from "./DocEditor";

/**
 * A doc: the editor on the left (title, tags, blocks), and beside it what you and jin say about
 * it: comment threads, jin's suggestions to accept or reject, the doc's chat with jin, and its
 * versions. It saves as you type; a version saved elsewhere meanwhile is never overwritten.
 */

type Panel = "comments" | "suggestions" | "chat" | "history";
type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export function DocPage({
  initial,
  chat,
  wsBase,
  embedded = false,
  onTitle,
}: {
  initial: DocFull;
  chat: { session: Session; events: SessionEvent[] } | null;
  wsBase: string;
  /** Inside a task's tab: no panes of its own; comments, suggestions and jin open beside it on demand. */
  embedded?: boolean;
  onTitle?: (title: string) => void;
}) {
  const router = useRouter();
  const editor = useRef<DocEditorHandle>(null);
  const [doc, setDoc] = useState<DocFull>(initial);
  const [title, setTitle] = useState(initial.title === "Untitled" && !initial.body ? "" : initial.title);
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [save, setSave] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(initial.suggestions.some((s) => s.status === "open") ? "suggestions" : "comments");
  const [phonePane, setPhonePane] = useState<"left" | "right">("left");
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<DocAnchor | "doc" | null>(null);
  const [chatState, setChatState] = useState(chat);
  const [sideOpen, setSideOpen] = useState(!embedded);

  // What is saved, and what is waiting to be.
  const version = useRef(initial.version);
  // The saved text as the editor writes it: an edit is a change from this, not from the stored spacing.
  const savedBody = useRef(initial.body);
  // The title as last saved or seen on the home (a rename from a menu shows up here).
  const savedTitle = useRef(initial.title);
  const pending = useRef<{ body?: string; title?: string; tags?: string[] }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (saving.current) await saving.current;
    const patch = pending.current;
    if (!Object.keys(patch).length) return;
    pending.current = {};
    setSave("saving");
    saving.current = (async () => {
      const r = await saveDoc(initial.id, patch, version.current);
      if ("error" in r) {
        // Kept, to try again (or to copy, on a conflict).
        pending.current = { ...patch, ...pending.current };
        setSave(r.conflict ? "conflict" : "error");
        setError(r.error);
        return;
      }
      version.current = r.version;
      savedTitle.current = r.title;
      if (patch.body !== undefined) savedBody.current = patch.body;
      setDoc((d) => ({ ...d, ...r }));
      setSave(Object.keys(pending.current).length ? "dirty" : "saved");
      setError(null);
    })();
    await saving.current;
    saving.current = null;
  }, [initial.id]);

  const queue = useCallback(
    (patch: { body?: string; title?: string; tags?: string[] }) => {
      if (patch.body !== undefined && patch.body === savedBody.current && !pending.current.title && !pending.current.tags) return;
      pending.current = { ...pending.current, ...patch };
      setSave((s) => (s === "conflict" ? s : "dirty"));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 800);
    },
    [flush],
  );

  // Leaving the page (or the tab) saves what is waiting.
  useEffect(() => {
    const away = () => void flush();
    window.addEventListener("pagehide", away);
    document.addEventListener("visibilitychange", away);
    return () => {
      away();
      window.removeEventListener("pagehide", away);
      document.removeEventListener("visibilitychange", away);
    };
  }, [flush]);

  /** The doc as it is on jin's home: threads, suggestions, its chat, and its text when it moved and nothing here is unsaved. */
  const reload = useCallback(
    async (opts: { takeBody?: boolean } = {}) => {
      const r = await getDoc(initial.id);
      if ("error" in r) return;
      const idle = !timer.current && !saving.current && !Object.keys(pending.current).length;
      if (r.version !== version.current && (idle || opts.takeBody)) {
        version.current = r.version;
        pending.current = {};
        savedBody.current = editor.current?.setBody(r.body) ?? r.body;
        setTitle(r.title === "Untitled" && !r.body ? "" : r.title);
        setTags(r.tags);
        setSave("saved");
        setError(null);
      }
      // Renamed elsewhere (the sidebar, a tab's menu) while nothing here is waiting to save the title.
      if (r.title !== savedTitle.current && pending.current.title === undefined) {
        savedTitle.current = r.title;
        setTitle(r.title === "Untitled" && !r.body ? "" : r.title);
        onTitle?.(r.title);
      }
      setDoc((d) => ({ ...r, body: idle || opts.takeBody ? r.body : d.body, version: version.current }));
      if (r.chatId && r.chatId !== chatState?.session.id) {
        const c = await docChat(r.chatId);
        if (c) setChatState(c);
      }
    },
    [initial.id, chatState?.session.id],
  );

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 4000);
    return () => clearInterval(t);
  }, [reload]);

  const threads = doc.threads.filter((t) => !t.resolved);
  const resolved = doc.threads.filter((t) => t.resolved);
  const open = doc.suggestions.filter((s) => s.status === "open");
  const annos = useMemo<Annotation[]>(
    () => [
      ...threads.filter((t) => t.anchor && t.located).map((t) => ({ id: t.id, kind: "thread" as const, anchor: t.anchor! })),
      ...open.filter((s) => s.located).map((s) => ({ id: s.id, kind: "suggestion" as const, anchor: s.anchor, replacement: s.replacement })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(threads.map((t) => [t.id, t.anchor, t.located])), JSON.stringify(open.map((s) => [s.id, s.replacement, s.located]))],
  );

  const show = (p: Panel) => {
    setPanel(p);
    setPhonePane("right");
    setSideOpen(true);
  };

  const decide = async (s: DocSuggestion, accept: boolean) => {
    await flush();
    const r = await decideDocSuggestion(initial.id, s.id, accept, version.current);
    if ("error" in r) {
      setError(r.error);
      await reload();
      return;
    }
    if (accept) {
      version.current = r.doc.version;
      savedBody.current = editor.current?.setBody(r.doc.body) ?? r.doc.body;
    }
    await reload();
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {});
  };

  const menu = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    openContextMenu({ clientX: r.right - 220, clientY: r.bottom + 4, preventDefault: () => e.preventDefault() }, [
      { label: "History", icon: History, run: () => show("history") },
      { label: "Copy as markdown", icon: Clipboard, run: () => void copy(`# ${title || "Untitled"}\n\n${editor.current?.getMarkdown() ?? doc.body}`) },
      {
        label: "Download .md",
        icon: Download,
        run: () => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([`# ${title || "Untitled"}\n\n${editor.current?.getMarkdown() ?? doc.body}`], { type: "text/markdown" }));
          a.download = `${(title || "untitled").replace(/[^\w-]+/g, "-").toLowerCase()}.md`;
          a.click();
        },
      },
      { label: "Copy link for a task", icon: FileText, hint: `doc:${doc.id}`, run: () => void copy(`doc:${doc.id}`) },
      { divider: true },
      {
        label: "Archive",
        icon: Archive,
        danger: true,
        confirm: "Archive this doc? It leaves the library; its history is kept.",
        run: async () => {
          await flush();
          await archiveDoc(doc.id);
          router.push("/docs");
        },
      },
    ]);
  };

  const status = { saved: "Saved", dirty: "Editing…", saving: "Saving…", conflict: "Changed elsewhere", error: "Not saved" }[save];

  const left = (
    <div className="doc-main">
      <header className="pane-header doc-header">
        <div className="pane-title">
          <Link href="/docs" className="meta doc-crumb">
            Docs
          </Link>
          <span className="meta">/</span>
          <span className="pane-name doc-crumb-title">{title || "Untitled"}</span>
        </div>
        <span className={`meta doc-save is-${save}`} title={error ?? undefined}>
          {status}
        </span>
        <button type="button" className="button quiet icon-only doc-header-button" onClick={() => show("comments")} title="Comments" aria-label="Comments">
          <MessageSquare size={15} />
          {threads.length > 0 && <span className="doc-count">{threads.length}</span>}
        </button>
        <button type="button" className="button quiet icon-only doc-header-button" onClick={() => show("suggestions")} title="jin's suggestions" aria-label="Suggestions">
          <Sparkles size={15} />
          {open.length > 0 && <span className="doc-count">{open.length}</span>}
        </button>
        {embedded && (
          <button type="button" className="button quiet icon-only" onClick={() => setSideOpen((v) => !v)} title={sideOpen ? "Hide comments and jin" : "Comments, suggestions and jin"} aria-label="Toggle the side panel">
            {sideOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </button>
        )}
        <button type="button" className="button quiet icon-only" onClick={menu} title="More" aria-label="More">
          <MoreHorizontal size={15} />
        </button>
      </header>
      {save === "conflict" && (
        <div className="doc-conflict" role="alert">
          <span>This doc changed somewhere else since you opened it. Your unsaved edits are not lost: copy them, then reload.</span>
          <button type="button" className="button small" onClick={() => void copy(editor.current?.getMarkdown() ?? "")}>
            Copy mine
          </button>
          <button type="button" className="button small primary" onClick={() => void reload({ takeBody: true })}>
            Reload
          </button>
        </div>
      )}
      <div className="doc-scroll" data-scroll="y">
        <div className="doc-page">
          <input
            className="doc-title"
            value={title}
            placeholder="Untitled"
            onChange={(e) => {
              setTitle(e.target.value);
              onTitle?.(e.target.value || "Untitled");
              queue({ title: e.target.value });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                editor.current?.focus();
              }
            }}
            aria-label="Title"
          />
          <Tags
            tags={tags}
            onChange={(t) => {
              setTags(t);
              queue({ tags: t });
            }}
          />
          <DocEditor
            ref={editor}
            initial={initial.body}
            onChange={(md) => queue({ body: md })}
            onReady={(md) => (savedBody.current = md)}
            annotations={annos}
            active={active}
            onAnnotation={(id) => {
              setActive(id);
              show(doc.suggestions.some((s) => s.id === id) ? "suggestions" : "comments");
            }}
            onComment={(a) => {
              setDraft(a);
              show("comments");
            }}
          />
        </div>
      </div>
    </div>
  );

  const right = (
    <aside className="doc-side">
      <div className="doc-tabs" role="tablist">
        {(
          [
            ["comments", "Comments", threads.length],
            ["suggestions", "Suggestions", open.length],
            ["chat", "jin", 0],
            ["history", "History", 0],
          ] as const
        ).map(([k, label, n]) => (
          <button key={k} type="button" role="tab" aria-selected={panel === k} className={panel === k ? "is-active" : ""} onClick={() => setPanel(k)}>
            {label}
            {n > 0 && <span className="doc-count">{n}</span>}
          </button>
        ))}
        {embedded && (
          <button type="button" className="doc-tabs-close" onClick={() => setSideOpen(false)} title="Close" aria-label="Close the side panel">
            <X size={14} />
          </button>
        )}
      </div>
      <div className="doc-side-body" data-scroll={panel === "chat" ? undefined : "y"}>
        {panel === "comments" && (
          <Comments
            docId={doc.id}
            threads={threads}
            resolved={resolved}
            active={active}
            draft={draft}
            setDraft={setDraft}
            onActive={setActive}
            onChanged={() => void reload()}
            onError={setError}
          />
        )}
        {panel === "suggestions" && <Suggestions list={doc.suggestions} active={active} onActive={setActive} decide={decide} ask={() => setPanel("chat")} />}
        {panel === "chat" && (
          <div className="doc-chat">
            <Chat
              key={chatState?.session.id ?? "new"}
              kind="doc"
              session={chatState?.session ?? null}
              initialEvents={chatState?.events ?? []}
              approvals={[]}
              wsBase={wsBase}
              title="jin"
              welcome={{
                heading: "Work on this doc with jin",
                body: "Ask jin to draft a section, review the argument, find gaps or check claims against the code. jin replies here and proposes edits as suggestions you accept or reject. In a comment, write @jin to ask about that passage.",
                suggestions: ["Review this doc: gaps, risks, what to cut", "Draft an outline for this", "Check the claims here against the code"],
              }}
              placeholder="Ask jin about this doc…"
              start={async (prompt, choice) => {
                await flush();
                const s = await askDoc(doc.id, prompt, choice);
                return s;
              }}
            />
          </div>
        )}
        {panel === "history" && (
          <Versions
            docId={doc.id}
            current={doc.version}
            restore={async (v) => {
              await flush();
              const r = await restoreDocVersion(doc.id, v, version.current);
              if ("error" in r) return setError(r.error);
              version.current = r.version;
              savedBody.current = editor.current?.setBody(r.body) ?? r.body;
              setTitle(r.title);
              await reload();
            }}
          />
        )}
      </div>
    </aside>
  );

  if (embedded)
    return (
      <div className={`doc-embedded ${sideOpen ? "is-side-open" : ""}`}>
        {left}
        {sideOpen && right}
      </div>
    );
  return <Panes id="doc" defaultSplit={68} minRight={300} labels={["Doc", "Comments & jin"]} phone={phonePane} onPhone={setPhonePane} left={left} right={right} />;
}

// ---------------------------------------------------------------- tags

function Tags({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim().toLowerCase().replace(/^#/, "");
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setText("");
  };
  return (
    <div className="doc-tags">
      {tags.map((t) => (
        <span key={t} className="doc-tag">
          {t}
          <button type="button" onClick={() => onChange(tags.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={text}
        placeholder={tags.length ? "Add a tag" : "Add tags (rfc, spec, apollo…)"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !text && tags.length) onChange(tags.slice(0, -1));
        }}
        onBlur={add}
        aria-label="Tags"
      />
    </div>
  );
}

// ---------------------------------------------------------------- comments

function Comments({
  docId,
  threads,
  resolved,
  active,
  draft,
  setDraft,
  onActive,
  onChanged,
  onError,
}: {
  docId: string;
  threads: DocThread[];
  resolved: DocThread[];
  active: string | null;
  draft: DocAnchor | "doc" | null;
  setDraft: (d: DocAnchor | "doc" | null) => void;
  onActive: (id: string | null) => void;
  onChanged: () => void;
  onError: (e: string) => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) list.current?.querySelector(`[data-thread="${active}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);
  return (
    <div className="doc-threads" ref={list}>
      {draft ? (
        <div className="doc-thread is-draft">
          {draft !== "doc" && <blockquote className="doc-quote">{draft.quote}</blockquote>}
          <Composer
            autoFocus
            placeholder={draft === "doc" ? "Comment on the whole doc… (@jin to ask jin)" : "Comment… (@jin to ask jin)"}
            onCancel={() => setDraft(null)}
            onSend={async (text) => {
              const r = await commentDoc(docId, text, draft === "doc" ? null : draft);
              if ("error" in r) return onError(r.error);
              setDraft(null);
              onActive(r.id);
              onChanged();
            }}
          />
        </div>
      ) : (
        <button type="button" className="button small doc-new-thread" onClick={() => setDraft("doc")}>
          <MessageSquare size={13} /> Comment on the doc
        </button>
      )}
      {!threads.length && !draft && <p className="meta doc-empty">Select text in the doc and press Comment, or comment on the whole doc. Write @jin in a comment to ask jin about it.</p>}
      {threads.map((t) => (
        <ThreadCard key={t.id} docId={docId} t={t} active={active === t.id} onActive={onActive} onChanged={onChanged} onError={onError} />
      ))}
      {resolved.length > 0 && (
        <button type="button" className="nav-archived-toggle" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? "Hide" : "Show"} resolved ({resolved.length})
        </button>
      )}
      {showResolved && resolved.map((t) => <ThreadCard key={t.id} docId={docId} t={t} active={active === t.id} onActive={onActive} onChanged={onChanged} onError={onError} />)}
    </div>
  );
}

function ThreadCard({ docId, t, active, onActive, onChanged, onError }: { docId: string; t: DocThread; active: boolean; onActive: (id: string | null) => void; onChanged: () => void; onError: (e: string) => void }) {
  const waiting = t.comments.at(-1)?.by === "you" && /(^|\s)@jin\b/i.test(t.comments.at(-1)!.text);
  return (
    <div className={`doc-thread ${active ? "is-active" : ""} ${t.resolved ? "is-resolved" : ""}`} data-thread={t.id} onClick={() => onActive(t.id)}>
      <div className="doc-thread-head">
        {t.anchor ? <blockquote className={`doc-quote ${t.located ? "" : "is-outdated"}`}>{displayText(t.anchor.quote)}</blockquote> : <span className="meta">On the whole doc</span>}
        <button
          type="button"
          className="button quiet icon-only"
          title={t.resolved ? "Reopen" : "Resolve"}
          aria-label={t.resolved ? "Reopen" : "Resolve"}
          onClick={async (e) => {
            e.stopPropagation();
            const r = await resolveDocThread(docId, t.id, !t.resolved);
            if ("error" in r) onError(r.error);
            onChanged();
          }}
        >
          {t.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
        </button>
      </div>
      {!t.located && t.anchor && <p className="meta doc-outdated">The text this was on has changed.</p>}
      {t.comments.map((c) => (
        <div key={c.id} className={`doc-comment by-${c.by === "you" ? "you" : "jin"}`}>
          <span className="doc-comment-by">{c.by === "you" ? "You" : c.by}</span>
          <span className="meta">{ago(c.at)}</span>
          <p>{c.text}</p>
        </div>
      ))}
      {waiting && <p className="meta doc-waiting">jin is reading…</p>}
      {active && !t.resolved && (
        <Composer
          placeholder="Reply… (@jin to ask jin)"
          onSend={async (text) => {
            const r = await replyDoc(docId, t.id, text);
            if ("error" in r) return onError(r.error);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function Composer({ placeholder, onSend, onCancel, autoFocus }: { placeholder: string; onSend: (text: string) => Promise<void>; onCancel?: () => void; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    await onSend(text.trim());
    setText("");
    setBusy(false);
  };
  return (
    <div className="doc-composer" onClick={(e) => e.stopPropagation()}>
      <textarea
        autoFocus={autoFocus}
        rows={2}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          } else if (e.key === "Escape") onCancel?.();
        }}
      />
      <span className="doc-composer-actions">
        {onCancel && (
          <button type="button" className="button small quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="button small primary" disabled={!text.trim() || busy} onClick={() => void send()}>
          {busy ? "Sending…" : "Comment"}
        </button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- suggestions

function Suggestions({ list, active, onActive, decide, ask }: { list: DocSuggestion[]; active: string | null; onActive: (id: string) => void; decide: (s: DocSuggestion, accept: boolean) => Promise<void>; ask: () => void }) {
  const open = list.filter((s) => s.status === "open");
  const done = list.filter((s) => s.status !== "open").slice(-5).reverse();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="doc-suggestions">
      {!open.length && (
        <p className="meta doc-empty">
          No suggestions waiting. <button type="button" className="link-button" onClick={ask}>Ask jin</button> to review or draft part of the doc; its edits show up here, and in the text, to accept or reject.
        </p>
      )}
      {open.map((s) => (
        <div key={s.id} className={`doc-sugg ${active === s.id ? "is-active" : ""} ${s.located ? "" : "is-outdated"}`} onClick={() => onActive(s.id)}>
          <div className="doc-sugg-diff">
            {s.anchor.quote && <del>{s.anchor.quote}</del>}
            {s.replacement && <ins>{s.replacement}</ins>}
          </div>
          {s.why && <p className="doc-sugg-why">{s.why}</p>}
          {!s.located && <p className="meta doc-outdated">The text this changes has been edited since.</p>}
          <span className="doc-sugg-actions">
            <button
              type="button"
              className="button small primary"
              disabled={!s.located || busy === s.id}
              onClick={async (e) => {
                e.stopPropagation();
                setBusy(s.id);
                await decide(s, true);
                setBusy(null);
              }}
            >
              <Check size={13} /> Accept
            </button>
            <button
              type="button"
              className="button small"
              disabled={busy === s.id}
              onClick={async (e) => {
                e.stopPropagation();
                setBusy(s.id);
                await decide(s, false);
                setBusy(null);
              }}
            >
              <X size={13} /> Reject
            </button>
            <span className="meta">{ago(s.createdAt)}</span>
          </span>
        </div>
      ))}
      {done.length > 0 && <p className="meta doc-done-head">Recently decided</p>}
      {done.map((s) => (
        <div key={s.id} className="doc-sugg is-decided">
          <span className={`doc-sugg-status is-${s.status}`}>{s.status}</span>
          <span className="meta">{displayText(s.replacement || s.anchor.quote).slice(0, 120)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- history

function Versions({ docId, current, restore }: { docId: string; current: number; restore: (v: number) => Promise<void> }) {
  const [list, setList] = useState<DocVersion[] | null>(null);
  const [view, setView] = useState<{ version: number; body: string } | null>(null);
  useEffect(() => {
    void docVersions(docId).then(setList);
  }, [docId, current]);
  if (!list) return <p className="meta doc-empty">Loading…</p>;
  return (
    <div className="doc-versions">
      {list.map((v) => (
        <div key={v.version} className={`doc-version ${view?.version === v.version ? "is-active" : ""}`}>
          <button type="button" className="doc-version-row" onClick={async () => setView(view?.version === v.version ? null : await docVersion(docId, v.version))}>
            <span>
              v{v.version} {v.version === current && <span className="meta">current</span>}
            </span>
            <span className="meta">
              {v.by} · {ago(v.at)}
            </span>
          </button>
          {view?.version === v.version && (
            <div className="doc-version-body">
              <pre>{view.body || "(empty)"}</pre>
              {v.version !== current && (
                <button type="button" className="button small" onClick={() => void restore(v.version)}>
                  <RotateCcw size={13} /> Restore this version
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export type { Doc };
