"use client";
import { useState } from "react";
import { chooseNotificationKinds, testNotification } from "@/app/actions";
import type { NotificationKinds } from "@/lib/daemon";

/** Per app, which live events send a desktop notification. Everything still reaches the feed. */
export function NotificationsPage({ initial }: { initial: NotificationKinds[] }) {
  const [apps, setApps] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (app: NotificationKinds, kind: string) => {
    const chosen = app.kinds.filter((k) => (k.id === kind ? !k.chosen : k.chosen)).map((k) => k.id);
    setBusy(`${app.app}:${kind}`);
    setError(null);
    const r = await chooseNotificationKinds(app.app, chosen);
    setBusy(null);
    if ("error" in r) setError(r.error);
    else setApps(r);
  };
  return (
    <div className="machines">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-name">Notifications</span>
          <span className="meta">what notifies you, per app; everything still lands in the feed</span>
        </div>
        <button type="button" className="button small quiet" onClick={() => void testNotification()}>
          Send a test
        </button>
      </header>
      <div className="machines-body is-single" data-scroll="y">
        <main className="machines-main">
          <article className="machine-detail">
            {error && <p className="machine-error">{error}</p>}
            {apps.map((a) => (
              <section key={a.app} className="md-card">
                <div className="md-card-head is-static">
                  <h3>{a.label}</h3>
                  <span className="meta">{a.kinds.filter((k) => k.chosen).length ? `${a.kinds.filter((k) => k.chosen).length} of ${a.kinds.length} notify` : "silent"}</span>
                </div>
                <ul className="machine-auths">
                  {a.kinds.map((k) => (
                    <li key={k.id} className="machine-auth">
                      <div className="machine-auth-head">
                        <label className="live-switch">
                          <input type="checkbox" checked={k.chosen} disabled={busy !== null} onChange={() => void toggle(a, k.id)} />
                          <span className="live-switch-track" />
                        </label>
                        <div className="machine-auth-name">
                          <span className="machine-auth-tool">{k.label}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <p className="meta">Turns, approvals and finished setups always notify (unless notifications are off). These choices are for live events from Slack, Linear, Notion, Gmail and GitHub.</p>
          </article>
        </main>
      </div>
    </div>
  );
}
