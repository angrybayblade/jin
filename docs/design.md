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
| Where it runs | Local (laptop) or a private VM. Same build; the VM enables the always-on features (not built yet). |
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
  GitHub uses `gh`; the others use the user's MCP servers (claude.ai connectors do not load in
  SDK sessions, so they come from `cws connect`, i.e. user-level servers). Gmail has none yet.
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
- **Bobby badges** on every pull request (feed, desks, chat links) open the PR's review in
  Bobby (`~/bobby`) in a new tab, starting Bobby if it is not running. Bobby forbids framing
  by design, so it is not embedded.

## Look and feel

- Zero's design system and thermal WebGL marks (logo, favicon, status and loading).
- Light and dark themes app-wide (System/Light/Dark, cookie, no flash) and per pane.
  Terminals and the editor have both palettes and follow their pane.
- Density: compact (default) or comfortable. Collapsible sidebar (Cmd+B), resizable sidebar
  and panes, hideable side pane, remembered per browser and applied before first paint.

## Data model (SQLite)

`workspaces` · `feed_items` · `tasks` (Jin's metadata and removed tasks) · `sessions` (kind:
jin, a desk, or task) · `events` · `approvals` · `terminals` (tabs, Claude Code session ids).

## Status and next

Built: everything above. The v0 acceptance suite (`bun run acceptance`) passes 18/18 next to
a running dev server; unit tests with `bun test apps`.

Next:

1. **New task** from the UI, with setup running in the background and live progress.
2. **Desktop shell** with Electrobun: inset title bar, an Edit menu (paste needs it in
   WebKit), Cmd+W/T/1-9 for Jin's tabs, the daemon in process, a Dock badge when an agent
   waits. A spike confirmed xterm (WebGL), Monaco and the thermal shader work in its WebKit view.
3. **Desks that work**: a setup check and one-click connect per desk; a Gmail MCP server.
4. **Feed**: snoozed items coming back, Linear in the feed, a ranking pass.
5. **VM mode**: scheduled briefs and PR watches.
