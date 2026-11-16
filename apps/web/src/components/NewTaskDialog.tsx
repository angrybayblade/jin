"use client";
import { Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { listRepos, startTaskJob } from "@/app/actions";
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
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
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
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [id, setId] = useState("");
  const [slug, setSlug] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("bug");
  const [setup, setSetup] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
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
    const res = await startTaskJob({ id: id.trim(), slug: slug.trim(), type, repos: [...picked], setup, prompt: prompt.trim() || undefined });
    setBusy(false);
    if ("error" in res) return setError(res.error);
    onClose();
    router.push(`/t/${encodeURIComponent(res.job.taskId)}`);
  };

  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id.trim()) && slug.trim() && picked.size > 0;
  return (
    <dialog ref={dialog} className="modal" onClose={onClose} onCancel={onClose} aria-labelledby="new-task-title">
      <form className="modal-body" onSubmit={submit}>
        <header className="modal-header">
          <h2 id="new-task-title">New task</h2>
          <button type="button" className="button quiet icon-only" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </header>
        <div className="field-row">
          <label className="field">
            <span>Task ID</span>
            <input value={id} onChange={(e) => setId(e.target.value)} placeholder="PLEN-123" autoFocus required />
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
        <label className="field">
          <span>First prompt for Claude Code (optional)</span>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="What should Claude Code start on once the task is ready?" />
        </label>
        <label className="check">
          <input type="checkbox" checked={setup} onChange={(e) => setSetup(e.target.checked)} />
          <span>Run each repo's setup (installs; can take a few minutes)</span>
        </label>
        {error && <p className="field-error">{error}</p>}
        <footer className="modal-footer">
          <button type="button" className="button quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!valid || busy}>
            {busy ? "Creating…" : "Create task"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
