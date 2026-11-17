"use client";
import { Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { listRepos, startReview, startTaskJob } from "@/app/actions";
import type { Repo } from "@/lib/daemon";

const TYPES = ["bug", "feature", "enhancement", "refactor", "patch"] as const;

/** "+" next to Tasks: create a task with the workspace's own tooling, set up in the background. */
export function NewTaskButton() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // Cmd/Ctrl+Shift+N, outside the terminal and editor.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n" && !(e.target instanceof Element && e.target.closest(".xterm, .monaco-editor"))) {
        e.preventDefault();
        setOpen(true);
      }
    };
    const fromPalette = () => setOpen(true);
    window.addEventListener("keydown", key);
    window.addEventListener("jin:new-task", fromPalette);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("jin:new-task", fromPalette);
    };
  }, []);
  return (
    <>
      <button type="button" className="nav-section-action" onClick={() => setOpen(true)} title="New task (⌘⇧N)" aria-label="New task">
        <Plus size={13} />
      </button>
      {open && <NewTaskDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function NewTaskDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const idInput = useRef<HTMLInputElement>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<"linear" | "review">("linear");
  const [prLinks, setPrLinks] = useState("");
  const [reviewSetup, setReviewSetup] = useState(false);
  const [links, setLinks] = useState("");
  const [id, setId] = useState("");
  const [slug, setSlug] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("bug");
  const [setup, setSetup] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
    // showModal focuses the first control (the close button); the Task ID is where you start.
    idInput.current?.focus();
    void listRepos().then(setRepos, (e) => setError(String(e)));
  }, []);

  const toggle = (name: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (kind === "review") {
      const r = await startReview(prList, prompt.trim() || undefined, reviewSetup, linkList);
      setBusy(false);
      if ("error" in r) return setError(r.error);
      onClose();
      return router.push(`/t/${encodeURIComponent(r.taskId)}`);
    }
    const res = await startTaskJob({ id: id.trim(), slug: slug.trim(), type, repos: [...picked], setup, prompt: prompt.trim() || undefined, links: linkList });
    setBusy(false);
    if ("error" in res) return setError(res.error);
    onClose();
    router.push(`/t/${encodeURIComponent(res.job.taskId)}`);
  };

  // PR links (or repo#123), one per line or separated by spaces.
  const linkList = links.split(/\s+/).map((l) => l.trim()).filter(Boolean);
  const prList = prLinks.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
  const valid = kind === "review" ? prList.length > 0 : /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id.trim()) && slug.trim() && picked.size > 0;
  return (
    <dialog ref={dialog} className="modal" onClose={onClose} onCancel={onClose} aria-labelledby="new-task-title">
      <form className="modal-body" onSubmit={submit}>
        <header className="modal-header">
          <h2 id="new-task-title">New task</h2>
          <button type="button" className="button quiet icon-only" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </header>
        <div className="segmented" role="tablist" aria-label="Kind of task">
          <button type="button" role="tab" aria-selected={kind === "linear"} className={kind === "linear" ? "is-active" : ""} onClick={() => setKind("linear")}>
            Linear change
          </button>
          <button type="button" role="tab" aria-selected={kind === "review"} className={kind === "review" ? "is-active" : ""} onClick={() => setKind("review")}>
            Review PRs
          </button>
        </div>
        {kind === "review" ? (
          <>
            <label className="field">
              <span>Pull requests (links or repo#123, one per repo)</span>
              <textarea value={prLinks} onChange={(e) => setPrLinks(e.target.value)} rows={3} placeholder={"https://github.com/ComposioHQ/platform/pull/123\nmercury#45"} autoFocus />
            </label>
            <p className="meta">The task is numbered REV-&lt;month&gt;&lt;day&gt;&lt;n&gt;, each repo checked out at its PR&apos;s head; skills tagged pr-review come with it. Already reviewing these PRs? That task opens.</p>
          </>
        ) : (
        <>
        <div className="field-row">
          <label className="field">
            <span>Task ID</span>
            <input ref={idInput} value={id} onChange={(e) => setId(e.target.value)} placeholder="PLEN-123" required />
          </label>
          <label className="field">
            <span>Type</span>
            <select value={type} onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}>
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Title</span>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="Retry webhooks with backoff" required />
        </label>
        <fieldset className="field">
          <legend>Repos</legend>
          {repos === null ? (
            <p className="meta">Loading…</p>
          ) : (
            <div className="repo-picker" data-scroll="y">
              {repos.map((r) => (
                <label key={r.name} className={`repo-option ${picked.has(r.name) ? "is-picked" : ""}`} title={r.description}>
                  <input type="checkbox" checked={picked.has(r.name)} onChange={() => toggle(r.name)} />
                  <span className="mono">{r.name}</span>
                  <span className="meta">{r.description}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        </>
        )}
        <label className="field">
          <span>Follow (optional): Slack threads or channels, Notion pages, one URL per line</span>
          <textarea value={links} onChange={(e) => setLinks(e.target.value)} rows={2} placeholder={"https://acme.slack.com/archives/C0123/p1700000000123456\nhttps://www.notion.so/acme/Launch-plan-1a2b…"} />
        </label>
        <label className="field">
          <span>First prompt for Claude Code (optional)</span>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder={kind === "review" ? "Defaults to: review the pull requests in this task" : "What should Claude Code start on once the task is ready?"} />
        </label>
        {kind === "linear" ? (
          <label className="check">
            <input type="checkbox" checked={setup} onChange={(e) => setSetup(e.target.checked)} />
            <span>Run each repo's setup (installs; can take a few minutes)</span>
          </label>
        ) : (
          <label className="check">
            <input type="checkbox" checked={reviewSetup} onChange={(e) => setReviewSetup(e.target.checked)} />
            <span>Install dependencies now (otherwise Claude installs a repo, or brings the stack up, only if the review needs it)</span>
          </label>
        )}
        {error && <p className="field-error">{error}</p>}
        <footer className="modal-footer">
          <button type="button" className="button quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!valid || busy}>
            {busy ? "Creating…" : kind === "review" ? "Start review" : "Create task"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
