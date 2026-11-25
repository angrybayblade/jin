"use client";
import { Empty } from "@/components/States";
import { ArrowRight, Check, ChevronRight, Clock, Crosshair, ExternalLink, MessageSquareText, RefreshCw, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { collectGithub, feedSet, sweepFeed } from "@/lib/actions";
import type { FeedItem } from "@/lib/daemon";
import { COMPOSE_EVENT } from "@/lib/desk-events";
import { rowWhat } from "@/lib/feed-groups";
import { desk, waited, type DeskSection, type Triaged } from "@/lib/triage";
import { Group, SOURCE } from "./TodayPanel";

/**
 * The desk's main view, built to keep focus: what is waiting on you first (a few at a time,
 * each saying why), what moved and the background folded away, and Focus, which goes
 * through what needs you one thread at a time.
 */

const SHOWN = 6;
const OLD_DAYS = 3;
const LAST_LOOK = "jin.desk.lastLook";

const readLastLook = () => {
  try {
    return localStorage.getItem(LAST_LOOK);
  } catch {
    return null;
  }
};
const writeLastLook = (iso: string) => {
  try {
    localStorage.setItem(LAST_LOOK, iso);
  } catch {}
};

/** Ask the desk agent about a thread (it has the tools to read it in full). */
function ask(t: Triaged) {
  const text = `Help me with this: ${t.ref ? `${t.ref} ` : ""}${t.title}${t.url ? ` (${t.url})` : ""}. It's on my desk because: ${t.why}. Read it, tell me the context in a few lines, and what I should do. Draft a reply if one is needed.`;
  window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: { text } }));
}

function Why({ t }: { t: Triaged }) {
  return (
    <>
      {t.severity === "high" && <span className="fg-sev" title="Missing it costs a lot">high · </span>}
      {t.why}
      {t.seen && <span className="fg-seen" title="Read in Slack; not handled yet"> · read</span>}
      {(t.bucket === "now" || t.bucket === "today") && <span className="fg-wait"> · waiting {waited(t.since)}</span>}
    </>
  );
}

