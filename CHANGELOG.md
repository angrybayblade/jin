# Changelog

## Unreleased

- **pi and opencode on a machine's Sign-ins card.** Each shows the providers it holds a
  credential for; opencode signs in there with ChatGPT (a device code), and pi's row says to
  run `/login` in a pi tab, the only way pi signs in.

- **opencode as a machine's agent.** Pick opencode and its tabs, task chats and agent rooms
  run opencode (its own models and sign-ins). jin's plugin, passed per launch, checks every
  tool call: a tab sets every tool to ask and answers what jin allows, so a push or message
  shows opencode's own prompt; a chat or room waits on jin's approvals.

- **pi as a machine's agent.** Pick pi for a machine and its terminal tabs, task chats and
  agent rooms run pi (with its own models and sign-ins). jin's pi extension checks every
  tool call and pi waits for the answer: a tab asks in pi's own prompt, a chat or room in
  jin's approvals; a read-only room agent's edits are refused.
- **Fix: `git -C <dir> push` (and other git options before the subcommand) now asks first**,
  like `git push`, for every agent.

- **Codex as a machine's agent.** Settings → Claude Code (or a machine's card) picks the
  coding agent new sessions start: Claude Code or Codex, each with its own setup and sign-in
  there. A Codex tab gets jin's hooks (trusted through Codex's app-server before it starts,
  or it does not start), the task's rules and jin's journal tools; deploys and jin's secrets
  are denied, and outward actions wait for your approval in Codex's sandbox prompt. A task's
  chats and agent rooms run on Codex too (through its app-server, approvals in jin, jin's
  tools through a bridge); jin's chat, desks and doc chats stay on Claude. A machine's
  Sign-ins card signs in to Codex with a device code.

- **A repo as a workspace.** The git provider takes one clone as well as a folder of them.
  Setup (and a machine's Workspace card) clones a repo you name (`owner/repo` or a git URL)
  into `~/repos/<name>` and uses it, next to any workspace already there; tasks are worktrees
  beside the clone.

## 0.1.0 (2026-11-22)

The first tagged version of jin: a single-user orchestrator that catches you up, helps you
prioritise and runs coding agents in your workspace, on your Mac and on machines you reach
over SSH.

### What is in it

- **Tasks.** Worktrees per task from a workspace provider (`cws` or plain `git`): changes,
  pull-request reviews and scratch tasks you throw away whole. Each task has Claude Code and
  shell terminals that survive restarts, files, docs, PR badges and an activity panel.
- **Agent rooms.** A Room tab per task where preset or custom roles (design, engineering,
  review, …) answer your @-mentions: readers in parallel, writers in turn, each seeing the
  others' final messages and the room since its last turn. A task starts with a Claude
  session or a room; plain sessions stay available next to it.
- **jin's chat and desks.** Agent SDK chats that list machines and tasks, catch you up and
  start work; desks over GitHub and, through Composio, Slack, Gmail, Linear and Notion.
- **Policy and approvals.** Outward actions ask first; agents cannot reach jin's credentials,
  database, SSH keys or approvals; outside content is treated as data.
- **Machines and a home.** Add any SSH host; jin installs itself there, tunnels to it, and can
  make one machine the always-on hub for chats, the feed and approvals.
- **Pluggable boundaries.** Workspace providers and issue trackers (`linear`, `github`,
  `none`) are contracts, with composio-workspace as one provider among them.
- **Failure handling.** Failed actions show the real reason; background failures collect in
  Settings → Problems; interrupted jobs and room turns resume or say they stopped.
- **Desktop app.** A macOS window with its own title bar, a collapsible sidebar, tabs with
  ⌘T/⌘W/⌘1–9 and a Dock badge for what waits on you.
- **Checks.** `bun run check` (types, daemon tests, the black-box acceptance suite and WebKit
  smoke checks) runs on every push.

Versions now come from `git describe`: a deploy of this tag reports `v0.1.0`, later commits
`v0.1.0-<n>-g<commit>`.

### Known limitations

Summarised from [docs/limitations.md](docs/limitations.md), which has the details:

- Single user; macOS for the app.
- Agents are held by guardrails, not a sandbox (read-only room agents included).
- Room agents run only on your @-mentions; long rooms are not summarised yet.
- Event sources (feed and desks) come through Composio only.
- Linear issue links appear once jin has seen one Linear URL since it last started.
- Opening jin by a Tailscale name lacks terminals and live chats; use an SSH tunnel.
- Some failures still fall back quietly instead of reaching Problems.
