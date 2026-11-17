# jin

A personal orchestrator: catches you up, helps you prioritise, and runs coding agents in
your organisation's workspace. Single-user; runs locally or on a private VM.

- [Design](docs/design.md): what jin is and how it fits together, and what is next.
- [Security surfaces](docs/security.md): what the single-user version relies on, and
  everything a hosted, multi-tenant jin would have to handle.

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
export JIN_HOME=/tmp/jin-dev && mkdir -p $JIN_HOME
printf 'port: 7417\nwebOrigin: http://127.0.0.1:3937\n' > $JIN_HOME/config.yaml
bun run --cwd apps/daemon start                                   # daemon on 7417
(cd apps/web && JIN_WEB_DIST=.next-dev bunx next dev -H 127.0.0.1 -p 3937)
# desktop window against it: (cd apps/desktop && JIN_URL=http://127.0.0.1:3937 hutch electrobun dev)
```

`$JIN_HOME/config.yaml` (all optional):

```yaml
mode: local              # vm on a machine without a desktop (no notifications); machines get this
model: claude-opus-5-5   # jin's chats and the Claude Code sessions jin starts
port: 7317               # the daemon's port
webOrigin: http://127.0.0.1:3917   # the only browser origin the daemon accepts
```

Workspaces are `$JIN_HOME/workspaces/<id>.yaml` (the setup page writes one). `adapter` names
the workspace provider: `cws` (composio-workspace) or `git` (a folder of git clones); GitHub
owners are read from the workspace when left out:

```yaml
id: repos
adapter: git
root: /Users/you/code
```

## Layout

- `apps/daemon` (Bun): workspace providers (`adapters/`: cws, git), the
  GitHub feed, persistent terminals (Claude Code and shells), Claude Code hooks, PRs on
  tasks, notifications, Agent SDK chats with approvals, policy, tickets, first-run setup,
  remote machines over ssh, SQLite.
- `apps/web` (Next.js): jin's chat, the task view (Claude Code and shell tabs, files, PR
  badges), desks, setup and machines, on Zero's design system with light/dark themes.
- `apps/desktop` (Electrobun): the macOS window; starts jin's services from the release.
- `tests/acceptance`: the v0 acceptance suite (`bun run acceptance`), black box, with fake
  `gh` and `cws` (and real local git repos for the git provider); runs on its own port next to a dev server. Unit tests: `bun test apps`.
