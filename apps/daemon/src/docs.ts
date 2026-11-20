import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { now } from "./db";
import type { JinTool } from "./harness/types";
import { body, HttpError, json, type Router } from "./http";
import { readChoice } from "./models";
import type { RunChoice } from "./sessions";

/**
 * jin docs: specs, RFCs and notes that you and jin work on together. A doc is markdown (the
 * editor's blocks are saved as markdown, so agents and diffs read it as text) with its versions.
 * You talk in comment threads anchored to a quote; jin proposes changes as suggestions (a quote
 * and what replaces it) that you accept or reject. Anchors are quotes with a little text either
 * side, not positions, so they survive edits; one whose text is gone shows as outdated.
 * Docs live on jin's home, next to the chats; each has its own jin chat for the back and forth.
 */

/** Who wrote something in a doc: you, jin, or a room's agent ("@designer"). */
export type By = "you" | "jin" | `@${string}`;

/** An author named in a request: a room agent's handle, else jin. */
export const agentBy = (v: unknown): By => (typeof v === "string" && /^@[a-z][a-z0-9_-]{1,23}$/.test(v) ? (v as By) : "jin");

export interface Anchor {
  quote: string;
  prefix?: string | null;
  suffix?: string | null;
}

export interface Doc {
  id: string;
  title: string;
  body: string;
  tags: string[];
  version: number;
  chatId: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface DocSummary {
  id: string;
  title: string;
  tags: string[];
  excerpt: string;
  updatedAt: string;
  openThreads: number;
  openSuggestions: number;
}

export interface DocComment {
  id: string;
  by: By;
  text: string;
  at: string;
}

export interface DocThread {
  id: string;
  anchor: Anchor | null;
  by: By;
  resolved: boolean;
  createdAt: string;
  /** Whether its quote is still in the doc (a doc-level thread always is). */
  located: boolean;
  comments: DocComment[];
}

export interface DocSuggestion {
  id: string;
  anchor: Anchor;
  replacement: string;
  why: string | null;
  by: By;
  status: "open" | "accepted" | "rejected";
  createdAt: string;
  decidedAt: string | null;
  /** Whether its quote is still in the doc (false: outdated). */
  located: boolean;
}

export interface DocVersion {
  version: number;
  title: string;
  by: string;
  at: string;
  size: number;
}

export interface DocFull extends Doc {
  threads: DocThread[];
  suggestions: DocSuggestion[];
}

const newId = (prefix: string) => `${prefix}${randomBytes(5).toString("hex")}`;
export const DOC_ID = /^d[0-9a-f]{10}$/;

/** How much text either side of a quote an anchor keeps, to tell repeats apart. */
const SIDE = 40;
/** Saves by the same hand within this long share a version. */
const BURST_MS = 10 * 60_000;

// ---------------------------------------------------------------- anchoring

const indices = (hay: string, needle: string): number[] => {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
};

/** Markdown without its inline marks (`*_~` and backticks), and where each kept character was. */
function plain(s: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if ("*_`~".includes(s[i]!)) continue;
    text += s[i];
    at.push(i);
  }
  return { text, at };
}

const commonTail = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};
const commonHead = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/**
 * Where an anchor's quote is in the body: an exact match first, else one that ignores inline
 * marks (a quote taken from the rendered doc, where `**bold**` reads as `bold`). Repeats are told
 * apart by the text either side. Null when the quote is gone.
 */
export function locate(body: string, a: Anchor): { start: number; end: number } | null {
  if (!a.quote) return null;
  let hits = indices(body, a.quote).map((i) => ({ start: i, end: i + a.quote.length }));
  if (!hits.length) {
    const b = plain(body);
    const q = plain(a.quote).text.replace(/\s+/g, " ").trim();
    if (!q) return null;
    // Whitespace may differ too (a soft break in the source, a space in the rendered text).
    const flat = b.text.replace(/\s/g, " ");
    hits = indices(flat, q).map((i) => ({ start: b.at[i]!, end: b.at[i + q.length - 1]! + 1 }));
  }
  if (hits.length <= 1) return hits[0] ?? null;
  const score = (h: { start: number; end: number }) => commonTail(body.slice(Math.max(0, h.start - SIDE), h.start), a.prefix ?? "") + commonHead(body.slice(h.end, h.end + SIDE), a.suffix ?? "");
  return hits.reduce((best, h) => (score(h) > score(best) ? h : best));
}

