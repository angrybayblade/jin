# Jin: design (v0 draft)

Jin is a personal orchestrator for one engineer's work: it catches you up, helps
you decide what matters, and runs coding agents on the chosen work inside your
organisation's workspace. It runs on your own machine or on a private VM you
control. It is single-user by design; what a hosted, multi-tenant Jin would have
to add is in [security.md](security.md).

Inspired by ComposioHQ/zen, but deliberately not a copy: Zen is a hosted,
multi-tenant platform (E2B sandboxes, Temporal, PostgreSQL, KMS, a GitHub App,
OIDC). Jin keeps the product ideas and drops the multi-tenant machinery, which
is most of Zen's code.

## Decisions

| | Decision |
| --- | --- |
| Users | Only me. No organisations, roles or sharing inside Jin. |
| Where it runs | Local (laptop) or a private VM. Same build; the VM enables the always-on features. |
| Hosting | Private VMs only for now. Multi-tenant hosting is out of scope and documented in security.md. |
| Workspaces | Pluggable. composio-workspace is the first adapter; another organisation's workspace is another adapter. Jin's core knows nothing about Composio. |
| Agents | Claude first (Claude Agent SDK). Codex runs in the background for tasks that need no plugins or integrations. |
| Credentials | Jin stores none. Integrations come from the agent harness's own connectors; GitHub from the machine's `gh` login; secrets from the workspace's own tooling (Doppler for Composio). |
| Repo | `angrybayblade/jin`, private, separate from any organisation's workspace. |
| UI | Next.js (App Router, React) for the web app; a separate daemon owns every long-lived process. |

## Non-goals (v0)

- Multi-user anything: sharing, teams, ACLs, tenancy.
- Sandboxing agents from the machine. On a private VM the VM is the boundary;
  on a laptop the agent runs as you, the same as Claude Code does today.
- Replacing the workspace's own tooling. Jin calls `cws`; it does not
  reimplement tasks, review, the map or the local stack.
- A custom editor or terminal. Jin embeds an existing one.

## Shape

```
                       Browser (localhost, or the VM over SSH tunnel / Tailscale)
                                          │
┌──────────────────────────────── apps/web (Next.js) ─────────────────────────────────┐
│ Command center ── catch-up feed, priorities, approvals, tasks, sessions, editor,    │
│ terminal (Monaco, xterm.js, embedded code-server)                                   │
└──────────────────────────────────────────┬──────────────────────────────────────────┘
                                HTTP + websockets (loopback)
┌──────────────────────────────── apps/daemon (Bun) ──────────────────────────────────┐
│ Feed collectors        Task runner               Session manager       Scheduler    │
│ (gh, Claude+MCP)       (workspace adapter)       (Claude SDK, Codex)   (VM only)    │
│                                                                                     │
│ Policy (hooks, deny rules, approvals)        SQLite (feed, tasks, sessions, events) │
└──────────────┬───────────────────────────────┬──────────────────────┬───────────────┘
               │                               │                      │
     Workspace adapter                 Agent harnesses          Editor + terminal
     (composio: cws CLI)               claude / codex           code-server on a task dir
```

No queue or workflow engine. Durable state is SQLite rows; long-running work
is agent processes Jin supervises and can reattach to after a restart
(sessions are resumable by id).

### Two apps

| | `apps/web` | `apps/daemon` |
| --- | --- | --- |
| What | Next.js (App Router): command center, tasks, sessions, approvals, editor and terminal views | Sessions (Agent SDK, Codex), PTYs, websockets, code-server proxy, collectors, scheduler, SQLite |
| Why separate | UI that is complex enough to need React: Monaco, xterm.js, live streams | Next.js route handlers have no websockets and are not a place for long-lived processes |
| Talks to the other | Typed HTTP API plus one websocket per view (session stream, terminal) | Serves the API and websockets on loopback |

- **Editor:** code-server embedded for full editing (extensions, git, its own
  terminal); Monaco in the web app for diffs and quick file views of what an
  agent changed.
