import type { Database } from "bun:sqlite";
import { body, json, type Router } from "./http";

/** jin's chats (with their events and approvals) and feed items, for moving them to a home (hub). */
export interface History {
  sessions: Record<string, unknown>[];
  events: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
  feed: Record<string, unknown>[];
}

/** Chats and desks (not task sessions: those belong to their machine's tasks) and the feed. */
export function exportHistory(db: Database): History {
  const sessions = db.query("select * from sessions where kind != 'task' order by created_at").all() as Record<string, unknown>[];
  const ids = sessions.map((s) => s.id as string);
  const inIds = (table: string) =>
    ids.length ? (db.query(`select * from ${table} where session_id in (${ids.map(() => "?").join(",")}) order by ${table === "events" ? "seq" : "created_at"}`).all(...ids) as Record<string, unknown>[]) : [];
  return {
    sessions,
    events: inIds("events").map(({ seq: _seq, ...e }) => e),
    approvals: inIds("approvals"),
    feed: db.query("select * from feed_items order by received_at").all() as Record<string, unknown>[],
  };
}

/**
 * Bring history in. Rows already here are kept. A moved chat reads as before but starts a new
 * conversation with Claude when continued (its transcript stayed on the old machine); one
 * that was running is idle, and an approval that was waiting has expired.
 */
export function importHistory(db: Database, h: History): { sessions: number; events: number; approvals: number; feed: number } {
  const insert = (table: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    return db.query(`insert or ignore into ${table} (${cols.join(",")}) values (${cols.map(() => "?").join(",")})`).run(...(cols.map((c) => row[c]) as never[])).changes;
  };
  const counts = { sessions: 0, events: 0, approvals: 0, feed: 0 };
  db.transaction(() => {
    const fresh = new Set<string>();
    for (const s of h.sessions ?? []) {
      const state = s.state === "running" || s.state === "waiting_approval" ? "idle" : s.state;
      if (insert("sessions", { ...s, state, harness_session_id: null, cwd: null })) {
        counts.sessions++;
        fresh.add(s.id as string);
      }
    }
    // Events only for chats that are new here, so moving twice does not double them.
    for (const e of h.events ?? []) if (fresh.has(e.session_id as string)) counts.events += insert("events", e);
    for (const a of h.approvals ?? []) counts.approvals += insert("approvals", { ...a, state: a.state === "pending" ? "expired" : a.state });
    for (const f of h.feed ?? []) counts.feed += insert("feed_items", f);
  })();
  return counts;
}

export function historyRoutes(router: Router, db: Database) {
  router
    .on("GET", "/api/history/export", () => json(exportHistory(db)))
    .on("POST", "/api/history/import", async (req) => json(importHistory(db, await body<History>(req))));
}
