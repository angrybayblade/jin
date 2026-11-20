"use client";
import { GitPullRequest, ListChecks, Sparkles, SquareKanban } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { searchMentions } from "@/app/actions";
import type { ChatSkill, Mention } from "@/lib/daemon";

/**
 * @mentions in chats: a picker while typing `@…` in the composer, and chips for the mentions
 * in a sent message (resolved by jin: PRs, Linear issues, jin tasks on any machine).
 */

/** `@` then a PR (owner/repo#n, repo#n) or an id (PLEN-1334, REV-111701): as the daemon reads them. */
export const MENTION = /(^|[\s(])@((?:[\w.-]+\/)?[\w.-]+#\d+|[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+)(?=$|[\s),.;:!?])/g;

const ICON = { pr: GitPullRequest, issue: SquareKanban, task: ListChecks } as const;
const KIND = { pr: "Pull request", issue: "Linear issue", task: "jin task" } as const;

const describe = (m: Mention) =>
  [`${KIND[m.kind]}${m.kind === "task" && m.machineLabel ? ` on ${m.machineLabel}` : ""}`, m.title, m.state, m.detail].filter(Boolean).join(" · ");

/** One mention in a message: opens the task in jin, else the PR or issue; a task's issue is a second link. */
function Chip({ label, found }: { label: string; found: Mention[] }) {
  const task = found.find((m) => m.kind === "task");
  const main = task ?? found[0]!;
  const issue = task ? found.find((m) => m.kind === "issue") : undefined;
  const Icon = ICON[main.kind];
  const body = (
    <>
      <Icon size={12} />
      <span>{label}</span>
    </>
  );
  return (
    <span className={`mention-chip is-${main.kind}`} title={found.map(describe).join("\n")}>
      {main.url?.startsWith("/") ? (
        <Link href={main.url} className="mention-main">
          {body}
        </Link>
      ) : main.url ? (
        <a href={main.url} target="_blank" rel="noreferrer" className="mention-main">
          {body}
        </a>
      ) : (
        <span className="mention-main">{body}</span>
      )}
      {issue?.url && (
        <a href={issue.url} target="_blank" rel="noreferrer" className="mention-extra" title={describe(issue)} aria-label={`Open ${label} in Linear`}>
          <SquareKanban size={11} />
        </a>
      )}
    </span>
  );
}

/** `/name` as the daemon reads it (at the start or after a space; not a path). */
const SKILL = /(^|\s)\/([A-Za-z0-9][\w:.-]*)(?=$|[\s),.;!?])/g;

/** A message's text with its resolved @mentions and the /skills it named as chips (the rest stays text). */
export function WithMentions({ text, mentions, skills }: { text: string; mentions?: Mention[]; skills?: ChatSkill[] }) {
  if (!mentions?.length && !skills?.length) return <>{text}</>;
  const marks: { at: number; len: number; node: ReactNode }[] = [];
  for (const m of mentions?.length ? text.matchAll(MENTION) : []) {
    const label = m[2]!;
    const found = mentions!.filter((x) => x.label === label);
    if (!found.length) continue;
    const at = m.index! + m[1]!.length;
    marks.push({ at, len: 1 + label.length, node: <Chip key={at} label={label} found={found} /> });
  }
  for (const m of skills?.length ? text.matchAll(SKILL) : []) {
    const name = m[2]!.replace(/[.:]+$/, "");
    const skill = skills!.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!skill) continue;
    const at = m.index! + m[1]!.length;
    marks.push({
      at,
      len: 1 + name.length,
      node: (
        <span key={at} className="mention-chip is-skill" title={skill.description}>
          <span className="mention-main">
            <Sparkles size={12} />
            <span>{name}</span>
          </span>
        </span>
      ),
    });
  }
  marks.sort((a, b) => a.at - b.at);
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of marks) {
    if (m.at < last) continue;
    out.push(text.slice(last, m.at), m.node);
    last = m.at + m.len;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

/** What is being typed after an @ just before the caret, if anything. */
export function mentionQuery(text: string, caret: number): { start: number; q: string } | null {
  const m = /(?:^|[\s(])@([\w./#-]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[1]!.length - 1, q: m[1]! } : null;
}

/**
 * The picker above the composer while typing `@…`: candidates from jin (tasks first, then PRs
 * and issues), ↑/↓ to move, Enter or Tab to insert, Esc to close.
 */
export function useMentionPicker(draft: string, setDraft: (s: string) => void, input: React.RefObject<HTMLTextAreaElement | null>) {
  const [at, setAt] = useState<{ start: number; q: string } | null>(null);
  // One row per thing to write: a task and its issue share an id, so they are one row.
  const [items, setItems] = useState<Mention[][]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const update = (text: string, caret: number) => setAt(mentionQuery(text, caret));

  useEffect(() => {
    if (!at) {
      setItems([]);
      return;
    }
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      void searchMentions(at.q)
        .then((r) => {
          if (n !== seq.current) return;
          const rows = new Map<string, Mention[]>();
          for (const m of r) rows.set(m.label, [...(rows.get(m.label) ?? []), m]);
          setItems([...rows.values()]);
          setIndex(0);
        })
        .catch(() => n === seq.current && setItems([]))
        .finally(() => n === seq.current && setLoading(false));
    }, 150);
    return () => clearTimeout(t);
  }, [at?.q, at?.start]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = ([m]: Mention[]) => {
    if (!m) return;
    if (!at) return;
    const caret = at.start + 1 + at.q.length;
    const next = `${draft.slice(0, at.start)}@${m.label} ${draft.slice(caret)}`;
    setDraft(next);
    setAt(null);
    const pos = at.start + m.label.length + 2;
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
      pick(items[index]!);
      e.preventDefault();
      return true;
    }
    return false;
  };

  const picker =
    at && (items.length > 0 || loading) ? (
      <div className="mention-picker" role="listbox" aria-label="Mention">
        {items.length === 0 && <div className="mention-empty">Looking…</div>}
        {items.map((row, i) => {
          const m = row.find((x) => x.kind === "task") ?? row[0]!;
          return (
            <button
              key={m.label}
              type="button"
              role="option"
              aria-selected={i === index}
              className={`mention-option ${i === index ? "is-active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(row);
              }}
              onMouseEnter={() => setIndex(i)}
            >
              <span className="mention-icons">
                {row.map((x) => {
                  const Icon = ICON[x.kind];
                  return <Icon key={x.key} size={13} aria-label={KIND[x.kind]} />;
                })}
              </span>
              <span className="mention-label mono">{m.label}</span>
              <span className="mention-title">{m.title ?? ""}</span>
              <span className="mention-meta">{[m.kind === "task" ? m.machineLabel : null, m.state].filter(Boolean).join(" · ")}</span>
            </button>
          );
        })}
      </div>
    ) : null;

  return { picker, update, onKey, close: () => setAt(null) };
}
