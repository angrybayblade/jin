import Link from "next/link";

/** Something asked for that is not there: one look for a missing task, doc or page. */
export function Missing({ title, body }: { title: string; body?: string }) {
  return (
    <main className="page-error">
      <div className="error-view">
        <p className="error-view-title">{title}</p>
        {body && <p className="error-view-message">{body}</p>}
        <div className="error-view-actions">
          <Link href="/" className="button primary small">
            Go to jin
          </Link>
        </div>
      </div>
    </main>
  );
}
