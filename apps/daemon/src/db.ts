import { Database } from "bun:sqlite";
import { join } from "node:path";

// Ordered migrations; pragma user_version records how many have run.
const MIGRATIONS: string[] = [
  `
  create table workspaces (
    id text primary key,
    adapter text not null,
    root text not null,
    updated_at text not null
  );
  create table feed_items (
    id text primary key,
    workspace text not null,
    source text not null,
    kind text not null,
    external_ref text not null,
    title text not null,
    summary text not null default '',
    received_at text not null,
    seen_at text,
    snoozed_until text,
    priority_score real,
    priority_why text,
    state text not null default 'new',
    task_id text,
    unique (workspace, source, kind, external_ref)
  );
  create table tasks (
    id text primary key,
    workspace text not null,
    type text,
    slug text not null,
    repos text not null,
    dirs text not null,
    state text not null,
    source_item text,
    created_at text not null
  );
  create table sessions (
    id text primary key,
    task_id text not null,
    harness text not null,
    harness_session_id text,
    state text not null,
    created_at text not null
  );
  create table events (
    seq integer primary key autoincrement,
    session_id text not null,
    kind text not null,
    payload text not null,
    at text not null
  );
  create index events_session on events (session_id, seq);
  create table approvals (
    id text primary key,
    session_id text not null,
    action text not null,
    reason text not null,
    state text not null,
    created_at text not null,
    decided_at text
  );
  `,
  // Chats: a session is a task agent, jin's own chat, or a knowledge chat (Slack, Linear,
  // Notion, Gmail, GitHub). Only task agents have a task.
  `
  create table sessions_v2 (
    id text primary key,
    kind text not null default 'task',
    task_id text,
    workspace text,
    title text not null default '',
    cwd text,
    harness text not null,
    harness_session_id text,
    state text not null,
    created_at text not null
  );
  insert into sessions_v2 (id, kind, task_id, workspace, title, cwd, harness, harness_session_id, state, created_at)
    select s.id, 'task', s.task_id, t.workspace, coalesce(t.slug, ''), json_extract(t.dirs, '$.root'), s.harness, s.harness_session_id, s.state, s.created_at
    from sessions s left join tasks t on t.id = s.task_id;
  drop table sessions;
  alter table sessions_v2 rename to sessions;
  create index sessions_kind on sessions (kind, created_at);
  create index sessions_task on sessions (task_id, created_at);
  `,
  // Terminal tabs (Claude Code and shells) outlive the daemon as records; Claude Code's own
  // session id lets a tab resume its conversation after a restart.
  `
  create table terminals (
    id text primary key,
    task_id text,
    kind text not null,
    title text not null,
    cwd text not null,
    claude_session_id text,
    created_at text not null,
    closed_at text
  );
  create index terminals_task on terminals (task_id, created_at);
  `,
  // Jin's own view of things it does not own: a display title and archive flag for any
  // workspace task, and archive flags for chats and terminal tabs.
  `
  create table task_meta (
    task_id text primary key,
    title text,
    archived_at text
  );
  alter table sessions add column archived_at text;
  alter table terminals add column archived_at text;
  `,
  // 5: pull requests attached to tasks (by Claude Code's hooks, its jin-task command, or by hand).
  `
  create table task_prs (
    task_id text not null,
    url text not null,
    repo text not null,
    number integer not null,
    title text,
    state text,
    draft integer not null default 0,
    review text,
    checks text,
    head text,
    attached_by text not null,
    attached_at text not null,
    updated_at text,
    detached integer not null default 0,
    primary key (task_id, url)
  );
  `,
  // 6: a task started from another task's Claude Code (jin-task spawn) remembers its parent.
  `
  alter table task_meta add column parent_id text;
  `,
];

export function openDb(home: string): Database {
  const db = new Database(join(home, "jin.db"), { create: true, strict: true });
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
  const { user_version } = db.query("pragma user_version").get() as { user_version: number };
  for (let i = user_version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.exec(`pragma user_version = ${i + 1}`);
    })();
  }
  return db;
}

export const now = () => new Date().toISOString();
