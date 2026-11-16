# jin

A personal orchestrator: catches you up, helps you prioritise, and runs coding agents in
your organisation's workspace. Single-user; runs locally or on a private VM.

- [Design](docs/design.md): what jin is and how it fits together, and what is next.
- [Security surfaces](docs/security.md): what the single-user version relies on, and
  everything a hosted, multi-tenant jin would have to handle.

## Run

Requirements: Bun 1.4 (daemon), Node 24 (Next.js), `gh` logged in, Claude Code logged in,
and a workspace (composio-workspace installs to `~/composio-workspace`).

```bash
bun install

# 1. Your workspace (one file per organisation)
mkdir -p ~/.jin/workspaces
cat > ~/.jin/workspaces/composio.yaml <<'EOF'
id: composio
adapter: composio
root: /Users/you/composio-workspace
github:
  owners: [ComposioHQ]
EOF

# 2. Daemon (loopback only; writes ~/.jin/daemon.json with its token)
bun run --cwd apps/daemon start

# 3. Web app on http://127.0.0.1:3917
bun run --cwd apps/web dev
# or: bun run --cwd apps/web build && PORT=3917 bun run --cwd apps/web start
```

`~/.jin/config.yaml` (all optional):

```yaml
mode: local              # or vm, for the always-on features (not built yet)
model: claude-opus-5-5   # jin's chats and the Claude Code sessions jin starts
```

## Layout

- `apps/daemon` (Bun): workspace adapters (composio over `cws` and `task.json`), the
  GitHub feed, persistent terminals (Claude Code and shells), Claude Code hooks, Agent SDK
  chats with approvals, policy, tickets, SQLite.
- `apps/web` (Next.js): jin's chat, the task view (Claude Code tabs, editor, shells, diff),
  desks, on Zero's design system with light/dark themes and compact density.
- `tests/acceptance`: the v0 acceptance suite (`bun run acceptance`), black box, with fake
  `gh` and `cws`; runs on its own port next to a dev server. Unit tests: `bun test apps`.
