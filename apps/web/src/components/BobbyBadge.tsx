"use client";
import { useState } from "react";
import { openInBobby } from "@/app/actions";

/**
 * Opens a pull request's review in Bobby (a focus-first PR reviewer) in your browser, starting
 * Bobby if it is not running.
 */
export function BobbyBadge({ pr, compact = false }: { pr: string; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true);
    setError(null);
    const res = await openInBobby(pr);
    setBusy(false);
    if ("error" in res) setError(res.error);
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
      title={error ?? "Review in Bobby (opens your browser)"}
      aria-label="Review this pull request in Bobby"
      data-error={error ? "" : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/bobby.svg" alt="" width={14} height={14} />
      {!compact && <span>{busy ? "Opening…" : error ? "Bobby unavailable" : "Bobby"}</span>}
    </button>
  );
}
