"use client";
import { ExternalLink, FileText, LoaderCircle, RefreshCw, Search, Unlink } from "lucide-react";
import { useEffect, useState } from "react";
import { liveConnect, notionConnections, notionPages, syncDocToNotion, unlinkDocFromNotion } from "@/lib/actions";
import type { NotionConnection, NotionLink, NotionTarget } from "@/lib/daemon";

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const named = (c: NotionConnection) => c.workspace ?? c.label;

/**
 * Syncing a doc to Notion, by hand: once linked, Sync now replaces the page's title and content
 * with the doc's; before that, pick a connection and the page to put it under.
 */
export function NotionPanel({ docId, version, link, flush, onLink }: { docId: string; version: number; link: NotionLink | null | undefined; flush: () => Promise<void>; onLink: (l: NotionLink | null) => void }) {
  const [busy, setBusy] = useState<"sync" | "unlink" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const sync = async (o: { account?: string; parentId?: string } = {}) => {
    setBusy("sync");
    setError(null);
    await flush();
    const r = await syncDocToNotion(docId, o);
    setBusy(null);
    if ("error" in r) return setError(r.error);
    onLink(r);
  };
  if (link === undefined) return <p className="meta doc-empty">Loading…</p>;
  if (!link) return <NotionPick busy={busy === "sync"} error={error} onSync={(account, parentId) => void sync({ account, parentId })} />;
  const behind = version > link.syncedVersion;
  const unlink = async () => {
    if (!armed) return setArmed(true);
    setBusy("unlink");
    const r = await unlinkDocFromNotion(docId);
    setBusy(null);
    setArmed(false);
    if (r?.error) return setError(r.error);
    onLink(null);
  };
  return (
    <div className="doc-notion">
      <div className={`doc-notion-state ${behind ? "is-behind" : ""}`}>
        <span className="doc-notion-dot" />
        <div>
          <strong>{behind ? "Changed since the last sync" : "In Notion"}</strong>
          <span className="meta">
            synced v{link.syncedVersion} {ago(link.syncedAt)}
            {behind ? ` · the doc is at v${version}` : ""}
          </span>
        </div>
      </div>
      {error && <p className="doc-notion-error">{error}</p>}
      <div className="doc-notion-actions">
        <button type="button" className="button small primary" disabled={busy !== null} onClick={() => void sync()}>
          {busy === "sync" ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} Sync now
        </button>
        {link.url && (
          <a className="button small" href={link.url} target="_blank" rel="noreferrer">
            <ExternalLink size={13} /> Open in Notion
          </a>
        )}
        <button type="button" className={`button small quiet ${armed ? "is-armed" : ""}`} disabled={busy !== null} onClick={() => void unlink()} title="Forget the page; it stays in Notion">
          <Unlink size={13} /> {armed ? "Click again to unlink" : "Unlink"}
        </button>
      </div>
      <p className="meta doc-notion-note">
        Sync now replaces the Notion page&apos;s title and content with this doc&apos;s. Nothing syncs on its own, and edits made in Notion do not come back; unlinking leaves the page in Notion.
      </p>
    </div>
  );
}

/** Before the first sync: a Notion connection, and a page under it to put the doc in. */
function NotionPick({ busy, error, onSync }: { busy: boolean; error: string | null; onSync: (account: string, parentId: string) => void }) {
  const [conns, setConns] = useState<NotionConnection[] | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [account, setAccount] = useState<string>("");
  const [q, setQ] = useState("");
  const [pages, setPages] = useState<NotionTarget[] | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [parent, setParent] = useState<NotionTarget | null>(null);
  useEffect(() => {
    void notionConnections().then((r) => {
      if ("error" in r) return (setConnError(r.error), setConns([]));
      setConns(r);
      setAccount((a) => a || r.find((c) => c.active)?.id || "");
    });
  }, []);
  useEffect(() => {
    if (!account) return;
    setPages(null);
    setPageError(null);
    const t = setTimeout(
      () =>
        void notionPages(account, q).then((r) => {
          if ("error" in r) return (setPageError(r.error), setPages([]));
          setPages(r);
        }),
      q ? 350 : 0,
    );
    return () => clearTimeout(t);
  }, [account, q]);
  useEffect(() => setParent(null), [account]);
  const active = (conns ?? []).filter((c) => c.active);
  return (
    <div className="doc-notion">
      <p className="meta doc-notion-note">Put this doc in Notion as a page. It syncs only when you press Sync; nothing comes back from Notion.</p>
      {error && <p className="doc-notion-error">{error}</p>}
      <label className="doc-notion-label">Connection</label>
      {conns === null && (
        <p className="meta">
          <LoaderCircle size={12} className="spin" /> Reading your Notion connections…
        </p>
      )}
      {connError && <p className="doc-notion-error">{connError}</p>}
      {conns && !active.length && !connError && (
        <div className="doc-notion-actions">
          <span className="meta">No Notion connection yet.</span>
          <button type="button" className="button small" onClick={() => void liveConnect("notion").then((r) => ("error" in r ? setConnError(r.error) : window.open(r.url, "_blank", "noreferrer")))}>
            <ExternalLink size={13} /> Connect Notion
          </button>
        </div>
      )}
      {active.length > 0 && (
        <select className="machine-input doc-notion-select" value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Notion connection">
          {active.map((c) => (
            <option key={c.id} value={c.id}>
              {named(c)}
              {c.email ? ` · ${c.email}` : ""}
            </option>
          ))}
        </select>
      )}
      {account && (
        <>
          <label className="doc-notion-label">Put it under</label>
          <div className="doc-notion-search">
            <Search size={13} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Notion pages by title" aria-label="Search Notion pages" spellCheck={false} />
          </div>
          {pageError && <p className="doc-notion-error">{pageError}</p>}
          {pages === null && (
            <p className="meta">
              <LoaderCircle size={12} className="spin" /> Looking…
            </p>
          )}
          {pages && !pages.length && !pageError && <p className="meta">{q ? "No page by that title is shared with this connection." : "No pages are shared with this connection yet."}</p>}
          {pages && pages.length > 0 && (
            <ul className="doc-notion-pages">
              {pages.map((p) => (
                <li key={p.id}>
                  <button type="button" className={`doc-notion-page ${parent?.id === p.id ? "is-picked" : ""}`} onClick={() => setParent(p)} aria-pressed={parent?.id === p.id}>
                    <span className="doc-notion-icon">{p.icon ?? <FileText size={13} />}</span>
                    <span className="doc-notion-title">{p.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="button small primary doc-notion-go" disabled={!parent || busy} onClick={() => parent && onSync(account, parent.id)}>
            {busy ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} {parent ? `Sync to a page under ${parent.title}` : "Pick a page to put it under"}
          </button>
        </>
      )}
    </div>
  );
}
