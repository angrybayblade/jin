import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { body, json, type Router } from "./http";

/** A chat's Claude transcript (`<id>.jsonl`, plus the folder of the same name some keep beside it). */
export interface Transcript {
  sessionId: string;
  /** Path under the project folder → base64 contents. */
  files: Record<string, string>;
}

/** Claude Code files a conversation under a folder named after its working directory. */
export const projectFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

const MAX_TRANSCRIPTS = 64 * 1024 * 1024; // bytes, all together

/** Find a session's transcript in any project folder (the working directory may have moved). */
function readTranscript(claudeDir: string, sessionId: string): Transcript | null {
  const projects = join(claudeDir, "projects");
  if (!existsSync(projects)) return null;
  for (const folder of readdirSync(projects)) {
    const base = join(projects, folder);
    const main = join(base, `${sessionId}.jsonl`);
    if (!existsSync(main)) continue;
    const files: Record<string, string> = { [`${sessionId}.jsonl`]: readFileSync(main).toString("base64") };
    const extra = join(base, sessionId);
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else files[relative(base, p)] = readFileSync(p).toString("base64");
      }
    };
    if (existsSync(extra) && statSync(extra).isDirectory()) walk(extra);
    return { sessionId, files };
  }
  return null;
}

/** jin's chats (with their events and approvals) and feed items, for moving them to a home (hub). */
export interface History {
  transcripts?: Transcript[];
  sessions: Record<string, unknown>[];
  events: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
  feed: Record<string, unknown>[];
}

/** Chats and desks (not task sessions: those belong to their machine's tasks) and the feed. */
export function exportHistory(db: Database, opts: { claudeDir?: string } = {}): History {
  // Unset fields are left out, so a jin without a newer column can still take the chat.
  const sessions = (db.query("select * from sessions where kind != 'task' order by created_at").all() as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)));
  const ids = sessions.map((s) => s.id as string);
  const inIds = (table: string) =>
    ids.length ? (db.query(`select * from ${table} where session_id in (${ids.map(() => "?").join(",")}) order by ${table === "events" ? "seq" : "created_at"}`).all(...ids) as Record<string, unknown>[]) : [];
  // Claude's own memory of each chat, so it continues where it left off on the other machine.
  const transcripts: Transcript[] = [];
  let size = 0;
  for (const sess of sessions) {
    const id = sess.harness_session_id as string | null;
    const t = id ? readTranscript(opts.claudeDir ?? defaultClaudeDir(), id) : null;
    if (!t) continue;
    const bytes = Object.values(t.files).reduce((n, b) => n + b.length, 0);
    if (size + bytes > MAX_TRANSCRIPTS) break;
    size += bytes;
    transcripts.push(t);
  }
  return {
    transcripts,
    sessions,
    events: inIds("events").map(({ seq: _seq, ...e }) => e),
    approvals: inIds("approvals"),
    feed: db.query("select * from feed_items order by received_at").all() as Record<string, unknown>[],
  };
}

export const defaultClaudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

/**
 * Bring history in. Rows already here are kept. A moved chat whose Claude transcript came
 * along is filed under this machine's chats/<kind> folder and continues with its memory;
 * without one it reads as before but starts a fresh conversation. One that was running is
 * idle, and an approval that was waiting has expired.
 */
export function importHistory(db: Database, h: History, opts: { home?: string; claudeDir?: string; replace?: boolean } = {}): { sessions: number; events: number; approvals: number; feed: number; transcripts: number } {
  // A row from a newer jin may carry columns this one does not have yet: those are left out.
  const known = new Map<string, Set<string>>();
  const columns = (table: string) => {
    if (!known.has(table)) known.set(table, new Set((db.query(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name)));
    return known.get(table)!;
  };
  // With `replace` (the home moving here), the moved copy wins over a row already here; else it is kept.
  const insert = (table: string, row: Record<string, unknown>) => {
    const have = columns(table);
    const cols = Object.keys(row).filter((c) => have.has(c));
    const rest = cols.filter((c) => c !== "id");
    const upsert = opts.replace && table !== "events" && cols.includes("id") && rest.length ? ` on conflict (id) do update set ${rest.map((c) => `${c} = excluded.${c}`).join(", ")}` : "";
    return db.query(`insert ${upsert ? "" : "or ignore "}into ${table} (${cols.join(",")}) values (${cols.map(() => "?").join(",")})${upsert}`).run(...(cols.map((c) => row[c]) as never[])).changes;
  };
  const counts = { sessions: 0, events: 0, approvals: 0, feed: 0, transcripts: 0 };
  const byId = new Map((h.transcripts ?? []).map((t) => [t.sessionId, t]));
  db.transaction(() => {
    const fresh = new Set<string>();
    for (const s of h.sessions ?? []) {
      const state = s.state === "running" || s.state === "waiting_approval" ? "idle" : s.state;
      // A chat runs in this machine's chats/<kind> folder; with its transcript filed there, Claude resumes it.
      const cwd = opts.home ? join(opts.home, "chats", String(s.kind)) : null;
      const t = s.harness_session_id ? byId.get(String(s.harness_session_id)) : undefined;
      let resumable = false;
      if (t && cwd) {
        mkdirSync(cwd, { recursive: true });
        const base = join(opts.claudeDir ?? defaultClaudeDir(), "projects", projectFolder(cwd));
        for (const [rel, b64] of Object.entries(t.files)) {
          if (rel.includes("..")) continue;
          const dest = join(base, rel);
          mkdirSync(dirname(dest), { recursive: true });
          if (opts.replace || !existsSync(dest)) writeFileSync(dest, Buffer.from(b64, "base64"), { mode: 0o600 });
        }
        resumable = true;
      }
      if (insert("sessions", { ...s, state, harness_session_id: resumable ? s.harness_session_id : null, cwd })) {
        if (resumable) counts.transcripts++;
        counts.sessions++;
        fresh.add(s.id as string);
      }
    }
    // Replacing: a chat moved here before gets all its events again, as they are now.
    if (opts.replace && fresh.size) {
      const ids = [...fresh];
      db.query(`delete from events where session_id in (${ids.map(() => "?").join(",")})`).run(...ids);
    }
    // Events only for chats that are new here, so moving twice does not double them.
    for (const e of h.events ?? []) if (fresh.has(e.session_id as string)) counts.events += insert("events", e);
    for (const a of h.approvals ?? []) counts.approvals += insert("approvals", { ...a, state: a.state === "pending" ? "expired" : a.state });
    // The same item already here under another id (this machine read the same PR or message itself): the moved one wins.
    const sameItem = opts.replace ? db.query("delete from feed_items where workspace = ? and source = ? and kind = ? and external_ref = ? and id != ?") : null;
    for (const f of h.feed ?? []) {
      sameItem?.run(f.workspace as string, f.source as string, f.kind as string, f.external_ref as string, f.id as string);
      counts.feed += insert("feed_items", f);
    }
  })();
  return counts;
}

export function historyRoutes(router: Router, db: Database, opts: { home: string; claudeDir?: () => string | undefined }) {
  router
    .on("GET", "/api/history/export", () => json(exportHistory(db, { claudeDir: opts.claudeDir?.() })))
    .on("POST", "/api/history/import", async (req) => json(importHistory(db, await body<History>(req), { home: opts.home, claudeDir: opts.claudeDir?.() })));
}
