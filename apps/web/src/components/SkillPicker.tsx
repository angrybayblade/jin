"use client";
import { useEffect, useState } from "react";
import { chatSkills } from "@/app/actions";
import type { ChatSkill } from "@/lib/daemon";

/**
 * `/skills` in chats: a picker while typing `/…` in the composer (the skills Claude Code offers
 * where the chat runs: yours, the workspace's, plugins'), ↑/↓ to move, Enter or Tab to insert,
 * Esc to close. A message that starts with one runs it; one named later is run by the agent.
 */

const lists = new Map<string, Promise<ChatSkill[]>>();
const load = (kind: string) => {
  let p = lists.get(kind);
  if (!p) {
    p = chatSkills(kind).then((l) => (l.length ? l : (lists.delete(kind), l)));
    lists.set(kind, p);
  }
  return p;
};

/** What is being typed after a `/` (at the start or after a space) just before the caret. */
export function skillQuery(text: string, caret: number): { start: number; q: string } | null {
  const m = /(?:^|\s)\/([\w:.-]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[1]!.length - 1, q: m[1]! } : null;
}

const score = (s: ChatSkill, q: string) => {
  const n = s.name.toLowerCase();
  const short = n.includes(":") ? n.slice(n.indexOf(":") + 1) : n;
  if (!q) return 1;
  if (n.startsWith(q) || short.startsWith(q)) return 3;
  if (n.includes(q)) return 2;
  return s.description.toLowerCase().includes(q) ? 1 : 0;
};

export function useSkillPicker(kind: string, draft: string, setDraft: (s: string) => void, input: React.RefObject<HTMLTextAreaElement | null>) {
  const [at, setAt] = useState<{ start: number; q: string } | null>(null);
  const [all, setAll] = useState<ChatSkill[] | null>(null);
  const [index, setIndex] = useState(0);
  const enabled = kind !== "task";

  useEffect(() => {
    if (at && enabled && all === null) void load(kind).then(setAll);
  }, [at, kind, enabled, all]);

  const q = at?.q.toLowerCase() ?? "";
  const items = (all ?? [])
    .map((s) => [s, score(s, q)] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].name.localeCompare(b[0].name))
    .slice(0, 8)
    .map(([s]) => s);

  const update = (text: string, caret: number) => {
    const next = enabled ? skillQuery(text, caret) : null;
    setAt(next);
    if (next?.q !== at?.q) setIndex(0);
  };

  const pick = (s: ChatSkill) => {
    if (!at) return;
    const caret = at.start + 1 + at.q.length;
    setDraft(`${draft.slice(0, at.start)}/${s.name} ${draft.slice(caret)}`);
    setAt(null);
    const pos = at.start + s.name.length + 2;
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(pos, pos);
    });
  };

  /** Keys the picker takes while open; true when it handled one. */
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!at) return false;
    if (e.key === "Escape") {
      setAt(null);
      e.preventDefault();
      return true;
    }
    if (!items.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      e.preventDefault();
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      pick(items[Math.min(index, items.length - 1)]!);
      e.preventDefault();
      return true;
    }
    return false;
  };

  const picker =
    at && enabled && (all === null || items.length > 0) ? (
      <div className="mention-picker skill-picker" role="listbox" aria-label="Skill">
        {all === null && <div className="mention-empty">Looking…</div>}
        {items.map((s, i) => (
          <button
            key={s.name}
            type="button"
            role="option"
            aria-selected={i === index}
            className={`mention-option skill-option ${i === index ? "is-active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              pick(s);
            }}
            onMouseEnter={() => setIndex(i)}
          >
            <span className="mention-label mono">/{s.name}</span>
            <span className="mention-title" title={s.argumentHint ? `${s.description}\n\n/${s.name} ${s.argumentHint}` : s.description}>
              {s.description}
            </span>
          </button>
        ))}
      </div>
    ) : null;

  return { picker, update, onKey, close: () => setAt(null) };
}
