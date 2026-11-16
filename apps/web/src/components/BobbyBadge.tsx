"use client";
import { useState } from "react";
import { openInBobby } from "@/app/actions";

/**
 * Opens a pull request's review in Bobby (a focus-first PR reviewer) in a new tab, starting
 * Bobby if it is not running. The tab is opened on click, before Bobby answers, so the
 * browser does not treat it as a pop-up.
 */
export function BobbyBadge({ pr, compact = false }: { pr: string; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    const tab = window.open("about:blank", "_blank");
    setBusy(true);
    setError(null);
    const res = await openInBobby(pr);
    setBusy(false);
    if ("error" in res) {
      tab?.close();
      setError(res.error);
      return;
    }
    if (tab) {
      tab.opener = null;
      tab.location.href = res.url;
    } else window.open(res.url, "_blank", "noopener");
  };
  return (
    <button
      type="button"
      className={`bobby-badge ${compact ? "is-compact" : ""} ${busy ? "is-busy" : ""}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void open();
      }}
      title={error ?? "Review in Bobby (opens a new tab)"}
      aria-label="Review this pull request in Bobby"
      data-error={error ? "" : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/bobby.svg" alt="" width={14} height={14} />
      {!compact && <span>{busy ? "Opening…" : error ? "Bobby unavailable" : "Bobby"}</span>}
    </button>
  );
}
