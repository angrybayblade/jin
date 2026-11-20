"use client";
import { ClipboardCopy, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Link2Off, Plus, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { attachTaskPr, detachTaskPr, openInBobby, refreshTaskPrs } from "@/lib/actions";
import type { TaskPR } from "@/lib/daemon";
import { contextMenu, type MenuItem } from "../ContextMenu";
import { RenameInput } from "../RenameInput";

const ICON = { MERGED: GitMerge, CLOSED: GitPullRequestClosed } as const;

function describe(p: TaskPR): string {
  const state = p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : p.draft ? "draft" : "open";
  const review = p.review === "APPROVED" ? "approved" : p.review === "CHANGES_REQUESTED" ? "changes requested" : p.review === "REVIEW_REQUIRED" ? "review requested" : null;
  const checks = p.checks ? `checks ${p.checks}` : null;
  return [`${p.repo}#${p.number}`, p.title, [state, review, checks].filter(Boolean).join(" · "), `attached by ${p.attachedBy === "hook" ? "jin (Claude Code created it)" : p.attachedBy === "claude" ? "Claude Code" : "you"}`].filter(Boolean).join("\n");
}

/** Open a PR's review in Bobby in your browser, or the PR on GitHub when Bobby is not available. */
async function openPr(url: string) {
  const res = await openInBobby(url);
  if ("error" in res) window.open(url, "_blank", "noopener");
}

/** The task's pull requests as small badges in the task bar; right-click the task label to attach one. */
export function TaskPRBadges({ taskId, prs }: { taskId: string; prs: TaskPR[] }) {
  const router = useRouter();
  const menu = (p: TaskPR): MenuItem[] => [
    { header: `${p.repo}#${p.number}` },
    { label: "Review in Bobby", icon: GitPullRequest, run: () => openPr(p.url) },
    { label: "Open on GitHub", icon: ExternalLink, run: () => void window.open(p.url, "_blank", "noopener") },
    { label: "Copy link", icon: ClipboardCopy, run: () => void navigator.clipboard?.writeText(p.url) },
    { label: "Refresh", icon: RefreshCw, run: () => refreshTaskPrs(taskId).then(() => router.refresh()) },
    { divider: true },
    { label: "Detach from the task", icon: Link2Off, run: () => detachTaskPr(taskId, p.url).then(() => router.refresh()) },
  ];
  if (!prs.length) return null;
  return (
    <span className="task-prs">
      {prs.map((p) => {
        const Icon = p.state && p.state in ICON ? ICON[p.state as keyof typeof ICON] : p.draft ? GitPullRequestDraft : GitPullRequest;
        const tone = p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : p.checks === "failing" || p.review === "CHANGES_REQUESTED" ? "attention" : p.review === "APPROVED" ? "approved" : "open";
        return (
          <button key={p.url} type="button" className={`pr-badge is-${tone}`} title={describe(p)} onClick={() => void openPr(p.url)} {...contextMenu(() => menu(p))}>
            <Icon size={12} />
            <span>#{p.number}</span>
            {p.checks && p.state === "OPEN" && <span className={`pr-checks is-${p.checks}`} aria-label={`checks ${p.checks}`} />}
          </button>
        );
      })}
    </span>
  );
}

/** The task label; right-click to attach a pull request by hand. */
export function TaskLabel({ taskId, subtitle }: { taskId: string; subtitle: string }) {
  const router = useRouter();
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (attaching)
    return (
      <span className="task-label is-attaching">
        <RenameInput
          value=""
          label="Pull request link to attach"
          onCancel={() => setAttaching(false)}
          onSave={(url) => {
            setAttaching(false);
            void attachTaskPr(taskId, url).then((r) => ("error" in r ? setError(r.error) : (setError(null), router.refresh())));
          }}
        />
      </span>
    );
  return (
    <span
      className="task-label"
      title={error ?? `${taskId} · ${subtitle}\nRight-click to attach a pull request`}
      data-error={error ? "" : undefined}
      {...contextMenu(() => [
        { header: taskId },
        { label: "Attach a pull request…", icon: Plus, run: () => setAttaching(true) },
        { label: "Refresh pull requests", icon: RefreshCw, run: () => refreshTaskPrs(taskId).then(() => router.refresh()) },
        { label: "Copy task id", icon: ClipboardCopy, run: () => void navigator.clipboard?.writeText(taskId) },
      ])}
    >
      <strong>{taskId}</strong>
      <span>{subtitle}</span>
    </span>
  );
}