/** An anchor for the text at start..end of the body. */
export const anchorAt = (body: string, start: number, end: number): Anchor => ({ quote: body.slice(start, end), prefix: body.slice(Math.max(0, start - SIDE), start), suffix: body.slice(end, end + SIDE) });

// ---------------------------------------------------------------- the store

const parseTags = (t: string): string[] => {
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const cleanTags = (tags: unknown): string[] =>
  Array.isArray(tags) ? [...new Set(tags.filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20) : [];

const toDoc = (r: any): Doc => ({ id: r.id, title: r.title, body: r.body, tags: parseTags(r.tags), version: r.version, chatId: r.chat_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at, archived: Boolean(r.archived_at) });

/** The first words of a doc's text, for the library. */
const excerpt = (body: string) =>
  body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s.*$/m, " ")
    .replace(/[#>*_`~[\]()|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

export class Docs {
  private listeners = new Set<(docId: string) => void>();
  constructor(private db: Database) {}

  /** Called after any change to a doc (its text, threads or suggestions). */
  onChange(fn: (docId: string) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed(id: string) {
    for (const fn of this.listeners) fn(id);
  }

  list(filter: { q?: string; tag?: string; archived?: boolean } = {}): DocSummary[] {
    const rows = this.db.query(`select * from docs where archived_at is ${filter.archived ? "not null" : "null"} order by updated_at desc`).all() as any[];
    const counts = (sql: string) => new Map((this.db.query(sql).all() as { doc_id: string; n: number }[]).map((r) => [r.doc_id, r.n]));
    const threads = counts("select doc_id, count(*) as n from doc_threads where resolved_at is null group by doc_id");
    const suggestions = counts("select doc_id, count(*) as n from doc_suggestions where status = 'open' group by doc_id");
    const q = filter.q?.trim().toLowerCase();
    const tag = filter.tag?.trim().toLowerCase();
    return rows
      .map(toDoc)
      .filter((d) => (!tag || d.tags.includes(tag)) && (!q || d.title.toLowerCase().includes(q) || d.body.toLowerCase().includes(q)))
      .map((d) => ({ id: d.id, title: d.title, tags: d.tags, excerpt: excerpt(d.body), updatedAt: d.updatedAt, openThreads: threads.get(d.id) ?? 0, openSuggestions: suggestions.get(d.id) ?? 0 }));
  }

  get(id: string): Doc {
    const r = this.db.query("select * from docs where id = ?").get(id);
    if (!r) throw new HttpError(404, `no doc ${id}`);
    return toDoc(r);
  }

  /** The doc with its threads and suggestions (open ones, and the last few decided). */
  full(id: string): DocFull {
    const d = this.get(id);
    return { ...d, threads: this.threads(id, d.body), suggestions: this.suggestions(id, d.body) };
  }

  create(input: { title?: string; body?: string; tags?: unknown }, by: By): Doc {
    const id = newId("d");
    const at = now();
    const title = input.title?.trim() || "Untitled";
    const text = input.body ?? "";
    this.db.query("insert into docs (id, title, body, tags, version, created_at, updated_at) values (?, ?, ?, ?, 1, ?, ?)").run(id, title, text, JSON.stringify(cleanTags(input.tags)), at, at);
    this.db.query("insert into doc_versions (doc_id, version, title, body, by, at) values (?, 1, ?, ?, ?, ?)").run(id, title, text, by, at);
    this.changed(id);
    return this.get(id);
  }

  /**
   * Save a doc's title, text or tags. `base` is the version the change was made on: another
   * save since then (on another device, or an accepted suggestion) is refused, 409, so nothing
   * is overwritten unseen. Saves by the same hand within a few minutes share a version.
   */
  save(id: string, patch: { title?: string; body?: string; tags?: unknown }, base: number, by: By): Doc {
    const d = this.get(id);
    if (base !== d.version) throw new HttpError(409, `this doc changed since you opened it (version ${d.version}, yours ${base}); reload it`);
    const title = patch.title !== undefined ? patch.title.trim() || "Untitled" : d.title;
    const text = patch.body ?? d.body;
    const tags = patch.tags !== undefined ? cleanTags(patch.tags) : d.tags;
    if (title === d.title && text === d.body && JSON.stringify(tags) === JSON.stringify(d.tags)) return d;
    const at = now();
    const version = d.version + 1;
    this.db.transaction(() => {
      this.db.query("update docs set title = ?, body = ?, tags = ?, version = ?, updated_at = ? where id = ?").run(title, text, JSON.stringify(tags), version, at, id);
      const last = this.db.query("select version, by, at from doc_versions where doc_id = ? order by version desc limit 1").get(id) as { version: number; by: string; at: string } | null;
      // The last version is replaced when it is this hand's, from moments ago (one version per burst of typing).
      if (last && last.by === by && Date.parse(at) - Date.parse(last.at) < BURST_MS && last.version !== 1) this.db.query("delete from doc_versions where doc_id = ? and version = ?").run(id, last.version);
      this.db.query("insert into doc_versions (doc_id, version, title, body, by, at) values (?, ?, ?, ?, ?, ?)").run(id, version, title, text, by, at);
    })();
    this.changed(id);
    return this.get(id);
  }

  archive(id: string, archived = true): Doc {
    this.get(id);
    this.db.query("update docs set archived_at = ? where id = ?").run(archived ? now() : null, id);
    this.changed(id);
    return this.get(id);
  }

  /** A new title alone. Not a new version, so an editor open on the doc keeps saving (it takes the title on its next look). */
  rename(id: string, title: string): Doc {
    this.get(id);
    this.db.query("update docs set title = ?, updated_at = ? where id = ?").run(title.trim() || "Untitled", now(), id);
    this.changed(id);
    return this.get(id);
  }

  /** A copy: the same text and tags as a new doc, without its comments, suggestions or chat. */
  duplicate(id: string, by: By): Doc {
    const d = this.get(id);
    return this.create({ title: `${d.title} (copy)`, body: d.body, tags: d.tags }, by);
  }

  /** Delete a doc for good: its text, versions, comments and suggestions. Returns its chat, if it had one. */
  remove(id: string): { chatId: string | null } {
    const d = this.get(id);
    this.db.transaction(() => {
      this.db.query("delete from doc_comments where thread_id in (select id from doc_threads where doc_id = ?)").run(id);
      this.db.query("delete from doc_threads where doc_id = ?").run(id);
      this.db.query("delete from doc_suggestions where doc_id = ?").run(id);
      this.db.query("delete from doc_versions where doc_id = ?").run(id);
      this.db.query("delete from docs where id = ?").run(id);
    })();
    this.changed(id);
    return { chatId: d.chatId };
  }

  setChat(id: string, chatId: string | null) {
    this.db.query("update docs set chat_id = ? where id = ?").run(chatId, id);
  }

  byChat(chatId: string): Doc | null {
    const r = this.db.query("select * from docs where chat_id = ?").get(chatId);
    return r ? toDoc(r) : null;
  }

  versions(id: string): DocVersion[] {
    this.get(id);
    return (this.db.query("select version, title, by, at, length(body) as size from doc_versions where doc_id = ? order by version desc").all(id) as any[]).map((r) => ({ version: r.version, title: r.title, by: r.by, at: r.at, size: r.size }));
  }

  version(id: string, version: number): { version: number; title: string; body: string; by: string; at: string } {
    const r = this.db.query("select version, title, body, by, at from doc_versions where doc_id = ? and version = ?").get(id, version) as any;
    if (!r) throw new HttpError(404, `doc ${id} has no version ${version}`);
    return r;
  }

  /** Bring an old version back, as a new version (nothing is lost). */
  restore(id: string, version: number, base: number): Doc {
    const v = this.version(id, version);
    return this.save(id, { title: v.title, body: v.body }, base, "you");
  }

  // -------------------------------------------------------------- threads

  private threads(id: string, text: string): DocThread[] {
    const rows = this.db.query("select * from doc_threads where doc_id = ? order by created_at").all(id) as any[];
    const comments = this.db.query("select c.* from doc_comments c join doc_threads t on t.id = c.thread_id where t.doc_id = ? order by c.at").all(id) as any[];
    return rows.map((r) => {
      const anchor = r.quote ? { quote: r.quote, prefix: r.prefix, suffix: r.suffix } : null;
      return {
        id: r.id,
        anchor,
        by: r.by,
        resolved: Boolean(r.resolved_at),
        createdAt: r.created_at,
        located: anchor ? locate(text, anchor) !== null : true,
        comments: comments.filter((c) => c.thread_id === r.id).map((c) => ({ id: c.id, by: c.by, text: c.text, at: c.at })),
      };
    });
  }

  thread(docId: string, threadId: string): DocThread {
    const t = this.threads(docId, this.get(docId).body).find((x) => x.id === threadId);
    if (!t) throw new HttpError(404, `doc ${docId} has no thread ${threadId}`);
    return t;
  }

  /** A comment: a new thread (on a quote, or on the whole doc), or a reply in one. */
  comment(docId: string, input: { text: string; threadId?: string; anchor?: Anchor | null }, by: By): DocThread {
    const text = input.text?.trim();
    if (!text) throw new HttpError(400, "a comment needs text");
    const d = this.get(docId);
    let threadId = input.threadId;
    if (threadId) {
      const t = this.thread(docId, threadId);
      // A reply reopens a resolved thread.
      if (t.resolved) this.db.query("update doc_threads set resolved_at = null where id = ?").run(threadId);
    } else {
      let anchor: Anchor | null = null;
      if (input.anchor?.quote) {
        const at = locate(d.body, input.anchor);
        if (!at) throw new HttpError(400, `the quoted text is not in the doc: "${input.anchor.quote.slice(0, 80)}"`);
        // Kept as the editor sent it when it named the text either side; else from the body.
        anchor = input.anchor.prefix != null || input.anchor.suffix != null ? input.anchor : anchorAt(d.body, at.start, at.end);
      }
      threadId = newId("t");
      this.db.query("insert into doc_threads (id, doc_id, quote, prefix, suffix, by, created_at) values (?, ?, ?, ?, ?, ?, ?)").run(threadId, docId, anchor?.quote ?? null, anchor?.prefix ?? null, anchor?.suffix ?? null, by, now());
    }
    this.db.query("insert into doc_comments (id, thread_id, by, text, at) values (?, ?, ?, ?, ?)").run(newId("c"), threadId, by, text, now());
    this.touch(docId);
    return this.thread(docId, threadId);
  }

  resolve(docId: string, threadId: string, resolved = true): DocThread {
    this.thread(docId, threadId);
    this.db.query("update doc_threads set resolved_at = ? where id = ?").run(resolved ? now() : null, threadId);
    this.touch(docId);
    return this.thread(docId, threadId);
  }

  // -------------------------------------------------------------- suggestions

  private suggestions(id: string, text: string): DocSuggestion[] {
    const rows = this.db.query("select * from doc_suggestions where doc_id = ? and (status = 'open' or decided_at > ?) order by created_at").all(id, new Date(Date.now() - 7 * 86_400_000).toISOString()) as any[];
    return rows.map((r) => {
      const anchor = { quote: r.quote, prefix: r.prefix, suffix: r.suffix };
      return { id: r.id, anchor, replacement: r.replacement, why: r.why, by: r.by, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, located: r.status !== "open" || locate(text, anchor) !== null };
    });
  }

  /** A proposed change: the quoted text (exactly as in the markdown) and what replaces it. */
  suggest(docId: string, input: { quote: string; replacement: string; why?: string }, by: By): DocSuggestion {
    const d = this.get(docId);
    if (!input.quote) throw new HttpError(400, "a suggestion needs the text it changes (quote)");
    const exact = indices(d.body, input.quote);
    if (exact.length > 1) throw new HttpError(400, `the quote appears ${exact.length} times; include more of the surrounding text so it names one place`);
    const at = locate(d.body, { quote: input.quote });
    if (!at) throw new HttpError(400, `the quoted text is not in the doc (quote it exactly as the markdown has it): "${input.quote.slice(0, 80)}"`);
    const a = anchorAt(d.body, at.start, at.end);
    const id = newId("s");
    this.db.query("insert into doc_suggestions (id, doc_id, quote, prefix, suffix, replacement, why, by, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, docId, a.quote, a.prefix ?? null, a.suffix ?? null, input.replacement ?? "", input.why?.trim() || null, by, now());
    this.touch(docId);
    return this.suggestions(docId, d.body).find((s) => s.id === id)!;
  }

  /** Accept (apply it to the text, as a new version) or reject a suggestion. */
  decide(docId: string, suggestionId: string, accept: boolean, base?: number): { doc: Doc; suggestion: DocSuggestion } {
    const d = this.get(docId);
    const s = this.suggestions(docId, d.body).find((x) => x.id === suggestionId);
    if (!s) throw new HttpError(404, `doc ${docId} has no suggestion ${suggestionId}`);
    if (s.status !== "open") throw new HttpError(409, `this suggestion was already ${s.status}`);
    let doc = d;
    if (accept) {
      const at = locate(d.body, s.anchor);
      if (!at) throw new HttpError(409, "the text this suggestion changes is no longer in the doc");
      doc = this.save(docId, { body: d.body.slice(0, at.start) + s.replacement + d.body.slice(at.end) }, base ?? d.version, "jin");
    }
    this.db.query("update doc_suggestions set status = ?, decided_at = ? where id = ?").run(accept ? "accepted" : "rejected", now(), suggestionId);
    this.touch(docId);
    return { doc, suggestion: this.suggestions(docId, doc.body).find((x) => x.id === suggestionId)! };
  }

  /** A thread or suggestion changed: the doc moves up the library, its text does not change. */
  private touch(id: string) {
    this.db.query("update docs set updated_at = ? where id = ?").run(now(), id);
    this.changed(id);
  }
}

// ---------------------------------------------------------------- jin, on a doc

/** How the agent sees a doc: its markdown and what is open on it. */
export function docForAgent(d: DocFull) {
  return {
    id: d.id,
    title: d.title,
    tags: d.tags,
    version: d.version,
    markdown: d.body,
    openThreads: d.threads
      .filter((t) => !t.resolved)
      .map((t) => ({ threadId: t.id, on: t.anchor?.quote ?? "(the whole doc)", outdated: !t.located || undefined, comments: t.comments.map((c) => `${c.by}: ${c.text}`) })),
    openSuggestions: d.suggestions.filter((s) => s.status === "open").map((s) => ({ suggestionId: s.id, quote: s.anchor.quote, replacement: s.replacement, why: s.why, outdated: !s.located || undefined })),
  };
}

/** What a doc's own chat is told: which doc, and how to work on it. */
export function docChatNote(d: Doc): string {
  return [
    `This conversation is about the jin doc ${d.id}, "${d.title}". Read it with jin_read_doc (it changes as the user edits, so read it again before suggesting).`,
    "- You do not edit the text yourself: propose each change with jin_suggest_doc_edit (the exact markdown it replaces, the new markdown and a one-line why); the user accepts or rejects it in the doc. Several small suggestions beat one big rewrite. For a new section, quote the line it goes after and repeat that line in the replacement, followed by the new section.",
    "- A message that starts with [Comment thread <id> …] came from a comment in the doc: answer there with jin_comment_doc (threadId), briefly, and suggest edits if the comment asks for a change. A message typed here gets its answer here.",
    "- Ground what you write in the workspace: read the code, docs and other repos it is about, and say where a claim comes from (file:line, PR, issue).",
  ].join("\n");
}

/** jin's tools for docs, in jin's chat, the desk and each doc's own chat. */
export function docTools(docs: Docs, by: By = "jin"): JinTool[] {
  return [
    {
      name: "jin_list_docs",
      description: "The user's jin docs (specs, RFCs, notes): id, title, tags, a line of their text, open comment threads and suggestions. Filter with query (title or text) or tag.",
      input: { query: z.string().optional(), tag: z.string().optional() },
      run: async (a) => docs.list({ q: a.query as string | undefined, tag: a.tag as string | undefined }).slice(0, 50),
    },
    {
      name: "jin_read_doc",
      description: "Read a jin doc: its markdown, version, and its open comment threads and suggestions.",
      input: { docId: z.string() },
      run: async (a) => docForAgent(docs.full(a.docId as string)),
    },
    {
      name: "jin_create_doc",
      description: "Create a jin doc (a spec, RFC, design or notes) in markdown once the user asks for one. Returns its id; it opens at /docs/<id>.",
      input: { title: z.string(), markdown: z.string(), tags: z.array(z.string()).optional() },
      run: async (a) => {
        const d = docs.create({ title: a.title as string, body: a.markdown as string, tags: a.tags }, by);
        return { id: d.id, title: d.title, url: `/docs/${d.id}` };
      },
    },
    {
      name: "jin_suggest_doc_edit",
      description:
        "Propose a change to a jin doc for the user to accept or reject: quote is the exact markdown it replaces (enough of it to appear once), replacement the new markdown (empty removes the text), why one line. You never edit a doc directly.",
      input: { docId: z.string(), quote: z.string(), replacement: z.string(), why: z.string().optional() },
      run: async (a) => {
        const s = docs.suggest(a.docId as string, { quote: a.quote as string, replacement: a.replacement as string, why: a.why as string | undefined }, by);
        return { suggestionId: s.id };
      },
    },
    {
      name: "jin_comment_doc",
      description: "Comment on a jin doc: reply in a thread (threadId), or start one on a quote (exact text from the doc) or on the whole doc. Keep it short.",
      input: { docId: z.string(), text: z.string(), threadId: z.string().optional(), quote: z.string().optional() },
      run: async (a) => {
        const t = docs.comment(a.docId as string, { text: a.text as string, threadId: a.threadId as string | undefined, anchor: a.quote ? { quote: a.quote as string } : null }, by);
        return { threadId: t.id };
      },
    },
  ];
}

// ---------------------------------------------------------------- asking jin

/** Whether a comment asks jin: it names @jin, or it replies in a thread jin started. */
export const asksJin = (text: string, thread: Pick<DocThread, "by"> | null) => /(^|\s)@jin\b/i.test(text) || thread?.by === "jin";

/** What jin's doc chat is told when a comment asks it. */
export function threadPrompt(t: DocThread, text: string): string {
  return `[Comment thread ${t.id} on ${t.anchor ? `"${t.anchor.quote.slice(0, 300)}"` : "the whole doc"}] ${text.replace(/(^|\s)@jin\b/gi, "$1").trim()}`;
}

export interface DocChats {
  /** Start the doc's chat with a first message; returns its session id. */
  start(doc: Doc, prompt: string, choice?: RunChoice): string;
  /** Send to the doc's chat; false when the chat is gone. Throws 409 while it is busy. */
  send(chatId: string, prompt: string, choice?: RunChoice): boolean;
  /** Whether the chat is working (a message now would be refused). */
  busy(chatId: string): boolean;
}

/** Ask jin about a doc in its chat (started on first use); a message while jin is busy waits its turn. */
export class DocAsk {
  private queue = new Map<string, string[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private docs: Docs,
    private chats: DocChats,
  ) {}

  ask(docId: string, prompt: string, choice?: RunChoice): { chatId: string; queued: boolean } {
    const d = this.docs.get(docId);
    if (d.chatId && this.chats.busy(d.chatId)) {
      this.queue.set(d.chatId, [...(this.queue.get(d.chatId) ?? []), prompt]);
      this.drainSoon();
      return { chatId: d.chatId, queued: true };
    }
    if (d.chatId && this.chats.send(d.chatId, prompt, choice)) return { chatId: d.chatId, queued: false };
    const chatId = this.chats.start(d, prompt, choice);
    this.docs.setChat(docId, chatId);
    return { chatId, queued: false };
  }

  private drainSoon() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const [chatId, prompts] of this.queue) {
        if (this.chats.busy(chatId)) continue;
        const next = prompts.shift();
        if (!prompts.length) this.queue.delete(chatId);
        if (next) {
          try {
            this.chats.send(chatId, next);
          } catch {
            this.queue.set(chatId, [next, ...(this.queue.get(chatId) ?? [])]);
          }
        }
      }
      if (!this.queue.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, 2000);
  }
}

// ---------------------------------------------------------------- routes

const docId = (p: Record<string, string>) => {
  const id = p.id ?? "";
  if (!DOC_ID.test(id)) throw new HttpError(404, `no doc ${id}`);
  return id;
};

export function docRoutes(router: Router, docs: Docs, ask: DocAsk | null, onDeleted?: (chatId: string) => void) {
  // A comment that asks jin (names @jin, or answers jin) goes to the doc's chat.
  const maybeAsk = (id: string, t: DocThread, text: string, starting: boolean) => {
    if (!ask || !asksJin(text, starting ? null : t)) return;
    ask.ask(id, threadPrompt(t, text));
  };
  router
    .on("GET", "/api/docs", (_req, _p, url) => json(docs.list({ q: url.searchParams.get("q") ?? undefined, tag: url.searchParams.get("tag") ?? undefined, archived: url.searchParams.get("archived") === "1" })))
    .on("POST", "/api/docs", async (req) => {
      const b = await body<{ title?: string; body?: string; tags?: string[] }>(req);
      return json(docs.create(b, "you"), 201);
    })
    .on("GET", "/api/docs/:id", (_req, p) => json(docs.full(docId(p))))
    // The markdown alone, for a task's Claude Code (jin-task doc).
    .on("GET", "/api/docs/:id/markdown", (_req, p) => {
      const d = docs.get(docId(p));
      return new Response(`# ${d.title}\n\n${d.body}`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    })
    .on("PUT", "/api/docs/:id", async (req, p) => {
      const b = await body<{ title?: string; body?: string; tags?: string[]; base: number }>(req);
      if (typeof b.base !== "number") throw new HttpError(400, "base (the version you edited) is required");
      return json(docs.save(docId(p), b, b.base, "you"));
    })
    // Rename ({title}) or archive ({archived}).
    .on("PATCH", "/api/docs/:id", async (req, p) => {
      const b = await body<{ archived?: boolean; title?: string }>(req);
      const id = docId(p);
      if (typeof b.title === "string") docs.rename(id, b.title);
      if (b.archived !== undefined) docs.archive(id, b.archived);
      return json(docs.get(id));
    })
    .on("POST", "/api/docs/:id/duplicate", (_req, p) => json(docs.duplicate(docId(p), "you"), 201))
    .on("DELETE", "/api/docs/:id", (_req, p) => {
      const { chatId } = docs.remove(docId(p));
      if (chatId) onDeleted?.(chatId);
      return json({ deleted: true });
    })
    .on("GET", "/api/docs/:id/versions", (_req, p) => json(docs.versions(docId(p))))
    .on("GET", "/api/docs/:id/versions/:v", (_req, p) => json(docs.version(docId(p), Number(p.v))))
    .on("POST", "/api/docs/:id/versions/:v/restore", async (req, p) => {
      const b = await body<{ base: number }>(req);
      return json(docs.restore(docId(p), Number(p.v), b.base));
    })
    .on("POST", "/api/docs/:id/threads", async (req, p) => {
      const id = docId(p);
      const b = await body<{ text: string; anchor?: Anchor | null }>(req);
      const t = docs.comment(id, { text: b.text, anchor: b.anchor ?? null }, "you");
      maybeAsk(id, t, b.text, true);
      return json(t, 201);
    })
    .on("POST", "/api/docs/:id/threads/:tid/comments", async (req, p) => {
      const id = docId(p);
      const b = await body<{ text: string }>(req);
      const t = docs.comment(id, { text: b.text, threadId: p.tid! }, "you");
      maybeAsk(id, t, b.text, false);
      return json(t, 201);
    })
    .on("PATCH", "/api/docs/:id/threads/:tid", async (req, p) => {
      const b = await body<{ resolved?: boolean }>(req);
      return json(docs.resolve(docId(p), p.tid!, b.resolved !== false));
    })
    .on("POST", "/api/docs/:id/suggestions/:sid/:decision", async (req, p) => {
      if (p.decision !== "accept" && p.decision !== "reject") throw new HttpError(404, "accept or reject");
      const b = await body<{ base?: number }>(req).catch(() => ({}) as { base?: number });
      return json(docs.decide(docId(p), p.sid!, p.decision === "accept", b.base));
    })
    // jin's doc tools, for an agent on another machine (a room's agents: docs live here, on the home).
    .on("POST", "/api/doc-tools/:name", async (req, p, url) => {
      const tool = docTools(docs, agentBy(url.searchParams.get("by"))).find((t) => t.name === p.name);
      if (!tool) throw new HttpError(404, `no doc tool ${p.name}`);
      return json(await tool.run(await body<Record<string, unknown>>(req)));
    })
    // Ask jin in the doc's chat (started on first use).
    .on("POST", "/api/docs/:id/ask", async (req, p) => {
      if (!ask) throw new HttpError(501, "jin's chats are not on this machine");
      const b = await body<{ prompt: string; model?: string; effort?: string }>(req);
      if (!b.prompt?.trim()) throw new HttpError(400, "prompt is required");
      return json(ask.ask(docId(p), b.prompt, readChoice(b)), 201);
    });
}
