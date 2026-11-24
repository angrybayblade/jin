# jin

A personal orchestrator: catches you up, helps you prioritise, and runs coding agents in
your organisation's workspace. Single-user; runs locally or on a private VM.

- [Design](docs/design.md): what jin is and how it fits together, and what is next.
- [Security surfaces](docs/security.md): what the single-user version relies on, and
  everything a hosted, multi-tenant jin would have to handle.
- [Known limitations](docs/limitations.md): what jin does not do yet, and what to do instead.
- [Changelog](CHANGELOG.md).

## Install (macOS)

Requirements: Bun 1.4, Node 24, git, and the hutch toolchain for the desktop build
(`HUTCH_HOME`, default `~/.jin/toolchain/hutch`).

```bash
bun install
./scripts/release-local.sh   # builds this commit into ~/.jin/release/app, installs ~/Applications/jin.app
```

Open jin from Applications. It starts its daemon (127.0.0.1:7317) and web app
(127.0.0.1:3917) when they are not running; logs go to `~/.jin/logs`. A fresh install opens
**Set up jin**: pick or install a composio workspace, and sign in to gh and Claude Code (each
sign-in opens your browser). Rerun the script to update; it restarts jin's services.

**Machines** (sidebar footer → Add a machine): any host you reach with `ssh`. jin installs
what it needs there, runs its own daemon, and switches the whole app to it through a tunnel.

## Develop

Run a development copy next to the installed app, with its own home and ports:

```bash
export JIN_HOME=$HOME/.jin-dev && mkdir -p $JIN_HOME   # not /tmp: macOS cleans it
cat > $JIN_HOME/config.yaml <<'YAML'
port: 7417
webOrigins: [http://127.0.0.1:3937]
machines:              # on machines it adds, its own jin beside the real one
  home: .jin-dev
  port: 7318
  service: jin-dev-daemon
  source: worktree     # copies this checkout's files as they are, uncommitted changes included
YAML
bun run --cwd apps/daemon start                                   # daemon on 7417
(cd apps/web && JIN_WEB_DIST=.next-dev bunx next dev --webpack -H 127.0.0.1 -p 3937)
# desktop window against it: (cd apps/desktop && JIN_URL=http://127.0.0.1:3937 hutch electrobun dev)
```

Machines added in the development copy get a second jin in `~/.jin-dev` on port 7318, next to
the real one in `~/.jin` on 7317; the two share only the tools (bun, gh, the agent CLIs) and
the workspace you point them at. "Update jin" on a machine there sends the working tree again.
Leave `machines:` out and a copy sets up the real jin, as the installed app does.

`$JIN_HOME/config.yaml` (all optional):

```yaml
mode: local              # vm on a machine without a desktop (no notifications); machines get this
model: claude-opus-5-5   # jin's chats and the Claude Code sessions jin starts
port: 7317               # the daemon's port
webOrigin: http://127.0.0.1:3917   # the only browser origin the daemon accepts
```

Workspaces are `$JIN_HOME/workspaces/<id>.yaml` (the setup page writes one; jin can use
several). `adapter` names the workspace provider: `cws` (composio-workspace) or `git` (one
git clone, or a folder of them); GitHub owners are read from the workspace when left out:

```yaml
id: web
adapter: git
root: /Users/you/repos/web   # a clone, or a folder whose subfolders are clones
tracker: github              # optional: linear, github or none
```

**Codex instead of Claude Code** (Machines → the machine → Coding agent): new agent
tabs, task chats and agent rooms on that machine run Codex, with its own `~/.codex` setup and
sign-in (a machine's Sign-ins card signs in with a device code). jin trusts its
hooks in Codex before the first start (a `hooks.state` entry in `~/.codex/config.toml`) and
runs Codex sandboxed with the network off, so outward actions ask you in the terminal. See
[security.md §8d](docs/security.md#8d-codex-as-a-machines-agent).

**pi instead** (same card): new tabs, task chats and agent rooms run pi with its own models
and sign-ins (`/login` in a pi tab). jin's extension checks every tool call; outward actions
ask in pi's prompt (tabs) or in jin (chats). See [security.md §8e](docs/security.md#8e-pi-as-a-machines-agent).

**opencode instead** (same card): tabs, task chats and agent rooms run opencode with its own
models and sign-ins. jin passes its plugin per launch (nothing written to your opencode
config); outward actions ask in opencode's prompt (tabs) or in jin (chats). See
[security.md §8f](docs/security.md#8f-opencode-as-a-machines-agent).

**A repo as a workspace** (Settings → Set up jin → Add another, or a machine's Workspace
card): type `owner/repo` or a git URL. jin clones it into `~/repos/<name>` (with `gh` for
GitHub, so private repos work with your sign-in) and uses it; a clone you already have is
used by its path. Tasks are git worktrees beside the clone, in `~/repos/.jin-tasks/<name>/`,
never inside it.

## Layout

- `apps/daemon` (Bun): workspace providers (`adapters/`: cws, git), the
  GitHub feed, persistent terminals (an agent, Claude Code or Codex, and shells), agent hooks, PRs on
  tasks, notifications, Agent SDK chats with approvals, policy, tickets, first-run setup,
  remote machines over ssh, SQLite.
- `apps/web` (Next.js): jin's chat, the task view (agent and shell tabs, files, PR
  badges), desks, setup and machines, on Zero's design system with light/dark themes.
- `apps/desktop` (Electrobun): the macOS window; starts jin's services from the release.
- `tests/acceptance`: the v0 acceptance suite (`bun run acceptance`), black box, with fake
  `gh` and `cws` (and real local git repos for the git provider); runs on its own port next to a dev server. Unit tests: `bun test apps`.
