# Jin: design

Jin is a personal orchestrator for one engineer's work: it catches you up, helps you decide
what matters, and runs coding agents on the chosen work inside your organisation's workspace.
It runs on your own machine or on a private VM you control. It is single-user by design; what
a hosted, multi-tenant Jin would have to add is in [security.md](security.md).

Inspired by ComposioHQ/zen, but deliberately not a copy: Zen is a hosted, multi-tenant
platform (E2B sandboxes, Temporal, PostgreSQL, KMS, a GitHub App, OIDC). Jin keeps the product
ideas and drops the multi-tenant machinery.

## Decisions

| | Decision |
| --- | --- |
| Users | Only me. No organisations, roles or sharing inside Jin. |
| Where it runs | Your Mac as a desktop app, and any machine you reach with `ssh` (a dev VM), each with its own daemon; the app switches between them. |
| Workspaces | Pluggable through workspace providers (cws, git); jin's core knows no particular workspace. Composio the platform (events, desks) stays a dependency, with the user's own key. |
| Tasks | The workspace is the source of truth for its tasks (the adapter is the task provider); Jin keeps only its own metadata. |
| Coding | Claude Code's own TUI, in persistent terminals in the browser. Jin's rules reach it through Claude Code hooks. |
| Chat | Jin's own chat and knowledge desks run on the Claude Agent SDK, with jin's tools and approvals. |
| Model | `claude-opus-5-5` by default for both (`model:` in `~/.jin/config.yaml`). |
| Credentials | Jin stores none. GitHub through the machine's `gh`; integrations through the user's Claude MCP servers; secrets through the workspace's own tooling. |
| UI | Next.js (App Router) on Zero's design system; a Bun daemon owns every long-lived process. |
| Repo | `angrybayblade/jin`, private. |

## Shape

