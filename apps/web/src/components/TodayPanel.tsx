"use client";
import { createContext, useContext, type ReactNode } from "react";
import { Empty } from "@/components/States";
import { Check, ChevronRight, CircleDot, Clock, ExternalLink, FileText, GitPullRequest, Link2, Mail, MessageSquare, RefreshCw, RotateCcw, Sparkles } from "lucide-react";
import { collectGithub, feedAction, linkFeedThread } from "@/lib/actions";
import type { FeedItem } from "@/lib/daemon";
import { groupFeed, rowWhat, type FeedGroup, type FeedRow } from "@/lib/feed-groups";
import { isPullRequest } from "@/lib/pr";
import { BobbyBadge } from "./BobbyBadge";
import { ReviewButton } from "./ReviewButton";

export const SOURCE: Record<string, { label: string; Icon: typeof Mail }> = {
  github: { label: "GitHub", Icon: GitPullRequest },
  linear: { label: "Linear", Icon: CircleDot },
  slack: { label: "Slack", Icon: MessageSquare },
  notion: { label: "Notion", Icon: FileText },
  gmail: { label: "Mail", Icon: Mail },
  jin: { label: "jin", Icon: Sparkles },
};
/** Kinds that need you, shown as a coloured dot on the collapsed thread. */
const URGENT: Record<string, string> = { ci_failed: "Checks failing", review_requested: "Review requested", mention: "You were mentioned" };

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

type TaskRef = { taskId: string; machine: string; title: string };

/** What a row's buttons do with their form: the desk passes one that takes the row away at once. */
export const FeedAct = createContext<(form: FormData) => Promise<void>>(feedAction);

function Actions({ g, stale, hint }: { g: FeedGroup; stale?: boolean; hint?: TaskRef | null }) {
  const act = useContext(FeedAct);
  const label = g.ids.length > 1 ? "this thread" : "this";
  if (stale)
    return (
      <form action={act} className="fg-actions">
        {g.ids.map((id) => (
          <input key={id} type="hidden" name="itemId" value={id} />
        ))}
        <button type="submit" name="action" value="reopen" className="button quiet small" title="Not handled: back to open" aria-label={`Reopen ${label}`}>
          <RotateCcw size={12} /> Reopen
        </button>
      </form>
    );
  return (
    <>
    {hint && g.url && (
      <form action={linkFeedThread} className="fg-actions fg-hint">
        <input type="hidden" name="taskId" value={hint.taskId} />
        <input type="hidden" name="machine" value={hint.machine} />
        <input type="hidden" name="url" value={g.url} />
        <button type="submit" className="button quiet small" title={`jin thinks this belongs to ${hint.taskId} (${hint.title}): link it to the task`}>
          <Link2 size={12} /> {hint.taskId}
        </button>
      </form>
    )}
    <form action={act} className="fg-actions">
      {g.ids.map((id) => (
        <input key={id} type="hidden" name="itemId" value={id} />
      ))}
      {g.url && isPullRequest(g.url) && <ReviewButton pr={g.url} />}
      {g.url && (
        <a className="button quiet icon-only small" href={g.url} target="_blank" rel="noreferrer" title="Open" aria-label="Open">
          <ExternalLink size={13} />
        </a>
      )}
      <button type="submit" name="action" value="snooze" className="button quiet icon-only small" title={`Later: back in a day`} aria-label={`Later: snooze ${label} for a day`}>
        <Clock size={13} />
      </button>
      <button type="submit" name="action" value="done" className="button quiet icon-only small" title={`Done with ${label}`} aria-label={`Done with ${label}`}>
        <Check size={13} />
      </button>
    </form>
    </>
  );
}

