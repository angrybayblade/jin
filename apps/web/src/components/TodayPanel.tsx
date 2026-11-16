import { RefreshCw } from "lucide-react";
import { collectGithub, feedAction } from "@/app/actions";
import type { FeedItem } from "@/lib/daemon";

const KIND_LABEL: Record<string, string> = { review_requested: "Review", ci_failed: "Checks failing", mention: "Mention" };

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

/** Jin's right pane: what is waiting, newest first. Ask jin in the chat to act on it. */
export function TodayPanel({ items, title = "Today", note }: { items: FeedItem[]; title?: string; note?: string }) {
  const open = items.filter((i) => i.state === "new");
  return (
    <section className="side-panel" aria-labelledby="today-heading">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-name" id="today-heading">
            {title}
          </span>
          <span className="meta">{open.length} open</span>
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
          <ul className="feed-list">
            {open.map((item) => (
              <li key={item.id} className="feed-row" data-feed-id={item.id}>
                <div className="feed-main">
                  <span className={`kind-chip is-${item.kind}`}>{KIND_LABEL[item.kind] ?? item.kind}</span>
                  <a className="feed-title" href={item.externalRef} target="_blank" rel="noreferrer">
                    {item.title}
                  </a>
                  <div className="meta">
                    {item.summary} · {ago(item.receivedAt)}
                  </div>
                </div>
                <form action={feedAction} className="feed-actions">
                  <input type="hidden" name="itemId" value={item.id} />
                  <button type="submit" name="action" value="snooze" className="button quiet small">
                    Snooze
                  </button>
                  <button type="submit" name="action" value="dismiss" className="button quiet small">
                    Dismiss
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
