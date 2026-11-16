# jin

A personal orchestrator: catches you up, helps you prioritise, and runs coding
agents in your organisation's workspace. Single-user; runs locally or on a
private VM.

- [Design](docs/design.md): decisions, shape, workspace adapters, command
  center, agents, policy, milestones.
- [Security surfaces](docs/security.md): everything a hosted, multi-tenant
  Jin would have to handle, and what the single-user version relies on.

## Run (v0)

Requirements: Bun 1.4 (daemon), Node 24 (Next.js), `gh` logged in, Claude Code
logged in for real sessions, and a workspace to point at.

```bash
bun install

# 1. Tell jin about your workspace (one file per organisation)
mkdir -p ~/.jin/workspaces
cat > ~/.jin/workspaces/composio.yaml <<'EOF'
id: composio
adapter: composio
root: ~/composio-workspace        # absolute path
github:
  owners: [ComposioHQ]
EOF

# 2. Daemon (loopback only; writes ~/.jin/daemon.json with its token)
bun run --cwd apps/daemon start

# 3. Command center on http://127.0.0.1:3917
bun run --cwd apps/web build && bun run --cwd apps/web start -- -p 3917 -H 127.0.0.1
```

`~/.jin/config.yaml` sets `mode: local` (default) or `mode: vm` for the
always-on features (not built yet).

## Layout

- `apps/daemon` (Bun): config, SQLite, workspace adapters (composio over
  `cws`), GitHub collector, policy, Claude sessions (Agent SDK) with deny
  hooks and approvals, websocket event streams.
- `apps/web` (Next.js): command center and session views on Zero's design
  system, with a dark set for coding views.
- `tests/acceptance`: the v0 acceptance suite (`bun run acceptance`), black
  box, with fake `gh` and `cws`; unit tests with `bun test apps`.

Status: v0. See the milestones in the design doc for what comes next.