/** A group's threads: what is open, then low priority and probably done, folded. */
function Section({ s, isNew, more, onMore }: { s: DeskSection; isNew: (t: Triaged) => boolean; more: boolean; onMore: () => void }) {
  const shown = more ? s.open : s.open.slice(0, SHOWN);
  return (
    <>
      {s.open.length > 0 && (
        <ul className="feed-groups">
          {shown.map((t) => (
            <Group key={t.key} g={t} why={<Why t={t} />} isNew={isNew(t)} hint={t.hint} />
          ))}
        </ul>
      )}
      {s.open.length > SHOWN && (
        <button type="button" className="lane-more" onClick={onMore}>
          {more ? "Show fewer" : `${s.open.length - SHOWN} more`}
        </button>
      )}
      {s.low.length > 0 && (
        <details className="lane is-fyi desk-fold">
          <summary className="lane-heading">
            <ChevronRight size={13} className="fg-chevron" aria-hidden />
            Low priority <span className="lane-n">{s.low.length}</span>
            <span className="lane-hint">can wait, or needs nothing from you</span>
          </summary>
          <ul className="feed-groups">
            {s.low.map((t) => (
              <Group key={t.key} g={t} why={t.why} isNew={isNew(t)} hint={t.hint} />
            ))}
          </ul>
        </details>
      )}
      {s.done.length > 0 && (
        <details className="lane is-background desk-fold">
          <summary className="lane-heading">
            <ChevronRight size={13} className="fg-chevron" aria-hidden />
            Probably done <span className="lane-n">{s.done.length}</span>
            <span className="lane-hint">jin thinks these were handled since</span>
          </summary>
          <ul className="feed-groups">
            {s.done.map((t) => (
              <Group key={t.key} g={t} why={t.staleWhy ?? "handled since"} stale />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

const count = (s: DeskSection) => s.open.length + s.low.length + s.done.length;

/** One thread at a time: what it is, why, the latest, and four ways out. */
function Focus({ queue, onExit }: { queue: Triaged[]; onExit: () => void }) {
  const [order] = useState(() => queue.map((t) => t.key));
  const [handled, setHandled] = useState<string[]>([]);
  const [, start] = useTransition();
  const byKey = new Map(queue.map((t) => [t.key, t]));
  const left = order.filter((k) => !handled.includes(k) && byKey.has(k));
  const t = left[0] ? byKey.get(left[0])! : null;
  const total = order.length;
  const done = total - left.length;

  const act = (action: "done" | "snooze") => {
    if (!t) return;
    setHandled((h) => [...h, t.key]);
    start(() => void feedSet(t.ids, action));
  };
  const skip = () => t && setHandled((h) => [...h, t.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("textarea, input, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") onExit();
      else if (!t) return;
      else if (e.key === "d") act("done");
      else if (e.key === "l") act("snooze");
      else if (e.key === "s" || e.key === "j") skip();
      else if (e.key === "o" && t.url) window.open(t.url, "_blank", "noreferrer");
      else if (e.key === "a") ask(t);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const src = t ? (SOURCE[t.source] ?? SOURCE.jin!) : null;
  return (
    <div className="focus-mode">
      <div className="focus-top">
        <span className="focus-progress" aria-label={`${done} of ${total} done`}>
          {order.map((k, i) => (
            <span key={k} className={`focus-pip${i < done ? " is-done" : i === done ? " is-now" : ""}`} />
          ))}
        </span>
        <span className="meta">{t ? `${done + 1} of ${total}` : `${total} of ${total}`}</span>
        <button type="button" className="button quiet icon-only small" onClick={onExit} title="Leave Focus (Esc)" aria-label="Leave Focus">
          <X size={14} />
        </button>
      </div>
      {t && src ? (
        <article className="focus-card" key={t.key}>
          <div className="focus-source">
            <src.Icon size={14} className={`fg-src is-${t.source}`} aria-hidden />
            <span>{src.label}</span>
            {t.ref && <span className="mono">{t.ref}</span>}
          </div>
          <h2 className="focus-title">{t.title}</h2>
          <p className="focus-why">
            <Why t={t} />
          </p>
          <ul className="focus-rows">
            {t.rows.slice(0, 4).map((r) => (
              <li key={r.id}>
                {r.actor && <span className="fg-actor">{r.actor}</span>} <span className="fg-what">{rowWhat(r)}</span>
                {r.snippet && <span className="focus-snippet">{r.snippet}</span>}
              </li>
            ))}
            {t.rows.length > 4 && <li className="meta">and {t.rows.length - 4} more</li>}
          </ul>
          <div className="focus-actions">
            {t.url && (
              <a className="button" href={t.url} target="_blank" rel="noreferrer">
                <ExternalLink size={13} /> Open <kbd>O</kbd>
              </a>
            )}
            <button type="button" className="button" onClick={() => ask(t)}>
              <MessageSquareText size={13} /> Ask the desk agent <kbd>A</kbd>
            </button>
            <span className="focus-gap" />
            <button type="button" className="button quiet" onClick={skip} title="Skip for now: it stays on your desk">
              <ArrowRight size={13} /> Skip <kbd>S</kbd>
            </button>
            <button type="button" className="button quiet" onClick={() => act("snooze")} title="Back on your desk in a day">
              <Clock size={13} /> Later <kbd>L</kbd>
            </button>
            <button type="button" className="button primary" onClick={() => act("done")}>
              <Check size={13} /> Done <kbd>D</kbd>
            </button>
          </div>
        </article>
      ) : (
        <div className="focus-card is-clear">
          <h2 className="focus-title">You&apos;re through.</h2>
          <p className="focus-why">{handled.length ? `${handled.length} handled. Nothing else is waiting on you.` : "Nothing is waiting on you."}</p>
          <div className="focus-actions">
            <button type="button" className="button" onClick={onExit}>
              Back to the desk
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ActivityDesk({ items }: { items: FeedItem[] }) {
  const router = useRouter();
  const view = useMemo(() => desk(items), [items]);
  // Focus goes through everything open, most pressing first.
  const queue = useMemo(() => [...view.now, ...view.tasks.flatMap((t) => t.open), ...view.work.open, ...view.personal.open], [view]);
  const [moreOf, setMoreOf] = useState<string[]>([]);
  const toggleMore = (k: string) => setMoreOf((m) => (m.includes(k) ? m.filter((x) => x !== k) : [...m, k]));
  const [focus, setFocus] = useState(false);
  const [lastLook, setLastLook] = useState<string | null>(null);
  const [sweeping, startSweep] = useTransition();
  const [refreshing, startRefresh] = useTransition();

  // Since you last looked: read once; this visit counts after a few seconds on the desk.
  useEffect(() => {
    setLastLook(readLastLook());
    const t = setTimeout(() => writeLastLook(new Date().toISOString()), 5000);
    return () => clearTimeout(t);
  }, []);
  const isNew = (t: Triaged) => Boolean(lastLook && t.latest > lastLook);

  const n = queue.length;
  const before = new Date(Date.now() - OLD_DAYS * 86_400_000).toISOString();
  const old = items.filter((i) => i.state === "new" && i.receivedAt < before).length;

  return (
    <section className="side-panel is-main activity-desk" aria-labelledby="activity-heading">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-name" id="activity-heading">
            Activity
          </span>
          <span className="meta">{n ? `${n} need you` : "clear"}</span>
        </div>
        <div className="pane-actions">
          {!focus && n > 0 && (
            <button type="button" className="button quiet icon-only" onClick={() => setFocus(true)} title="Focus: one thread at a time, most important first" aria-label="Focus">
              <Crosshair size={15} />
            </button>
          )}
          <button type="button" className="button quiet icon-only" disabled={refreshing} onClick={() => startRefresh(async () => { await collectGithub(); router.refresh(); })} title="Refresh: pull reviews, failing checks and mentions from GitHub" aria-label="Refresh">
            <RefreshCw size={15} className={refreshing ? "spin" : undefined} />
          </button>
        </div>
      </header>
      <div className="side-scroll" data-scroll="y">
        {focus ? (
          <Focus queue={queue} onExit={() => setFocus(false)} />
        ) : (
          <>
            {old > 0 && (
              <div className="sweep">
                <span>
                  {old} {old === 1 ? "item is" : "items are"} older than {OLD_DAYS} days.
                </span>
                <button type="button" className="button small" disabled={sweeping} onClick={() => startSweep(async () => { await sweepFeed(before); router.refresh(); })}>
                  {sweeping ? "Clearing…" : "Clear them"}
                </button>
              </div>
            )}

            {view.now.length > 0 && (
              <div className="lane is-needs desk-now">
                <h3 className="lane-heading">
                  Needs you now <span className="lane-n">{view.now.length}</span>
                </h3>
                <ul className="feed-groups">
                  {view.now.map((t) => (
                    <Group key={t.key} g={t} why={<Why t={t} />} isNew={isNew(t)} hint={t.hint} />
                  ))}
                </ul>
              </div>
            )}

            {view.tasks
              .filter((t) => count(t) > 0)
              .map((t) => (
                <div key={`${t.machine}:${t.taskId}`} className="lane desk-group is-task">
                  <h3 className="lane-heading">
                    <Link href={t.machine === "local" ? `/t/${t.taskId}` : `/m/${t.machine}/t/${t.taskId}`} className="desk-task-link">
                      {t.taskId}
                    </Link>
                    <span className="desk-task-title">{t.title}</span> <span className="lane-n">{t.open.length}</span>
                  </h3>
                  <Section s={t} isNew={isNew} more={moreOf.includes(t.taskId)} onMore={() => toggleMore(t.taskId)} />
                </div>
              ))}

            {(["work", "personal"] as const).map((g) =>
              count(view[g]) > 0 || g === "work" ? (
                <div key={g} className={`lane desk-group is-${g}`}>
                  <h3 className="lane-heading">
                    {g === "work" ? "Work" : "Personal"} <span className="lane-n">{view[g].open.length}</span>
                  </h3>
                  {g === "work" && count(view.work) === 0 && n === 0 ? (
                    <Empty>You&apos;re clear. New things that need you land here first.</Empty>
                  ) : (
                    <Section s={view[g]} isNew={isNew} more={moreOf.includes(g)} onMore={() => toggleMore(g)} />
                  )}
                </div>
              ) : null,
            )}
          </>
        )}
      </div>
    </section>
  );
}
