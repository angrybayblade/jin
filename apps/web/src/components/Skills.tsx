"use client";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteSkill, getSkill, saveSkill } from "@/app/actions";
import type { Skill, SkillsStatus } from "@/lib/daemon";

const TEMPLATE = `---
description: What this skill does, and when Claude should use it
---

# Steps

1. …
`;

const parseTags = (t: string) => [...new Set(t.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];

/** Which kinds of task get a skill with these tags. */
function goesTo(tags: string[], s: SkillsStatus): string {
  if (tags.includes(s.everyTask)) return "every task";
  const kinds = Object.entries(s.taskTags)
    .filter(([, want]) => want.some((t) => tags.includes(t)))
    .map(([k]) => (k === "review" ? "review tasks" : `${k} tasks`));
  return kinds.length ? kinds.join(", ") : "no task yet";
}

/** One skill: its tags inline; open it to edit the SKILL.md. */
function SkillCard({ skill, s, startOpen = false, onDone }: { skill?: Skill; s: SkillsStatus; startOpen?: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(startOpen);
  const [name, setName] = useState(skill?.name ?? "");
  const [tags, setTags] = useState((skill?.tags ?? []).join(", "));
  const [body, setBody] = useState<string | null>(skill ? null : TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    if (!open && skill && body === null) {
      const r = await getSkill(skill.name);
      if ("error" in r) return setError(r.error);
      setBody(r.body);
    }
    setOpen(!open);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    const r = await saveSkill(skill?.name ?? name.trim(), { tags: parseTags(tags), ...(body !== null ? { body } : {}) });
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setOpen(false);
    onDone();
  };
  const remove = async () => {
    if (!skill || !confirm(`Delete the skill "${skill.name}"?`)) return;
    const r = await deleteSkill(skill.name);
    if ("error" in r) setError(r.error);
    else onDone();
  };
  const current = parseTags(tags);
  return (
    <section className="md-card hook-card">
      <div className="md-card-head is-static">
        <button type="button" className="hook-title" onClick={() => void toggle()}>
          <h3>{skill ? `/jin:${skill.name}` : "New skill"}</h3>
          <span className="meta">{skill?.description || "—"}</span>
        </button>
        <span className="skill-tags">
          {(skill?.tags ?? []).map((t) => (
            <span key={t} className="skill-tag">
              {t}
            </span>
          ))}
        </span>
      </div>
      {open && (
        <div className="md-card-body">
          <div className="field-row">
            {!skill && (
              <label className="field">
                <span>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="pr-review-deep" />
              </label>
            )}
            <label className="field">
              <span>Tags (comma or space separated)</span>
              <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="pr-review" />
            </label>
          </div>
          <p className="meta">Goes to {goesTo(current, s)}.</p>
          <label className="field">
            <span>SKILL.md</span>
            <textarea className="mono" rows={16} value={body ?? ""} onChange={(e) => setBody(e.target.value)} />
          </label>
          {error && <p className="machine-error">{error}</p>}
          <div className="hook-actions">
            {skill && (
              <button type="button" className="button quiet small" onClick={() => void remove()}>
                <Trash2 size={13} /> Delete
              </button>
            )}
            <span className="hook-spacer" />
            <button type="button" className="button quiet small" onClick={() => (skill ? setOpen(false) : onDone())}>
              Cancel
            </button>
            <button type="button" className="button small" disabled={busy || (!skill && !name.trim())} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
      {!open && error && <p className="machine-error">{error}</p>}
    </section>
  );
}

export function SkillsPage({ initial, home }: { initial: SkillsStatus; home: string }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const s = initial;
  const done = () => (setAdding(false), router.refresh());
  return (
    <div className="machines">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-name">Skills</span>
          <span className="meta">your skills, by tag, handed to tasks · on {home}</span>
        </div>
        <button type="button" className="button small" onClick={() => setAdding(true)} disabled={adding}>
          <Plus size={13} /> New skill
        </button>
      </header>
      <div className="machines-body is-single" data-scroll="y">
        <main className="machines-main">
          <article className="machine-detail">
            {adding && <SkillCard s={s} startOpen onDone={done} />}
            {s.skills.map((k) => (
              <SkillCard key={k.name} skill={k} s={s} onDone={done} />
            ))}
            {s.skills.length === 0 && !adding && <p className="meta">No skills yet.</p>}
            <p className="meta">
              A task&apos;s Claude Code gets the skills tagged for its kind:{" "}
              {Object.entries(s.taskTags)
                .map(([k, t]) => `${k} tasks ← ${t.join(", ")}`)
                .join("; ")}
              ; and <span className="mono">{s.everyTask}</span> goes to all. They show as /jin:&lt;name&gt; and start with the next Claude Code tab of a task.
            </p>
          </article>
        </main>
      </div>
    </div>
  );
}
