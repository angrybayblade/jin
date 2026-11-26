import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { exportHistory, type History, importHistory } from "./history";
import { HttpError } from "./http";

/**
 * Moving jin's home (the always-on hub) from one machine to another: everything that lives on the
 * home goes with it. Chats (with Claude's transcripts) and approvals, the desk's feed, docs,
 * long-term memory, and the files behind the desk and notifications: Composio's settings,
 * project and log cursor, the GitHub watch, the Slack threads you are in, event hooks,
 * notification settings, skills, and the chats' folders. What a task owns stays on its machine.
 *
 * The machine giving it up stops running the desk first (and remembers, so it does not start
 * again after a restart); the one taking it brings the rows in with the moved copy winning, so
 * moving back and forth never leaves stale chats or docs behind.
 */

/** Files in $JIN_HOME that belong to the home. */
export const HOME_FILES = [
  "composio.json",
  "composio/.composio/project.json",
  "composio-cursor.json",
  "slack-names.json",
  "notion-names.json",
  "slack-threads.json",
  "hooks.json",
  "hook-runs.json",
  "github-watch.json",
  "watched-threads.json",
  "watched-owners.json",
  "notifications.json",
  "skills.json",
  "involvement-v1",
];
/** Folders in $JIN_HOME that belong to the home, with everything in them. */
export const HOME_DIRS = ["chats", "skills"];
/** Tables that belong to the home, parents first. */
export const HOME_TABLES = ["docs", "doc_versions", "doc_threads", "doc_comments", "doc_suggestions", "doc_notion", "memory", "task_context"];

const MAX_FILE = 8 * 1024 * 1024;
const MAX_FILES = 48 * 1024 * 1024;
/** Written on a machine that gave the home up: it no longer runs the desk, even after a restart. */
const NOT_HOME = "not-home";

type Row = Record<string, unknown>;

export interface HomeBundle {
  format: 1;
  history: History;
  tables: Record<string, Row[]>;
  /** Paths relative to $JIN_HOME, base64. */
  files: Record<string, string>;
}

export interface Moved {
  sessions: number;
  transcripts: number;
  feed: number;
  docs: number;
  memory: number;
  files: number;
  /** The moved home has Composio events on. */
  composio?: boolean;
  /** What the new home still needs for its desk ("composio": signing in to the composio CLI there). */
  needs?: string[];
}

const tableExists = (db: Database, t: string) => Boolean(db.query("select 1 from sqlite_master where type = 'table' and name = ?").get(t));

/** Everything the home holds, to hand to the machine taking it over. */
export function exportHome(db: Database, home: string, opts: { claudeDir?: string } = {}): HomeBundle {
  const tables: Record<string, Row[]> = {};
  for (const t of HOME_TABLES) if (tableExists(db, t)) tables[t] = db.query(`select * from ${t}`).all() as Row[];
  const files: Record<string, string> = {};
  let size = 0;
  const add = (rel: string) => {
    const p = join(home, rel);
    try {
      const st = statSync(p);
      if (!st.isFile() || st.size > MAX_FILE || size + st.size > MAX_FILES) return;
      size += st.size;
      files[rel] = readFileSync(p).toString("base64");
    } catch {
      // not there: nothing to move
    }
  };
  for (const f of HOME_FILES) add(f);
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) add(relative(home, p));
    }
  };
  for (const d of HOME_DIRS) walk(join(home, d));
  return { format: 1, history: exportHistory(db, { claudeDir: opts.claudeDir }), tables, files };
}

/** Upsert a row, keeping only the columns this jin has (a newer jin's extra columns are left out). */
function upserter(db: Database) {
  const known = new Map<string, { cols: Set<string>; pk: string[] }>();
  const info = (t: string) => {
    if (!known.has(t)) {
      const rows = db.query(`pragma table_info(${t})`).all() as { name: string; pk: number }[];
      known.set(t, { cols: new Set(rows.map((r) => r.name)), pk: rows.filter((r) => r.pk > 0).sort((a, b) => a.pk - b.pk).map((r) => r.name) });
    }
    return known.get(t)!;
  };
  return (t: string, row: Row) => {
    const { cols: have, pk } = info(t);
    const cols = Object.keys(row).filter((c) => have.has(c));
    if (!cols.length) return 0;
    const rest = cols.filter((c) => !pk.includes(c));
    // An update, never a delete and insert: a replaced doc would take its versions and links with it.
    const onConflict = pk.length ? (rest.length ? ` on conflict (${pk.join(",")}) do update set ${rest.map((c) => `${c} = excluded.${c}`).join(", ")}` : " on conflict do nothing") : "";
    return db.query(`insert into ${t} (${cols.join(",")}) values (${cols.map(() => "?").join(",")})${onConflict}`).run(...(cols.map((c) => row[c]) as never[])).changes;
  };
}

/** Take the home over: rows in (the moved copy wins), files written, this machine runs the desk again. */
export function importHome(db: Database, home: string, b: HomeBundle, opts: { claudeDir?: string } = {}): Moved {
  if (b?.format !== 1) throw new HttpError(400, "not a jin home bundle (or one from a newer jin)");
  const h = importHistory(db, b.history, { home, claudeDir: opts.claudeDir, replace: true });
  const put = upserter(db);
  const counts: Moved = { sessions: h.sessions, transcripts: h.transcripts, feed: h.feed, docs: 0, memory: 0, files: 0 };
  db.transaction(() => {
    for (const t of HOME_TABLES) {
      if (!tableExists(db, t)) continue;
      for (const r of b.tables[t] ?? []) {
        const n = put(t, r);
        if (t === "docs") counts.docs += n;
        if (t === "memory") counts.memory += n;
      }
    }
  })();
  for (const [rel, b64] of Object.entries(b.files ?? {})) {
    if (rel.includes("..") || rel.startsWith("/")) continue;
    const dest = join(home, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(b64, "base64"), { mode: 0o600 });
    counts.files++;
  }
  rmSync(join(home, NOT_HOME), { force: true });
  return counts;
}

/** This machine gave the home up (or takes it back, `false`). */
export function setNotHome(home: string, given: boolean) {
  if (given) writeFileSync(join(home, NOT_HOME), `${new Date().toISOString()}\n`);
  else rmSync(join(home, NOT_HOME), { force: true });
}

export const gaveUpHome = (home: string) => existsSync(join(home, NOT_HOME));