- **Terminal:** xterm.js in the browser, a PTY in the daemon, over a
  websocket. To verify before building: `node-pty` is a native Node addon and
  may not load under Bun; the daemon either runs on Node or uses a PTY that
  Bun supports.
- **Shared contracts:** `packages/contract` (Zod schemas) used by both, so
  the API and websocket messages are validated at both ends.

## Deployment modes

| Feature | Local | Private VM |
| --- | --- | --- |
| Command center, catch-up on demand | yes | yes |
| Start tasks, agent sessions, editor, terminal | yes | yes |
| Scheduled briefs (e.g. 08:30 every weekday) | off | yes |
| PR watches that wake a session | off | yes |
| Background Codex queue running unattended | off, or only while Jin is open | yes |

`mode: local | vm` in Jin's config. Local mode never registers timers, so a
sleeping laptop cannot leave half-finished scheduled work; anything scheduled
shows as "needs the VM". On the VM Jin binds to 127.0.0.1 only and is reached
over an SSH tunnel or Tailscale; it never listens on a public interface.

## Workspace adapters (plug and play)

Jin's core works with a small interface; each organisation's workspace
provides an adapter. Adapters are configuration first and code only where
needed, so pointing Jin at a new organisation does not mean changing Jin or the
organisation's repos.

```ts
interface WorkspaceAdapter {
  id: string;                         // "composio"
  root: string;                       // ~/composio-workspace
  repos(): Promise<Repo[]>;           // name, path, branch, description
  startTask(t: { id: string; type?: string; repos: string[]; slug: string }): Promise<TaskDirs>;
  removeTask(id: string): Promise<void>;
  check?(taskId: string): Promise<CommandResult>;    // lint/typecheck/test
  review?(taskId: string): Promise<ReviewResult>;    // contextual review
  stack?: { up(taskId?: string): Promise<void>; down(): Promise<void> };
  context?(): Promise<ContextFiles>;  // map, skills, instructions for the agent
  policy(): Policy;                   // deny rules + outward actions needing approval
}
```

- **composio adapter**: wraps `cws` (`cws task new ... --setup`,
  `cws task rm`, `cws check`, `cws review --task`, `cws up --task`,
  `docs/map/`, `.claude/skills/composio-platform`). Its policy is the deploy
  and publish rules in `cli/src/adapters.ts` plus CLAUDE.md's outward actions.
- **git adapter** (fallback for an organisation without a workspace): a
  directory of clones; a task is a branch plus `git worktree` per repo; no
  check, review or stack unless configured as commands.
- Adapters are declared in `~/.jin/workspaces/<id>.yaml` (command templates
  for the config-only case, or a module path for a code adapter).

**Organisation isolation.** Each workspace profile gets its own harness
config directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), so one organisation's
Slack, Linear or Gmail connectors and logins are never visible to sessions
working on another organisation's code. Feed items, tasks and sessions carry
their workspace id and are filtered by the active profile.

## Command center

The core of Jin: open it and know what to do next.

**Catch-up feed.** Collectors produce normalized items:

| Source | How | Examples |
| --- | --- | --- |
| GitHub | `gh` directly (cheap, deterministic) | reviews requested, your PRs with red CI or new comments, mentions |
| Linear | Claude session with the Linear connector | assigned issues, cycle changes, comments on your issues |
| Slack | Claude + Slack connector | DMs and mentions since you last looked, threads you're in |
| Gmail | Claude + Gmail connector | mail needing a reply, calendar-related |
| Notion | Claude + Notion connector | comments and mentions |
| Jin itself | local | finished/blocked sessions, approvals waiting, failed checks |

```ts
type FeedItem = {
  id: string; workspace: string; source: "github" | "linear" | "slack" | "gmail" | "notion" | "jin";
  externalRef: string;          // URL or id, for dedupe and "open"
  title: string; summary: string;
  receivedAt: string; seenAt?: string;
  priority?: { score: number; why: string };   // from the ranking pass
  state: "new" | "snoozed" | "done" | "dismissed" | "promoted";
  taskId?: string;              // when promoted to a task
};
```

