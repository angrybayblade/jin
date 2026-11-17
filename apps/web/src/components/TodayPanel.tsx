import { Clock, RefreshCw, X } from "lucide-react";
import { collectGithub, feedAction } from "@/app/actions";
import type { FeedItem } from "@/lib/daemon";
import { groupFeed, rowWhat, type FeedGroup, type FeedRow } from "@/lib/feed-groups";
import { isPullRequest } from "@/lib/pr";
import { BobbyBadge } from "./BobbyBadge";

const SOURCE: Record<string, string> = { github: "GitHub", linear: "Linear", slack: "Slack", notion: "Notion", gmail: "Mail", jin: "jin" };
/** Rows a thread shows before "N more". */
const SHOWN = 3;

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

function Actions({ ids, label }: { ids: string[]; label: string }) {
  return (
    <form action={feedAction} className="fg-actions">
      {ids.map((id) => (
        <input key={id} type="hidden" name="itemId" value={id} />
      ))}
      <button type="submit" name="action" value="snooze" className="button quiet icon-only small" title={`Snooze ${label} for a day`} aria-label={`Snooze ${label}`}>
        <Clock size={14} />
      </button>
      <button type="submit" name="action" value="dismiss" className="button quiet icon-only small" title={`Dismiss ${label}`} aria-label={`Dismiss ${label}`}>
        <X size={14} />
      </button>
    </form>
  );
}

function Row({ r }: { r: FeedRow }) {
  const line = (
    <>
      {r.actor && <span className="fg-actor">{r.actor}</span>}
      {r.kind ? <span className={`kind-chip is-${r.kind}`}>{rowWhat(r)}</span> : r.what && <span className="fg-what">{rowWhat(r)}</span>}
      {r.snippet && <span className="fg-snippet">{r.snippet}</span>}
    </>
  );
  return (
    <li className="fg-row" data-feed-id={r.id}>
      {r.url ? (
        <a className="fg-line" href={r.url} target="_blank" rel="noreferrer" title={r.snippet || undefined}>
          {line}
        </a>
      ) : (
        <span className="fg-line" title={r.snippet || undefined}>
          {line}
        </span>
      )}
      <span className="fg-age">{ago(r.at)}</span>
    </li>
  );
}

function Group({ g }: { g: FeedGroup }) {
  const pr = g.url && isPullRequest(g.url) ? g.url : null;
  const shown = g.rows.slice(0, SHOWN);
  const more = g.rows.slice(SHOWN);
  const head = (
    <>
      {g.ref && <span className="fg-ref">{g.ref}</span>}
      <span className="fg-title-text">{g.title}</span>
    </>
  );
  return (
    <li className={`feed-group${pr ? " has-bobby" : ""}`} data-thread={g.key}>
      <div className="fg-head">
        <span className={`src-chip is-${g.source}`}>{SOURCE[g.source] ?? g.source}</span>
        {g.url ? (
          <a className="fg-title" href={g.url} target="_blank" rel="noreferrer" title={g.title}>
            {head}
          </a>
        ) : (
          <span className="fg-title" title={g.title}>
            {head}
          </span>
        )}
        {g.ids.length > 1 && <span className="fg-count">{g.ids.length}</span>}
        {pr && <BobbyBadge pr={pr} compact />}
        <Actions ids={g.ids} label={g.ids.length > 1 ? "this thread" : "this"} />
      </div>
      <ul className="fg-rows">
        {shown.map((r) => (
          <Row key={r.id} r={r} />
        ))}
      </ul>
      {more.length > 0 && (
        <details className="fg-more">
          <summary>{more.reduce((n, r) => n + r.count, 0)} more</summary>
          <ul className="fg-rows">
            {more.map((r) => (
              <Row key={r.id} r={r} />
            ))}
          </ul>
        </details>
      )}
    </li>
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