/** A leaf: who did what, and when. The message itself shows on hover; the link opens it. */
function Row({ r }: { r: FeedRow }) {
  const body = (
    <>
      {r.actor && <span className="fg-actor">{r.actor}</span>}
      <span className={r.kind ? `fg-what is-${r.kind}` : "fg-what"}>{rowWhat(r)}</span>
    </>
  );
  return (
    <li className="fg-row" data-feed-id={r.id} title={r.snippet || undefined}>
      {r.url ? (
        <a className="fg-line" href={r.url} target="_blank" rel="noreferrer">
          {body}
        </a>
      ) : (
        <span className="fg-line">{body}</span>
      )}
      <span className="fg-age">{ago(r.at)}</span>
    </li>
  );
}

/**
 * A thread, collapsed to one line: source, title, count, age; with `why` (the desk's triage),
 * a second line says why it is here. Open it for who did what.
 */
export function Group({ g, why, isNew, stale, hint }: { g: FeedGroup; why?: ReactNode; isNew?: boolean; stale?: boolean; hint?: TaskRef | null }) {
  const pr = g.url && isPullRequest(g.url) ? g.url : null;
  const src = SOURCE[g.source] ?? { label: g.source, Icon: Sparkles };
  const urgent = g.rows.find((r) => r.kind && URGENT[r.kind]);
  const count = g.rows.reduce((n, r) => n + r.count, 0);
  return (
    <li className={`feed-group${pr ? " has-bobby" : ""}${why ? " has-why" : ""}${isNew ? " is-new" : ""}`} data-thread={g.key}>
      <details>
        <summary className="fg-head" title={[g.ref, g.title].filter(Boolean).join(" ")}>
          <ChevronRight size={13} className="fg-chevron" aria-hidden />
          <src.Icon size={13} className={`fg-src is-${g.source}`} aria-label={src.label} />
          {why ? (
            <span className="fg-text">
              <span className="fg-title">{g.ref && !g.title.includes(g.ref) ? <span className="fg-ref">{g.ref}</span> : null}{g.title}</span>
              <span className="fg-why">{why}</span>
            </span>
          ) : (
            <span className="fg-title">{g.title}</span>
          )}
          {urgent && <span className={`fg-dot is-${urgent.kind}`} title={URGENT[urgent.kind!]} />}
          {count > 1 && <span className="fg-count">{count}</span>}
          <span className="fg-age">{ago(g.latest)}</span>
          {pr && <BobbyBadge pr={pr} compact />}
        </summary>
        <ul className="fg-rows">
          {g.rows.map((r) => (
            <Row key={r.id} r={r} />
          ))}
        </ul>
      </details>
      <Actions g={g} stale={stale} hint={hint} />
    </li>
  );
}

/** Feed items as threads (a task's Activity uses it too). */
export function FeedThreads({ items }: { items: FeedItem[] }) {
  return (
    <ul className="feed-groups">
      {groupFeed(items).map((g) => (
        <Group key={g.key} g={g} />
      ))}
    </ul>
  );
}

/**
 * What is waiting, grouped by thread, newest first: jin's right pane, and the desk's main view
 * (`main`, with jin's mark as `lead` to switch back).
 */
export function TodayPanel({ items, title = "Today", note, lead, main }: { items: FeedItem[]; title?: string; note?: string; lead?: ReactNode; main?: boolean }) {
  const open = items.filter((i) => i.state === "new");
  const groups = groupFeed(open);
  return (
    <section className={`side-panel${main ? " is-main" : ""}`} aria-labelledby="today-heading">
      <header className="pane-header">
        <div className="pane-title">
          {lead}
          <span className="pane-name" id="today-heading">
            {title}
          </span>
          <span className="meta">
            {groups.length} {groups.length === 1 ? "thread" : "threads"} · {open.length} open
          </span>
        </div>
        <form action={collectGithub}>
          <button type="submit" className="button quiet" title="Pull reviews, failing checks and mentions from GitHub">
            <RefreshCw size={13} /> Refresh
          </button>
        </form>
      </header>
      <div className="side-scroll" data-scroll="y">
        {note && <p className="meta pad">{note}</p>}
        {open.length === 0 ? (
          <Empty>Nothing waiting. Refresh to pull from GitHub.</Empty>
        ) : (
          <ul className="feed-groups">
            {groups.map((g) => (
              <Group key={g.key} g={g} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
