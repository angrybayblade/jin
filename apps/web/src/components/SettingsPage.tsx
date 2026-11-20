import type { ReactNode } from "react";

/**
 * A settings-style page (Machines' look): a header with its name, a line on what it is and its
 * actions, then one scrolling column of cards. One frame for every such page.
 */
export function SettingsPage({ title, meta, actions, wide = false, children }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className="machines">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-name">{title}</span>
          {meta && <span className="meta">{meta}</span>}
        </div>
        {actions}
      </header>
      <div className="machines-body is-single" data-scroll="y">
        <main className="machines-main">
          <article className={`machine-detail${wide ? " is-wide" : ""}`}>{children}</article>
        </main>
      </div>
    </div>
  );
}
