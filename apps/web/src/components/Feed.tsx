import { collectGithub, feedAction, promoteItem } from "@/app/actions";
import type { FeedItem } from "@/lib/daemon";

const KIND_LABEL: Record<string, string> = {
  review_requested: "Review requested",
  ci_failed: "Checks failing",
  mention: "Mention",
};

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

/** The catch-up feed: what changed and what is waiting on you, newest first. */
export function Feed({ items }: { items: FeedItem[] }) {
  const open = items.filter((i) => i.state === "new");
  const later = items.filter((i) => i.state === "snoozed");
  return (
    <section className="feed" aria-labelledby="feed-heading">
      <div className="list-heading">
        <div>
          <h2 id="feed-heading">Catch up</h2>
          <p className="meta">
            {open.length} open{later.length ? ` · ${later.length} snoozed` : ""}
          </p>
        </div>
        <form action={collectGithub}>
          <button type="submit" className="button">
            Refresh GitHub
          </button>
        </form>
      </div>
      {open.length === 0 ? (
        <div className="empty-state">
          <p>Nothing waiting. Refresh to pull reviews, failing checks and mentions from GitHub.</p>
        </div>
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
                  {item.priority ? ` · ${item.priority.why}` : ""}
                </div>
              </div>
              <div className="feed-actions">
                <details className="promote">
                  <summary className="button quiet">Start task</summary>
                  <form action={promoteItem} className="promote-form">
                    <input type="hidden" name="itemId" value={item.id} />
                    <label>
                      Task ID
                      <input name="taskId" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" placeholder="PLEN-123" />
                    </label>
                    <label>
                      Repos
                      <input name="repos" required placeholder="platform,mercury" />
                    </label>
                    <label>
                      Type
                      <select name="type" defaultValue="bug">
                        {["feature", "enhancement", "refactor", "patch", "bug"].map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </label>
                    <input type="hidden" name="slug" value={item.title} />
                    <button type="submit" className="button primary">
                      Create task
                    </button>
                  </form>
                </details>
                <form action={feedAction}>
                  <input type="hidden" name="itemId" value={item.id} />
                  <button type="submit" name="action" value="snooze" className="button quiet">
                    Snooze
                  </button>
                  <button type="submit" name="action" value="dismiss" className="button quiet">
                    Dismiss
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
