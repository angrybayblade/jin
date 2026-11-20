"use client";
import { AlertTriangle, Info, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { dismissNotice, messageOf, notice, subscribeNotices, type Notice } from "@/lib/notices";

/**
 * Where failed actions are said (bottom right). Also the net under everything: a promise that
 * failed with nobody waiting on it (an action fired with `void`) is shown here, not lost.
 */
export function Notices() {
  const [list, setList] = useState<Notice[]>([]);
  useEffect(() => subscribeNotices(setList), []);
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      const m = messageOf(e.reason);
      // The browser's own noise (a navigation cancelling a fetch) is not a failure of yours.
      if (/abort|cancel|NEXT_REDIRECT|NEXT_NOT_FOUND|Failed to fetch RSC/i.test(m)) return;
      notice("error", "Something didn't finish", { detail: m });
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, []);
  if (!list.length) return null;
  return (
    <div className="notices" aria-live="polite">
      {list.map((n) => (
        <div key={n.id} className={`notice is-${n.tone}`} role={n.tone === "error" ? "alert" : "status"}>
          {n.tone === "error" ? <AlertTriangle size={14} className="notice-icon" /> : <Info size={14} className="notice-icon" />}
          <div className="notice-body">
            <p className="notice-text">{n.text}</p>
            {n.detail && <p className="notice-detail">{n.detail}</p>}
          </div>
          {n.retry && (
            <button
              type="button"
              className="button quiet small"
              onClick={() => {
                dismissNotice(n.id);
                void n.retry?.();
              }}
            >
              <RotateCcw size={12} /> Retry
            </button>
          )}
          <button type="button" className="button quiet icon-only notice-close" onClick={() => dismissNotice(n.id)} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
