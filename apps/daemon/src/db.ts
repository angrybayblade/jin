import { Database } from "bun:sqlite";
import { join } from "node:path";

// Ordered migrations; pragma user_version records how many have run.
export const MIGRATIONS: string[] = [
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
  // 7: feed items group by thread (a PR, a Linear issue, a Slack thread or DM, a Notion page,
  // a mail thread), and remember who acted.
  `
  alter table feed_items add column thread_key text;
  alter table feed_items add column thread_title text;
  alter table feed_items add column thread_ref text;
  alter table feed_items add column thread_url text;
  alter table feed_items add column actor text;
  `,
  // 8: a task's work journal: what Claude Code decided, did and found, by concern, with the
  // files, commits and test runs its hooks saw. Rows without a concern are changes nobody journaled.
  `
  create table journal (
    id text primary key,
    task_id text not null,
    terminal_id text,
    session text,
    concern text,
    kind text not null,
    text text not null,
    why text,
    refs text not null default '[]',
    at text not null
  );
  create index journal_task on journal (task_id, at);
  `,
  // 9: what a task follows (Slack threads and channels, Notion pages, Linear issues), linked by
  // hand; and Notion threads keyed by the page id without dashes, as links name them.
  `
  create table task_links (
    task_id text not null,
    key text not null,
    kind text not null,
    url text,
    label text not null,
    since text,
    added_at text not null,
    primary key (task_id, key)
  );
  update feed_items set thread_key = 'notion:' || lower(replace(substr(thread_key, 8), '-', '')) where thread_key like 'notion:%';
  `,
  // 10: a chat's model and effort, picked in the composer (null: jin's default).
  `
  alter table sessions add column model text;
  alter table sessions add column effort text;
  `,
  // 11: why an item might concern you (authored, reviewer, dm, mention, assigned, …), for the desk's triage.
  `
  alter table feed_items add column tags text;
  `,
  // 12: jin docs (specs, RFCs, notes) that you and jin work on: markdown, its versions, comment
  // threads anchored to a quote, and jin's suggested edits.
  `
  create table docs (
    id text primary key,
    title text not null,
    body text not null default '',
    tags text not null default '[]',
    version integer not null default 1,
    chat_id text,
    created_at text not null,
    updated_at text not null,
    archived_at text
  );
  create table doc_versions (
    doc_id text not null,
    version integer not null,
    title text not null,
    body text not null,
    by text not null,
    at text not null,
    primary key (doc_id, version)
  );
  create table doc_threads (
    id text primary key,
    doc_id text not null,
    quote text,
    prefix text,
    suffix text,
    by text not null,
    resolved_at text,
    created_at text not null
  );
  create index doc_threads_doc on doc_threads (doc_id, created_at);
  create table doc_comments (
    id text primary key,
    thread_id text not null,
    by text not null,
    text text not null,
    at text not null
  );
  create index doc_comments_thread on doc_comments (thread_id, at);
  create table doc_suggestions (
    id text primary key,
    doc_id text not null,
    quote text not null,
    prefix text,
    suffix text,
    replacement text not null,
    why text,
    by text not null,
    status text not null default 'open',
    created_at text not null,
    decided_at text
  );
  create index doc_suggestions_doc on doc_suggestions (doc_id, created_at);
  `,
  // 13: a task's agent room: its agents (profiles, each with a session of its own) and the
  // messages they and you post. An agent has seen the room up to last_seen.
  `
  create table rooms (task_id text primary key, created_at text not null);
  create table room_agents (
    id text primary key,
    task_id text not null,
    handle text not null,
    name text not null,
    brief text not null,
    access text not null,
    model text,
    effort text,
    color text not null,
    session_id text,
    last_seen integer not null default 0,
    position integer not null default 0,
    created_at text not null,
    unique (task_id, handle)
  );
  create table room_messages (
    seq integer primary key autoincrement,
    task_id text not null,
    author text not null,
    author_name text not null,
    author_handle text,
    kind text not null default 'message',
    text text not null,
    mentions text not null default '[]',
    pinned integer not null default 0,
    at text not null
  );
  create index room_messages_task on room_messages (task_id, seq);
  `,
  // 14: what an agent's turn made or changed (docs), shown with its message.
  `alter table room_messages add column refs text not null default '[]';`,
  // 15: task setups (jobs), kept across restarts.
  `create table task_jobs (id text primary key, started_at text not null, body text not null);`,
  // 16: an issue link is an issue from whichever tracker its key names ("linear:ENG-1").
  `update task_links set kind = 'issue' where kind = 'linear';`,
  // 17: machine settings jin changes at runtime (which coding agent new tabs start).
  `create table settings (key text primary key, value text not null);`,
  // 18: an agent tab runs one of several agents (Claude Code, Codex), and resumes its session.
  `
  alter table terminals rename column claude_session_id to agent_session_id;
  alter table terminals add column agent text;
  update terminals set kind = 'agent', agent = 'claude' where kind = 'claude';
  `,
  // 19: a room can have a name of its own (its tab says "Room" until it does).
  `alter table rooms add column name text;`,
  // 20: memory: every memory artifact in one table. A task's journal is its rows (level 'task');
  // promotion raises a row's level, so the journal and long-term memory are the same row. A row
  // that replaces another names it (supersedes) and the old one is kept, marked.
  `
  alter table journal rename to memory;
  alter table memory add column level text not null default 'task';
  alter table memory add column workspace text;
  alter table memory add column status text not null default 'active';
  alter table memory add column supersedes text;
  alter table memory add column promoted_at text;
  alter table memory add column promoted_by text;
  update memory set workspace = (select workspace from tasks where tasks.id = memory.task_id);
  drop index if exists journal_task;
  create index memory_task on memory (task_id, at);
  create index memory_scope on memory (level, workspace);
  `,
  // 21: memory is searched by its words: a full-text index over each row's text, reason and
  // concern, kept in step with the table.
  `
  create virtual table memory_fts using fts5(text, why, concern, content = 'memory', content_rowid = 'rowid');
  insert into memory_fts (memory_fts) values ('rebuild');
  create trigger memory_fts_insert after insert on memory begin
    insert into memory_fts (rowid, text, why, concern) values (new.rowid, new.text, new.why, new.concern);
  end;
  create trigger memory_fts_delete after delete on memory begin
    insert into memory_fts (memory_fts, rowid, text, why, concern) values ('delete', old.rowid, old.text, old.why, old.concern);
  end;
  create trigger memory_fts_update after update of text, why, concern on memory begin
    insert into memory_fts (memory_fts, rowid, text, why, concern) values ('delete', old.rowid, old.text, old.why, old.concern);
    insert into memory_fts (rowid, text, why, concern) values (new.rowid, new.text, new.why, new.concern);
  end;
  `,
  // 22: promotion: a row reworded for long-term use keeps the task's wording; on the home, a
  // promoted row names the machine its task ran on.
  `
  alter table memory add column task_text text;
  alter table memory add column machine text;
  `,
  // 23: a task's pre-context: links to the long-term rows (on the home) jin picked for it, or you did.
  `create table task_context (task_id text not null, memory_id text not null, reason text, by text not null, at text not null, primary key (task_id, memory_id));`,
  // 24: a daemon from before memory (after a rollback) still has its \`journal\`: a view of memory
  // that takes its reads, inserts and evidence updates.
  `
  create view journal as select id, task_id, terminal_id, session, concern, kind, text, why, refs, at from memory;
  create trigger journal_insert instead of insert on journal begin
    insert into memory (id, task_id, terminal_id, session, concern, kind, text, why, refs, at) values (new.id, new.task_id, new.terminal_id, new.session, new.concern, new.kind, new.text, new.why, new.refs, new.at);
  end;
  create trigger journal_update instead of update on journal begin
    update memory set refs = new.refs, text = new.text, why = new.why, concern = new.concern where id = old.id;
  end;
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
