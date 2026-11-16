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
| Workspaces | Pluggable through a workspace adapter. composio-workspace is the first; Jin's core knows nothing about Composio. |
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
│ Workspace adapters (composio: cws, task.json)   Feed (GitHub collector)                │
│ Terminals: PTYs + headless xterm, saved tabs     Sessions: Agent SDK chats + approvals  │
│ Claude Code hooks: policy + status               Files and diffs, confined to the task  │
│ Policy (deny, ask)   Tickets   Bobby companion   SQLite (feed, tasks, sessions, events,  │
│                                                  approvals, terminals)                  │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

No queue or workflow engine. Durable state is SQLite; long-running work is processes the
daemon owns.

## Workspaces and tasks

```ts
interface WorkspaceAdapter {
  config: WorkspaceConfig;            // ~/.jin/workspaces/<id>.yaml
  repos(): Promise<Repo[]>;
  listTasks(): ProviderTask[];        // the task provider: the workspace's own tasks
  startTask(spec): Promise<TaskDirs>; // composio: cws task new ... --setup
  removeTask(id): Promise<void>;      // composio: cws task rm
  policy(): PolicyRules;              // extra deny/ask rules
}
```

- **composio adapter**: repos from `workspace.yaml` and `.gitmodules`; tasks from
  `tasks/*/task.json` exactly as `cws task list` reads them (title from the branch); creation
  and removal through the workspace's own `bin/cws`. Tasks made with `cws` in a terminal show
  up in Jin; tasks removed there drop out.
- Jin's `tasks` table keeps only Jin's metadata (the feed item a task came from) and records
  of removed tasks.
- A future provider (plain git, another organisation's tooling, Linear-backed tasks)
  implements the same surface; `listTasks()` is synchronous for local files and would serve a
  cached snapshot for a remote provider.
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
- **Claude Code is launched by Jin** as `claude --settings ~/.jin/claude/settings.json --model <model>`.
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
  machine through its `cws` link (`~/.local/bin/cws` → `<workspace>/bin/cws`) or the usual
  folders, and offers it before installing one.
- **One orchestrator**: your Mac's jin is the one you talk to; each machine's daemon owns its
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

## Status and next

Built: everything above. The acceptance suite (`bun run acceptance`) passes 21/21 next to a
running dev server; unit tests with `bun run test`.

Before a release candidate: nothing open. Each desk says whether its connection is there
(`/api/desks`); the app re-renders when the daemons' change stamp (`/api/stamp`) moves, not on
a timer.

Later: feed (snoozed items coming back, Linear, a ranking pass); a plain-git workspace
adapter; scheduled briefs and PR watches on an always-on machine.
