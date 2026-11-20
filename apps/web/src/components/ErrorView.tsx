"use client";
import { AlertTriangle, Check, Copy, RotateCcw } from "lucide-react";
import { useState } from "react";

/** In production, Next replaces a server error's message with this: the real one is in the server's log. */
const HIDDEN = /An error occurred in the Server Components render|omitted in production/i;

/** What went wrong and what you can do: try again, go back, copy the details. One look for pages and panels. */
export function ErrorView({ title, error, retry, back = false, compact = false }: { title: string; error: unknown; retry?: () => void; back?: boolean; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const e = error as (Error & { digest?: string }) | undefined;
  const raw = e instanceof Error ? e.message : error ? String(error) : "";
  const hidden = HIDDEN.test(raw);
  const message = hidden ? "The server hit an error. Its log (~/.jin/logs/web.log) has the details." : raw.replace(/^(GET|POST|PUT|PATCH|DELETE) \S+: /, "");
  const details = [raw, e?.digest ? `digest ${e.digest}` : "", e?.stack && !hidden ? e.stack.split("\n").slice(0, 8).join("\n") : ""].filter(Boolean).join("\n\n");
  return (
    <div className={`error-view ${compact ? "is-compact" : ""}`} role="alert">
      <AlertTriangle size={compact ? 18 : 28} className="error-view-icon" />
      <p className="error-view-title">{title}</p>
      {message && <p className="error-view-message">{message}</p>}
      <div className="error-view-actions">
        {retry && (
          <button type="button" className="button primary small" onClick={retry}>
            <RotateCcw size={13} /> Try again
          </button>
        )}
        {back && (
          <button type="button" className="button small" onClick={() => history.back()}>
            Back
          </button>
        )}
        {details && (
          <button
            type="button"
            className="button quiet small"
            onClick={() => {
              void navigator.clipboard?.writeText(details);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />} Copy details
          </button>
        )}
      </div>
    </div>
  );
}
