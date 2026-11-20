"use client";
import { Failed } from "@/components/States";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getDiff } from "@/lib/actions";
import type { RepoDiff } from "@/lib/daemon";

function lineClass(l: string): string {
  if (l.startsWith("+++") || l.startsWith("---")) return "d-file";
  if (l.startsWith("@@")) return "d-hunk";
  if (l.startsWith("+")) return "d-add";
  if (l.startsWith("-")) return "d-del";
  if (l.startsWith("diff --git")) return "d-head";
  return "";
}

/** Uncommitted changes in each of the task's repos. */
export function DiffView({ taskId, active }: { taskId: string; active: boolean }) {
  const [repos, setRepos] = useState<RepoDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setRepos(await getDiff(taskId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [taskId]);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  return (
    <div className="diff-view" data-scroll="y">
      <div className="editor-bar">
        <span className="editor-path">Changes</span>
        <button type="button" className="button quiet" onClick={() => void load()}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>
      {error && <Failed message={error} retry={() => void load()} />}
      {repos?.map((r) => (
        <section key={r.repo} className="diff-repo">
          <h3>
            {r.repo} <span className="meta">{r.branch}</span>
          </h3>
          {!r.diff && !r.untracked.length ? (
            <p className="meta">No changes.</p>
          ) : (
            <>
              {r.untracked.length > 0 && <p className="meta">New files: {r.untracked.join(", ")}</p>}
              <pre className="diff-body">
                {r.diff.split("\n").map((l, i) => (
                  <div key={i} className={lineClass(l)}>
                    {l || " "}
                  </div>
                ))}
              </pre>
            </>
          )}
        </section>
      ))}
    </div>
  );
}
