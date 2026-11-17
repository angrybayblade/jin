"use client";
import { CircleDot, FileText, GitPullRequest, Hash, MessageSquare, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { addTaskLink, getActivity, removeTaskLink } from "@/app/actions";
import type { TaskActivity, TaskLink } from "@/lib/daemon";
import { FeedThreads } from "../TodayPanel";

const ICON: Record<TaskLink["kind"], typeof Hash> = { github: GitPullRequest, linear: CircleDot, "slack-thread": MessageSquare, "slack-channel": Hash, notion: FileText };

/**
 * What happened on what the task follows: its PRs and Linear issue (linked by themselves), and
 * Slack threads and channels and Notion pages you link. Exact threads only; nothing is guessed.
 */
export function ActivityPanel({ taskId }: { taskId: string }) {
  const [a, setA] = useState<TaskActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void getActivity(taskId).then((r) => ("error" in r ? setError(r.error) : (setA(r), setError(null))));
  }, [taskId]);
  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    const r = await addTaskLink(taskId, url.trim());
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setUrl("");
    load();
  };
  const remove = async (l: TaskLink) => {
    const r = await removeTaskLink(taskId, l.key);
    if ("error" in r) setError(r.error);
    load();
  };

  return (
    <div className="act-panel" data-scroll="y">
      <div className="act-links">
        {(a?.links ?? []).map((l) => {
          const Icon = ICON[l.kind];
          const label = l.kind === "slack-channel" ? `${l.label} · threads from ${new Date(l.since ?? l.addedAt).toLocaleDateString()}` : l.label;
          return (
            <span key={l.key} className="act-link" title={`${l.key}${l.how === "manual" ? "" : l.how === "pr" ? " · a PR of this task" : " · this task's issue"}`}>
              <Icon size={11} />
              {l.url ? (
                <a href={l.url} target="_blank" rel="noreferrer">
                  {label}
                </a>
              ) : (
                <span>{label}</span>
              )}
              {l.how === "manual" && (
                <button type="button" className="act-unlink" onClick={() => void remove(l)} aria-label={`Unlink ${l.label}`} title="Unlink">
                  <X size={10} />
                </button>
              )}
            </span>
          );
        })}
      </div>
      <form className="act-add" onSubmit={add}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link a Slack thread or channel, or a Notion page (paste its URL)" aria-label="Link to follow" />
        <button type="submit" className="button small" disabled={busy || !url.trim()}>
          Link
        </button>
      </form>
      {error && <p className="machine-error act-error">{error}</p>}
      {a === null && !error ? (
        <p className="meta act-empty">Loading…</p>
      ) : a && a.items.length === 0 ? (
        <p className="meta act-empty">Nothing yet. Events on the PRs, the issue and what you link show here.</p>
      ) : (
        a && <FeedThreads items={a.items} />
      )}
    </div>
  );
}
