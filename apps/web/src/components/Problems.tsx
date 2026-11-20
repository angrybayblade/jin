"use client";
import { SettingsPage } from "./SettingsPage";
import { Empty } from "@/components/States";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { clearProblems } from "@/lib/actions";
import type { Problem } from "@/lib/daemon";
import { act } from "@/lib/notices";

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

/** Background failures per machine: what jin was doing, what it said, how often, when last. */
export function ProblemsPage({ groups }: { groups: { id: string; label: string; problems: Problem[]; error: string | null }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const total = groups.reduce((n, g) => n + g.problems.length, 0);
  return (
    <SettingsPage title="Problems" meta={<>what jin did in the background that failed: syncing PRs, tunnels, lookups</>} actions={<>
      <button type="button" className="button small quiet" onClick={() => router.refresh()}>
        Refresh
      </button>
      </>}>
        {!total && !groups.some((g) => g.error) && <Empty title="No problems">Nothing has failed in the background since jin last started.</Empty>}
        {groups.map((g) =>
          !g.problems.length && !g.error ? null : (
            <section key={g.id} className="md-card">
              <div className="md-card-head is-static">
                <span className="md-card-title">{g.label}</span>
                {g.problems.length > 0 && (
                  <button
                    type="button"
                    className="button small quiet"
                    disabled={busy === g.id}
                    onClick={async () => {
                      setBusy(g.id);
                      await act(`Couldn't clear ${g.label}'s problems`, () => clearProblems(g.id));
                      setBusy(null);
                      router.refresh();
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              {g.error && <p className="machine-error">Not answering: {g.error}</p>}
              <ul className="problems-list">
                {g.problems.map((p) => (
                  <li key={`${p.scope}:${p.message}`}>
                    <span className="problems-scope">{p.scope}</span>
                    <span className="problems-message">{p.message}</span>
                    <span className="meta">
                      {p.count > 1 ? `${p.count} times, since ${ago(p.firstAt)} · ` : ""}
                      {ago(p.lastAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ),
        )}
    </SettingsPage>
  );
}
