import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The three states a view is in before it has something to show, one look each everywhere:
 * Loading, Empty (nothing yet; what will be here, and how to start), and a view's own failure
 * (ErrorView). `place`: a whole pane ("pane", centred) or a side panel ("panel", top-left).
 */

export function Loading({ label = "Loading…", place = "panel" }: { label?: string; place?: "panel" | "pane" }) {
  return (
    <div className={`view-state is-${place} is-loading`} role="status" aria-live="polite">
      <span className="view-state-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Empty({ icon: Icon, title, children, action, place = "panel" }: { icon?: LucideIcon; title?: string; children?: ReactNode; action?: ReactNode; place?: "panel" | "pane" }) {
  return (
    <div className={`view-state is-${place}`}>
      {Icon && <Icon size={place === "pane" ? 28 : 18} className="view-state-icon" />}
      {title && <p className="view-state-title">{title}</p>}
      {children && <div className="view-state-body">{children}</div>}
      {action && <div className="view-state-action">{action}</div>}
    </div>
  );
}

/** A view that could not load its content (not a crash: the Boundary has those). */
export function Failed({ message, retry, place = "panel" }: { message: string; retry?: () => void; place?: "panel" | "pane" }) {
  return (
    <div className={`view-state is-${place} is-failed`} role="alert">
      <span className="view-state-message">{message.replace(/^(GET|POST|PUT|PATCH|DELETE) \S+: /, "")}</span>
      {retry && (
        <button type="button" className="button small" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
