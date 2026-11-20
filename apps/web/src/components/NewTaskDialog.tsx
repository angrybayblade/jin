"use client";
import { Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { listRepos, listTaskKinds, startReview, startTaskJob, taskTitle } from "@/lib/actions";
import type { Repo, TaskKindSpec, TrackerView } from "@/lib/daemon";
import { taskHref } from "@/lib/paths";

type Target = { id: string; label: string };

/** "+" next to Tasks: create a task with the workspace's own tooling, set up in the background. */
/** `targets`: the machines a task can go on (with a workspace); `here`: the page's machine, the default. */
export function NewTaskButton({ targets = [], here = "local" }: { targets?: Target[]; here?: string }) {
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
      {open && <NewTaskDialog targets={targets} initial={targets.some((t) => t.id === here) ? here : (targets[0]?.id ?? "local")} onClose={() => setOpen(false)} />}
    </>
  );
}

function NewTaskDialog({ targets, initial, onClose }: { targets: Target[]; initial: string; onClose: () => void }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const idInput = useRef<HTMLInputElement>(null);
  const [machine, setMachine] = useState(initial);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // The kinds of task the workspace runs (its provider says), the first by default.
  const [kinds, setKinds] = useState<TaskKindSpec[] | null>(null);
  // The workspace's issue tracker (null: its tasks have no issues).
  const [tracker, setTracker] = useState<TrackerView | null>(null);
  const [kind, setKind] = useState<"change" | "review" | "scratch">("change");
  const scratch = kind === "scratch";
  const spec = kinds?.find((k) => k.id === kind);
  const [prLinks, setPrLinks] = useState("");
  const [reviewSetup, setReviewSetup] = useState(false);
  const [links, setLinks] = useState("");
  const [id, setId] = useState("");
  const [slug, setSlug] = useState("");
  const [type, setType] = useState("");
  const [setup, setSetup] = useState(true);
  const [prompt, setPrompt] = useState("");
  // Where the task starts: a Claude Code session, or its agent room (remembered).
  const [startIn, setStartInState] = useState<"claude" | "room">("claude");
  useEffect(() => {
    try {
      if (localStorage.getItem("jin-task-start") === "room") setStartInState("room");
    } catch {}
  }, []);
  const setStartIn = (v: "claude" | "room") => {
    setStartInState(v);
    try {
      localStorage.setItem("jin-task-start", v);
    } catch {}
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
    // showModal focuses the first control (the close button); the Task ID is where you start.
    idInput.current?.focus();
  }, []);
  // The chosen machine's repos and kinds of task.
  useEffect(() => {
    setRepos(null);
    setPicked(new Set());
    void listRepos(undefined, machine).then(setRepos, (e) => setError(String(e)));
    void listTaskKinds(machine).then(({ kinds: k, tracker: t }) => {
      setKinds(k);
      setTracker(t);
      setKind((cur) => (k.some((x) => x.id === cur) ? cur : (k[0]?.id ?? "change")));
    }, () => (setKinds([]), setTracker(null)));
  }, [machine]);

  // Without a title, the task takes its issue's (when its id is one) or its first PR's: shown as you type.
  const [suggested, setSuggested] = useState<{ title: string; from: "issue" | "pr" } | null>(null);
  const [looking, setLooking] = useState(false);
  useEffect(() => {
    setSuggested(null);
    const tid = id.trim();
    const refs = links.split(/\s+/).filter((l) => /github\.com\/[^/]+\/[^/]+\/pull\/\d+|^[\w.-]+#\d+$/.test(l));
    if (kind !== "change" || ((!spec?.idIsIssue || !tid) && !refs.length)) return;
    let live = true;
    setLooking(true);
    const t = setTimeout(() => {
      void taskTitle(tid, refs).then((r) => live && setSuggested(r)).finally(() => live && setLooking(false));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
      setLooking(false);
    };
  }, [id, links, kind]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const r = await startReview(prList, prompt.trim() || undefined, reviewSetup, linkList, machine);
      setBusy(false);
      if ("error" in r) return setError(r.error);
      onClose();
      return router.push(taskHref(machine, r.taskId));
    }
    const res = scratch
      ? await startTaskJob({ id: "", kind: "scratch", slug: slug.trim(), repos: [...picked], setup, prompt: prompt.trim() || undefined, links: linkList, machine, startIn })
      : await startTaskJob({ id: id.trim(), slug: slug.trim() || suggested?.title || "", type: spec?.types?.length ? type || spec.types[0] : undefined, repos: [...picked], setup, prompt: prompt.trim() || undefined, links: linkList, machine, startIn });
    setBusy(false);
    if ("error" in res) return setError(res.error);
    // A task that starts in its room opens on the Room tab.
    if (startIn === "room") {
      try {
        localStorage.setItem(`jin-task-tab:${machine === "local" ? res.job.taskId : `${machine}:${res.job.taskId}`}`, "room");
      } catch {}
    }
    onClose();
    router.push(taskHref(machine, res.job.taskId));
  };

  // PR links (or repo#123), one per line or separated by spaces.
  const linkList = links.split(/\s+/).map((l) => l.trim()).filter(Boolean);
  const prList = prLinks.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
  const valid = kind === "review" ? prList.length > 0 : scratch ? picked.size > 0 : /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id.trim()) && picked.size > 0;
  return (
    <dialog ref={dialog} className="modal" onClose={onClose} onCancel={onClose} aria-labelledby="new-task-title">
      <form className="modal-body" onSubmit={submit}>
        <header className="modal-header">
          <h2 id="new-task-title">New task</h2>
          <button type="button" className="button quiet icon-only" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </header>
        {targets.length > 1 && (
          <label className="field">
            <span>Machine</span>
            <select value={machine} onChange={(e) => setMachine(e.target.value)}>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {(kinds?.length ?? 0) > 1 && (
          <div className="segmented" role="tablist" aria-label="Kind of task">
            {kinds!.map((k) => (
              <button key={k.id} type="button" role="tab" aria-selected={kind === k.id} className={kind === k.id ? "is-active" : ""} onClick={() => setKind(k.id)}>
                {k.label}
              </button>
            ))}
          </div>
        )}
        {kind === "review" ? (
          <>
            <label className="field">
              <span>Pull requests (links or repo#123, one per repo)</span>
              <textarea value={prLinks} onChange={(e) => setPrLinks(e.target.value)} rows={3} placeholder={"https://github.com/acme/api/pull/123\nweb#45"} autoFocus />
            </label>
            <p className="meta">{spec?.note ? `${spec.note} ` : ""}Skills tagged pr-review come with it. Already reviewing these PRs? That task opens.</p>
          </>
        ) : (
        <>
        {scratch ? (
          <>
            <p className="meta">{spec?.note ?? "An experiment on its own branch, tied to no issue."} Nothing is pushed unless you ask.</p>
            <label className="field">
              <span>What are you trying? (optional)</span>
              <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="e.g. try caching the toolkit list" autoFocus />
            </label>
          </>
        ) : (
        <>
        <div className="field-row">
          <label className="field">
            <span>Task ID</span>
            <input ref={idInput} value={id} onChange={(e) => setId(e.target.value)} placeholder={spec?.idHint ?? "TASK-1"} required />
          </label>
          {spec?.types?.length ? (
            <label className="field">
              <span>Type</span>
              <select value={type || spec.types[0]} onChange={(e) => setType(e.target.value)}>
                {spec.types.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <label className="field">
          <span>Title (optional)</span>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={suggested ? suggested.title : looking ? "Looking up…" : spec?.idIsIssue && tracker ? `From the ${tracker.noun}, or a PR in Follow below` : "From a PR in Follow below"} />
          {suggested && !slug.trim() && <span className="meta">From the {suggested.from === "issue" ? (tracker?.noun ?? "issue") : "pull request"}. Type to use your own.</span>}
        </label>
        </>
        )}
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
        {kind !== "review" && (
          <div className="field">
            <span>Start with</span>
            <div className="segmented" role="tablist" aria-label="Start with">
              <button type="button" role="tab" aria-selected={startIn === "claude"} className={startIn === "claude" ? "is-active" : ""} onClick={() => setStartIn("claude")}>
                Claude Code session
              </button>
              <button type="button" role="tab" aria-selected={startIn === "room"} className={startIn === "room" ? "is-active" : ""} onClick={() => setStartIn("room")}>
                Agent room
              </button>
            </div>
          </div>
        )}
        <label className="field">
          <span>{kind !== "review" && startIn === "room" ? "First message to the room (optional)" : "First prompt for Claude Code (optional)"}</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder={kind === "review" ? "Defaults to: review the pull requests in this task" : startIn === "room" ? "@designer draft a spec for…  (@-mention who starts: designer, engineer, reviewer)" : "What should Claude Code start on once the task is ready?"}
          />
          {kind !== "review" && startIn === "room" && prompt.trim() && !/(^|[^\w@/.])@(designer|engineer|reviewer|all)\b/i.test(prompt) && <span className="meta">No agent is mentioned: the message is posted, and nobody runs until you @-mention one.</span>}
        </label>
        {kind !== "review" ? (
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
            {busy ? "Creating…" : kind === "review" ? "Start review" : scratch ? "Start scratch" : "Create task"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
