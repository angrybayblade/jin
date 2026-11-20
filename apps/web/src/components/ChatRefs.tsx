"use client";
import { Empty } from "@/components/States";
import { CircleDot, ExternalLink, FileText, GitPullRequest, Link2, ListChecks, Mail, MessageSquare } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { chatRefs } from "@/lib/actions";
import type { ChatRef } from "@/lib/daemon";

/**
 * jin's right pane: what this chat has talked about (PRs, tickets, tasks, Slack threads,
 * Notion pages, mail, links), grouped by kind, most recently mentioned first. Read again when
 * the chat gets a message.
 */

const GROUPS: { kind: ChatRef["kind"]; label: string; Icon: typeof Mail }[] = [
  { kind: "pr", label: "Pull requests", Icon: GitPullRequest },
  { kind: "issue", label: "Tickets", Icon: CircleDot },
  { kind: "task", label: "Tasks", Icon: ListChecks },
  { kind: "slack", label: "Slack", Icon: MessageSquare },
  { kind: "notion", label: "Notion", Icon: FileText },
  { kind: "mail", label: "Mail", Icon: Mail },
  { kind: "link", label: "Links", Icon: Link2 },
];

/** Chat tells the pane when something arrived (see Chat's stream). */
export const CHAT_EVENT = "jin-chat";

function Row({ r, Icon }: { r: ChatRef; Icon: typeof Mail }) {
  const tip = [r.title, r.state, r.detail, r.machineLabel ? `on ${r.machineLabel}` : null, `mentioned by ${r.by === "both" ? "you and jin" : r.by}${r.count > 1 ? `, ${r.count} times` : ""}`].filter(Boolean).join(" · ");
  const body = (
    <>
      <Icon size={13} className={`fg-src is-${r.kind}`} aria-hidden />
      <span className="ref-label">{r.label}</span>
      {r.title && <span className="ref-title">{r.title}</span>}
      {r.state && <span className={`ref-state is-${r.state.toLowerCase().replace(/\s+/g, "-")}`}>{r.state}</span>}
      {r.url && !r.url.startsWith("/") && <ExternalLink size={11} className="ref-out" aria-hidden />}
    </>
  );
  return (
    <li className="ref-row" title={tip}>
      {r.url?.startsWith("/") ? (
        <Link href={r.url} className="ref-line">
          {body}
        </Link>
      ) : r.url ? (
        <a href={r.url} target="_blank" rel="noreferrer" className="ref-line">
          {body}
        </a>
      ) : (
        <span className="ref-line">{body}</span>
      )}
    </li>
  );
}

export function ChatRefs({ sessionId }: { sessionId: string | null }) {
  const [refs, setRefs] = useState<ChatRef[] | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    setRefs(sessionId ? null : []);
    if (!sessionId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      const n = ++seq.current;
      void chatRefs(sessionId)
        .then((r) => n === seq.current && setRefs(r))
        .catch(() => n === seq.current && setRefs((had) => had ?? []));
    };
    const onEvent = (e: Event) => {
      if ((e as CustomEvent<{ sessionId: string }>).detail?.sessionId !== sessionId) return;
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    };
    load();
    window.addEventListener(CHAT_EVENT, onEvent);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(CHAT_EVENT, onEvent);
    };
  }, [sessionId]);

  const list = refs ?? [];
  return (
    <section className="side-panel" aria-labelledby="refs-heading">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-name" id="refs-heading">
            In this chat
          </span>
          {list.length > 0 && <span className="meta">{list.length} mentioned</span>}
        </div>
      </header>
      <div className="side-scroll" data-scroll="y">
        {refs === null ? null : list.length === 0 ? (
          <Empty>PRs, tickets, Slack threads and pages this chat talks about show up here.</Empty>
        ) : (
          GROUPS.map(({ kind, label, Icon }) => {
            const rows = list.filter((r) => r.kind === kind);
            if (!rows.length) return null;
            return (
              <div key={kind} className="ref-group">
                <h3 className="ref-heading">
                  {label} <span className="ref-n">{rows.length}</span>
                </h3>
                <ul className="ref-list">
                  {rows.map((r) => (
                    <Row key={r.key} r={r} Icon={Icon} />
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