**Ranking.** One Claude pass over new items with your context (current tasks,
cycle, what you dismissed before) produces a score and a one-line reason. The
reason is shown, so a ranking can be corrected rather than trusted blindly.

**Actions from an item.** Start a task (Linear issue → `startTask` with repos
suggested from the map, then a session), draft a reply (Slack/Gmail/Linear;
sending is an approval, below), snooze, dismiss, open the source.

**Catch-up brief.** "Catch me up" renders the top items as a short brief:
what changed since you last looked, what is blocked on you, what can wait.
On the VM it can be generated on a schedule so it is ready when you open Jin.

## Agent sessions

- **Claude (interactive and integration work).** Started through the Claude
  Agent SDK in the task's directory, with the workspace profile's config dir
  (its connectors) and Jin's policy hooks. Streamed into the session view;
  resumable by session id after Jin restarts.
- **Codex (background, no integrations).** `codex exec` for well-specified
  code-only work: fix lint, write tests for a module, apply a mechanical
  refactor, address review comments already captured in the task. Jin only
  routes a task to Codex when it needs no MCP tools; the session gets no
  connector access by construction.
- **Routing.** Explicit by default (you choose); Jin suggests Codex when the
  task is code-only. A Codex result comes back as a diff in the task, never as
  a pushed branch.

## Policy and approvals

The workspace's rules must hold even when an agent runs commands natively.
Today `cws` refuses deploys only for commands that go through `cws`; an agent
can still run `pulumi up` directly. Jin closes that gap:

- **Deny hooks.** A PreToolUse hook on every Claude session checks shell
  commands against the adapter's deny rules (deploy, publish, release,
  `pulumi up`, `vercel --prod`, workflow triggers, Doppler writes) and blocks
  them. Codex runs with its sandbox in workspace-write mode and no network
  beyond what the task needs where possible.
- **Approvals.** Outward actions are not denied but held: `git push`, opening
  or commenting on PRs, Slack and Gmail sends, Linear updates. The session
  pauses, the command center shows the exact action, and it runs only after
  you approve it.
- **Audit.** Every tool call, approval and denial is an event row, so "what
  did the agent do while I was away" has an answer.

## Editor and terminal

Embed code-server (or openvscode-server) instead of building an editor. One
instance per Jin, bound to localhost, proxied by Jin under its own auth, and
opened on the task's directory (`tasks/<ID>/` for Composio). It brings the
editor, terminal, git and extensions. The session view also links to the files
the agent changed.

## Data model (SQLite)

`workspaces` (id, adapter, root, profile dirs) · `feed_items` · `tasks` (id,
workspace, source item, repos, dirs, state) · `sessions` (id, task, harness,
harness session id, state, cost) · `events` (session, kind, payload, at) ·
`approvals` (session, action, state, decided_at) · `schedules` (VM only) ·
`watches` (VM only: PR url, filter, expires).

## Milestones

- **v0: command center + start a task.** GitHub and Linear collectors, Slack
  and Gmail next; ranking; promote an item to a composio task; one Claude
  session per task with deny hooks and approvals; local mode only.
- **v1: editor and terminal**, per task; the git adapter so a second
  organisation can be plugged in; Codex background sessions.
- **v2: always-on.** VM mode: scheduled briefs, PR watches that wake a
  session, the unattended Codex queue; sending replies from the feed (always
  through approvals).

## Open questions

- Daemon runtime: Bun or Node, decided by PTY support (see Two apps).
- How much catch-up runs through Claude with connectors vs direct APIs: the
  connector route keeps Jin credential-free but costs a model call per refresh.
- Whether Jin should read Zen-style durable instructions per workspace (an
  `AGENTS.md`-like file in the adapter) or rely on each workspace's own
  CLAUDE.md and skills. Leaning on the workspace's own files.