```
              Browser (or the desktop shell), on loopback; a VM over SSH tunnel / Tailscale
                                          │
┌──────────────────────────────── apps/web (Next.js) ───────────────────────────────────┐
│ Sidebar: Jin · Tasks (Claude Code status) · Desks (GitHub, Slack, Linear, Notion, Gmail) │
│ Jin's chat + Today feed · Task view: Claude Code tabs | editor, shell and diff tabs      │
│ Server components and actions talk to the daemon with its token; the browser gets       │
│ one-time tickets for websockets (live chat, terminals) and never sees the token.        │
└──────────────────────────────────────────┬────────────────────────────────────────────┘
                                HTTP + websockets (loopback)
┌──────────────────────────────── apps/daemon (Bun) ────────────────────────────────────┐
│ Workspace providers (cws, git)                  Feed (GitHub collector)                │
│ Terminals: PTYs + headless xterm, saved tabs     Sessions: Agent SDK chats + approvals  │
│ Claude Code hooks: policy + status               Files and diffs, confined to the task  │
│ Policy (deny, ask)   Tickets   Bobby companion   SQLite (feed, tasks, sessions, events,  │
│                                                  approvals, terminals)                  │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

No queue or workflow engine. Durable state is SQLite; long-running work is processes the
daemon owns.

## Workspaces and tasks

jin's core knows no particular workspace. A **workspace provider** (`apps/daemon/src/adapters/`)
implements the contract in `adapters/types.ts`, in two halves:

```ts
interface WorkspaceProvider {           // a kind of workspace, before one is in jin
  id; label; description;               // `adapter: <id>` in ~/.jin/workspaces/<id>.yaml
  taskKinds: TaskKindSpec[];            // change / review: id hints, change types, notes
  detectScript(): string;               // sh, here or over SSH: FOUND/PREFERRED <root>
  check: string;                        // sh: is $ROOT one of these?
  install?: { defaultRoot; script;      // sh installer (absent: point jin at one)
              source? };                // what it installs from, asked of the user (a repo): $SOURCE
  defaultId; idFor?(root); owners(root); // its config
  tools(): ToolSpec[];                  // extra machine tools: install, status, sign-in, token
  create(config): WorkspaceAdapter;
}
interface WorkspaceAdapter {            // one configured workspace
  repos(); listTasks();                 // the workspace is the source of truth for its tasks
  startTask(spec, { setup, onOutput }); removeTask(id); nextTaskId?(kind);
  agentBrief(task): AgentBrief;         // what Claude Code is told: start, notes, readable, setup, rules
  checkCommands?(): RegExp[];           // its checks count as test runs in the journal
  policy(): PolicyRules;                // extra deny/ask rules
}
```

- **cws** (composio-workspace): repos from `workspace.yaml` and `.gitmodules`; tasks from
  `tasks/*/task.json` as `cws task list` reads them; creation and removal through the
  workspace's own `bin/cws` (a change is `task new linear`, its id the Linear issue's, which
  becomes the task's `issue`). Its brief names TASK.md, the map and `cws install`/`up`; it
  declares Doppler as a tool and installs with its own `install.sh`.
- **git**: one git clone, or a folder whose subfolders are clones; a task is a worktree per
  repo (a branch for a change, detached at the PR head for a review), kept outside the clones:
  `<folder>/.jin-tasks/<id>/` for a folder, `<clone>/../.jin-tasks/<repo>/<id>/` for one
  clone. Its installer clones a repo the user names (`owner/repo` with gh, or a git URL) into
  `~/repos/<name>`, as a workspace named after it. No tooling of its own, no extra tools. It
  is what proves the core stands alone (acceptance A27, A28).
- A task's issue (`task.issue`) comes from its workspace, never from the shape of its id.
- Jin's `tasks` table keeps only Jin's metadata (the feed item a task came from) and records
  of removed tasks. `listTasks()` is synchronous for local files and would serve a cached
  snapshot for a remote provider.
- Each workspace may set `profile.claudeConfigDir` to keep its connectors and logins apart
  (that directory needs its own `claude` login); unset means the machine's default login.

## Task view: Claude Code in the browser

- **Terminals are daemon-owned tabs.** Each is a SQLite record plus, while running, a PTY
  (Bun's built-in terminal) and a headless xterm that keeps the screen. Closing or reloading
  the page only detaches; re-attaching replays the screen, then streams.
- **Several per task:** Claude Code sessions (Claude 1, 2, ...) in the main pane, shells
  (Terminal 1, 2, ...) and open files in the workspace pane.
- **Resume after restarts.** Claude Code's hooks report its session id (it changes on
  `/clear`). A daemon restart stops the processes but keeps the tabs; showing one again starts
  `claude --resume <id>`.
- **The browser side** is xterm.js with the WebGL renderer, Unicode 11 widths, OSC 52
  clipboard, clickable links, Shift+Enter as a newline and Cmd+C on a selection.
- **Claude Code is launched by Jin** as `claude --settings ~/.jin/claude/settings.json --model <model>`,
  in the task's folder (each task keeps its own conversations) with `--add-dir <workspace root>`
  so the whole workspace is readable; jin's appended prompt names the task and jin's rules
  (attach PRs, sub-tasks, the journal), around the workspace's own brief.
- **Sub-tasks**: Claude Code can split work into its own task and PR with `jin-task spawn <ID>
  --repos … --slug … --prompt …` (asks the user first); jin records the parent, nests it in the
  sidebar, and `jin-task subtasks` reports each one's setup, Claude Code status and PRs.
  The settings add only Jin's hooks (merged with the user's own), so nothing is written into
  the repos.
- **Editor**: file tree and Monaco with tabs (remembered per task), Cmd+S saves into the
  worktree. **Diff**: uncommitted changes per repo.
- The daemon drops a parent Claude Code session's variables at start (child-session marker,
  messaging token), which would otherwise turn transcript saving off in every session it runs.

## Chat and desks (Agent SDK)

- **Jin's chat** (home) has Jin's own tools as an in-process MCP server: catch up, refresh
  GitHub, list repos and tasks, start a task, hand it to Claude Code (opens a Claude Code tab
  with the prompt), and update feed items.
- **Desks** (GitHub, Slack, Linear, Notion, Gmail) are chats with their own instructions.
  GitHub uses `gh`; the others use the user's claude.ai connectors (Gmail, Slack, Linear,
  Notion) and user-level MCP servers. Connectors connect in the background, so those desks
  hold the first message until they are up (at most 15s).
- Replies stream live: text deltas go to open websockets and are not stored; the complete
  message is recorded at the end of the turn.

## Policy and approvals

Jin's rules apply to every agent it runs, whatever the workspace:

- **deny**: deploys, releases, publishing, production and secret changes (Pulumi, Terraform,
  Vercel, wrangler, kubectl, helm, docker push, `gh workflow run`, `gh release`, Doppler
  writes, package publishing, deploy-like package scripts). Checked per simple command,
  looking through `sh -c`, `eval`, `npx`/`bunx`/`dlx` and env assignments.
- **ask**: outward actions: `git push`, PR and issue writes, GitHub API writes, MCP tools that
  send or change something.
- **SDK chats**: a PreToolUse hook (blocking on failure) plus `canUseTool` route every call
  through the gate; "ask" holds the call as an approval in the UI.
- **Claude Code**: Jin's PreToolUse hook denies what Jin never runs, answers "ask" for
  outward actions (Claude Code shows its own permission prompt), and otherwise stays silent so
  Claude Code's own permission rules apply, exactly as in a terminal. If the daemon cannot be
  reached, shell commands are blocked.

## Command center

- **Feed**: the GitHub collector (one `gh api graphql` query: review requests, failing
  checks on the user's PRs, mentions), split by each workspace's GitHub owners, de-duplicated.
- **Involvement**: live events are kept only when they involve you, and the same rule decides
  notifications. GitHub: authored, asked of you directly (`user-review-requested:@me`) or reviewed,
  mentioned. Slack: DMs, mentions, and threads you are in (`slack-threads.json`: threads you wrote
  in or were mentioned in, seeded from Slack search, kept a month; a reply's `parent_user_id`).
  Notion: your page (its creator), a discussion you wrote or were tagged in, a comment tagging you;
  your Notion user id is found by the bot owner's email among the workspace's users. Linear:
  assignee, creator, mention, subscriber. A key a task follows is kept as `linked`, quietly.
- **Desk triage and life cycle** (on the machine holding the feed): every 20 s a small model
  triages new items in batches (bucket, severity, action, work or personal, why, a task hint);
  until then the rule lanes stand in. A thread belongs to a task by the task's links (machines
  push their tasks' keys to the home), not by the model. Every 2 minutes the Slack read marker of
  each conversation (`last_read`) marks items seen, and clears read FYI ones; thread replies are
  left, as Slack keeps no read marker per thread. Read items, and items waiting over 2 hours, are
  judged against what happened since; handled ones go `stale` with why, and can be reopened.
- **Bobby badges** on every pull request (feed, desks, chat links, a task's PR badges) open
  the PR's review in Bobby (`~/bobby`) in your browser, starting Bobby if it is not running.
  The daemon opens the browser, since the desktop window cannot.

## Pull requests on tasks

- A task's PRs show as badges in its task bar (state, checks, review) and as a mark in the
  sidebar. They get there three ways: Claude Code's PostToolUse hook sees `gh pr create` (or a
  GitHub tool) and attaches the new PR; Claude Code is told, as a rule appended to its system
  prompt, to run `jin-task attach-pr <url>`; and every few minutes the daemon looks up PRs
  opened from each task's branches. Open PRs are refreshed from GitHub on the same timer.

## Notifications

- A desktop notification (with sound, if on) when a Claude Code turn or a chat finishes,
  something needs you, or a task's setup ends. Not when you are looking at that very tab;
  repeats are folded. Local mode only: a machine without a desktop has nobody to tell.

## Desktop app

- `apps/desktop` (Electrobun) is jin in a native window with jin's own title bar: the panes'
  top bars move the window, the window buttons sit in the sidebar, double-click follows the
  system setting. ⌘T, ⌘W and ⌘1–9 work on task and chat tabs; the Dock badge counts Claude
  Code sessions and approvals waiting on you.
- `scripts/release-local.sh` builds a frozen copy of the current commit in
  `~/.jin/release/app` (production web build) and installs `~/Applications/jin.app`. The app
  starts the daemon (7317) and the web server (3917) from there with your login shell's PATH
  when they are not running, and leaves them running when the window closes. Development uses
  its own `JIN_HOME` and ports next to it.

## Setup and machines

- **This machine** (`/setup`, where a fresh install starts): find a composio workspace in the
  usual places or install one with its own installer, and sign in to gh, Claude Code and
  Doppler. A workspace added there is live at once.
- **Remote machines** (`/machines`): add one by its ssh host. jin connects with your SSH keys
  and config, installs git, Bun, gh and Claude Code, copies its committed daemon to
  `~/.jin/app`, runs it as a systemd user service (or in the background without systemd), and
  keeps an SSH tunnel to it. Sign-ins run there and hand you their link and code; the
  workspace can be installed there or pointed at. The machine switcher (sidebar footer) points
  the whole app at that machine's daemon through the tunnel; jin copies no credentials across.
  A machine running an older jin is flagged; "Update jin there" brings it level. The sidebar
  lists every connected machine's tasks under its name (opening one switches to it), and a
  machine's notifications (it has no desktop: it keeps them) are collected and shown here.
  More than one jin can use a machine (`webOrigins`). jin finds a workspace already on a
  machine with every provider's detection script (cws: its `cws` link or the usual folders),
  and offers it before installing one.
- **Workspaces on a machine's page**: the main column lists them; the side panel manages the
  picked one (path, kind, repos, stop using it: `DELETE /api/setup/workspace/:id` removes its
  yaml, keeps its files, and refuses while tasks are open) or adds one (found, install or clone,
  a path).
- **Home (hub)**: any machine can be jin's always-on home. Your Mac's line to it also carries a
  reverse port (`-R`), over which the Mac attaches itself (`POST /api/machines/attach`), so the
  hub reaches the Mac without dialling into it. With a home, chats, desks, the feed and approvals
  come from the hub; task pages follow their machine; the Mac collects notices only from the
  hub; the hub runs the always-on timers (feed every 10 minutes, PR sync) and reaches the other
  machines with its own key (`POST /api/machines/key`, added once to exe.dev). "Move" copies the
  Mac's chats and feed there and has the hub connect to the Mac's other machines.
- **One orchestrator**: your Mac's jin (or, with a home, the hub) is the one you talk to; each machine's daemon owns its
  own tasks, sessions and approvals. jin's chat lists machines, lists tasks and catches you up
  across all of them, and starts tasks or Claude Code sessions on a chosen machine through its
  tunnel.

## Look and feel

- Zero's design system and thermal WebGL marks (logo, favicon, status and loading).
- Light and dark themes app-wide (System/Light/Dark, cookie, no flash) and per pane.
  Terminals and the editor have both palettes and follow their pane.
- Density: compact (default) or comfortable. Collapsible sidebar (Cmd+B), resizable sidebar
  and panes, hideable side pane, remembered per browser and applied before first paint.

## Data model (SQLite)

`workspaces` · `feed_items` · `tasks` (Jin's metadata and removed tasks) · `task_meta` (titles,
archive) · `task_prs` · `sessions` (kind: jin, a desk, or task) · `events` · `approvals` ·
`terminals` (tabs, Claude Code session ids). Remote machines are files in
`$JIN_HOME/machines` (mode 0600: each holds its daemon's token).

## Memory

One table, `memory`, holds every memory artifact; a task's journal is its rows.

- **Writing:** every agent in a task (terminal tabs of any coding agent, room agents) writes the
  task's rows with the `journal` tool: decisions with why, work done, findings. A row that
  replaces another names it (`supersedes`); the old one stays, marked. Every agent reads all of
  the task's rows (`task_context` for tabs, `task_journal` in the room).
- **Promoting:** only jin does it, when a task is done: the merge cleanup's first step, or
  **Wrap up** on any task (reviews, scratch tasks, abandoned work). It reads the task's rows
  and its records (`jin_task_memory`), and raises to long-term only what no record holds (the
  same row, `level = 'global'`, reworded where needed with the task's wording kept): decisions
  with their reason, and facts nobody wrote down. Work done stays in commits and PRs, and what
  threads and issues say stays there; one `summary` row points to them by id
  (`jin_keep_memory`). jin refuses to keep anything but decisions (with a reason) and findings,
  and anything long-term memory already says. Agents never promote.
- **Where it lives:** a task's rows on its machine; long-term rows on the home (promotion copies
  the row there under the same id, with its machine). Long-term memory is scoped by workspace.
- **Reading:** nothing long-term is loaded wholesale. Each task's **pre-context** is picked by a
  small model from the workspace's long-term rows (candidates: rows covering the task's words,
  then recent decisions) and stored as links (`task_context`), never copies; every agent in the
  task starts with it, and you add or remove picks in the task's journal. Beyond that, agents
  search with `memory_search` (full-text, SQLite FTS5).
- **Never stored:** Slack, Linear, Notion or GitHub content; only facts drawn from them, with
  their ids (`github:org/repo#n`, `linear:ID`), resolved live when read.
- **You:** the Memory page lists, searches, rewords and forgets long-term rows.

## Status and next

Released as 0.1.0 (see [CHANGELOG.md](../CHANGELOG.md)). `bun run check` runs the type
checks, the daemon tests, the acceptance suite and WebKit smoke checks, locally and on every
push.

What it does not do yet, and what to do instead: [limitations.md](limitations.md).
