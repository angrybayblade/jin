import { ChevronRight, CircleDot, Clock, ExternalLink, FileText, GitPullRequest, Mail, MessageSquare, RefreshCw, Sparkles, X } from "lucide-react";
import { collectGithub, feedAction } from "@/app/actions";
import type { FeedItem } from "@/lib/daemon";
import { groupFeed, rowWhat, type FeedGroup, type FeedRow } from "@/lib/feed-groups";
import { isPullRequest } from "@/lib/pr";
import { BobbyBadge } from "./BobbyBadge";
import { ReviewButton } from "./ReviewButton";

const SOURCE: Record<string, { label: string; Icon: typeof Mail }> = {
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

function Actions({ g }: { g: FeedGroup }) {
  const label = g.ids.length > 1 ? "this thread" : "this";
  return (
    <form action={feedAction} className="fg-actions">
      {g.ids.map((id) => (
        <input key={id} type="hidden" name="itemId" value={id} />
      ))}
      {g.url && isPullRequest(g.url) && <ReviewButton pr={g.url} />}
      {g.url && (
        <a className="button quiet icon-only small" href={g.url} target="_blank" rel="noreferrer" title="Open" aria-label="Open">
          <ExternalLink size={13} />
        </a>
      )}
      <button type="submit" name="action" value="snooze" className="button quiet icon-only small" title={`Snooze ${label} for a day`} aria-label={`Snooze ${label}`}>
        <Clock size={13} />
      </button>
      <button type="submit" name="action" value="dismiss" className="button quiet icon-only small" title={`Dismiss ${label}`} aria-label={`Dismiss ${label}`}>
        <X size={13} />
      </button>
    </form>
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

/** A thread, collapsed to one line: source, title, count, age. Open it for who did what. */
function Group({ g }: { g: FeedGroup }) {
  const pr = g.url && isPullRequest(g.url) ? g.url : null;
  const src = SOURCE[g.source] ?? { label: g.source, Icon: Sparkles };
  const urgent = g.rows.find((r) => r.kind && URGENT[r.kind]);
  const count = g.rows.reduce((n, r) => n + r.count, 0);
  return (
    <li className={`feed-group${pr ? " has-bobby" : ""}`} data-thread={g.key}>
      <details>
        <summary className="fg-head" title={[g.ref, g.title].filter(Boolean).join(" ")}>
          <ChevronRight size={13} className="fg-chevron" aria-hidden />
          <src.Icon size={13} className={`fg-src is-${g.source}`} aria-label={src.label} />
          <span className="fg-title">{g.title}</span>
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
      <Actions g={g} />
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

/** Jin's right pane: what is waiting, grouped by thread, newest first. Ask jin in the chat to act on it. */
export function TodayPanel({ items, title = "Today", note }: { items: FeedItem[]; title?: string; note?: string }) {
  const open = items.filter((i) => i.state === "new");
  const groups = groupFeed(open);
  return (
    <section className="side-panel" aria-labelledby="today-heading">
      <header className="pane-header">
        <div className="pane-title">
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
          <p className="meta pad">Nothing waiting. Refresh to pull from GitHub.</p>
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
