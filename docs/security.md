# Jin: security surfaces

Jin runs only on private VMs (or a laptop) for one person. This document lists
every surface that would need handling before Jin could be offered as a
hosted, multi-tenant service, what the single-user version relies on today,
and how ComposioHQ/zen handles the same surface where it does.

The single-user model leans on one fact: **the person, the machine and the
credentials belong to the same principal.** An agent running as you on your VM
can only do what you could do. Every item below is a place where that stops
being true once a second user exists.

## Threat model in one paragraph

A hosted Jin runs untrusted-by-default work (agent-written code, repository
scripts, model output steered by Slack messages, emails and web pages) next to
high-value credentials (GitHub, Slack, Gmail, Linear, Notion, cloud and
Doppler secrets, model subscriptions) for many users. The main risks are one
tenant reaching another's data or credentials, an agent being steered by
injected content into an outward action, and credentials leaking into places
that persist (logs, workspace files, model context, workflow history).

## Surfaces

### 1. Identity and authentication

- **Single-user today:** the daemon and the web server bind to 127.0.0.1 only
  (`next start -H 127.0.0.1`: without it Next listens on every interface).
  The daemon requires a token from `~/.jin/daemon.json` (mode 0600) and refuses
  browser origins other than the web app's. The web app talks to the daemon
  from its server; the browser never holds the token and opens websockets with
  one-time tickets (one connection, one path, within a minute); the daemon
  takes its token only from the Authorization header, never from a URL (where
  it would reach logs). Access to a VM is an SSH tunnel or Tailscale. Being on
  the machine is the authentication.
  Binding to loopback is not enough on its own: a web page elsewhere can point
  a name of its own at 127.0.0.1 (DNS rebinding) and read the web app as if it
  were jin. The web app therefore answers only requests addressed to
  127.0.0.1 or localhost (plus names listed in `JIN_WEB_HOSTS`, for jin
  reached by a Tailscale name: see 8c); anything else gets 421 (`apps/web/src/proxy.ts`,
  acceptance S02). The daemon refuses foreign origins and needs its token.
- **Multi-tenant needs:** a real identity provider (OIDC), sessions, MFA and
  recovery delegated to it; service-to-service auth between UI, API and
  workers; no development bypass outside a dev environment, failing closed.
- **Zen:** OIDC behind an `Authentication` service; local bypass only when
  `ZEN_ENVIRONMENT=dev`; production auth not enabled yet.

### 2. Authorization and tenant isolation (data)

- **Single-user today:** none needed; one SQLite file, one owner.
- **Multi-tenant needs:** every row scoped to a tenant and owner; enforcement
  in the data layer, not only in handlers; no cross-tenant joins; opaque ids;
  tests that try to read another tenant's feed items, sessions, events and
  approvals. Feed content (email, DMs) is among the most sensitive data a
  company has.
- **Zen:** Zen-owned organisation and role records; authorization always
  resolved from them; skills and memory ACL-bound to owner and workspace.

### 3. Compute isolation for agents

- **Single-user today:** agents run as you on your VM; the VM is the
  boundary. Repository scripts, `pnpm install` hooks and agent-written code
  run with your privileges by design.
- **Multi-tenant needs:** one isolated sandbox per user (or per conversation)
  with no shared kernel-level state: microVMs (Firecracker/E2B) or gVisor, not
  plain containers on a shared host; no host Docker socket; resource limits;
  pause/resume and cleanup that never hands one user's filesystem to another;
  snapshot hygiene (no secrets baked into shared snapshots).
- **Zen:** provider-neutral sandbox service, E2B Firecracker microVMs, idle
  pause after two minutes, unprivileged agent user, Docker inside the
  sandbox, curated snapshot layered on a reproducible template.

### 4. Credential custody

- **Single-user today:** Jin stores no credentials. The harness logins
  (Claude, Codex), connectors, `gh` and Doppler live on the VM under your
  account, as they would on your laptop.
- **Multi-tenant needs:** a credential store with envelope encryption (KMS),
  per-tenant keys and associated data, rotation and revocation; separate
  scopes for platform-owned and user-owned credentials; short-lived
  credentials wherever possible (GitHub App installation tokens instead of
  personal tokens); OAuth grants held by a broker (e.g. Composio) rather than
  copied into Jin.
- **Zen:** AWS KMS envelope encryption (LocalStack locally); GitHub App with
  short-lived installation tokens, personal tokens refused; Composio owns
  third-party OAuth grants and refresh; Zen-owned and user-owned scopes kept
  separate.

### 5. Credentials inside the sandbox

- **Single-user today:** the agent can read anything you can, including
  `~/.config/gh`, Doppler and harness tokens. Acceptable because they are
  yours.
- **Multi-tenant needs:** no raw credential ever enters the sandbox. Git,
  `gh`, model calls and secrets go through brokers outside the sandbox that
  authorize per request; secrets injected only into a child process's
  environment, never files or command lines; Doppler (or any secret manager)
  through a broker that allows only development configs and disables offline
  fallback files.
- **Zen:** brokered `git`/`gh`; `zen secrets run --project X --config dev`
  through a hardened Doppler wrapper; model calls through a sampling gateway;
  "no provider API key is present in the sandbox".

### 6. Prompt injection and outward actions

- **Single-user today:** the largest real risk even for one user. Slack
  messages, emails, PR comments, issue text and web pages are read by an agent
  that can push code and send messages. Mitigation (`apps/daemon/src/policy.ts`):
  - deny rules for deploys, releases, publishing and secret changes;
  - approvals for every outward action: push, PR, comment, send, an issue
    update, and curl or wget sending data to any host but this machine;
  - agents never reach jin's own credentials (the daemon's token, other
    machines' tokens, the Composio settings), its database or SSH private keys,
    and never call jin's approvals API: with the token an agent could approve
    its own actions, and injected content could ask it to;
  - every agent that reads outside content (jin's chat, the desks, a doc's
    chat, room agents, hooks) is told it is data, never instructions; a hook's
    event (what someone else wrote) is passed as such.
  Agents run as the user, so these are guardrails against a misled model, not a
  sandbox: a determined process can do what the user can. Read-only agents in a
  task's room are held by refusing their file edits and the shell commands that
  plainly change a worktree, not by the operating system.
- **Multi-tenant needs:** the same, plus: content from one tenant can never
  reach another tenant's agent; approvals bound to the authenticated user who
  owns the session; approval UIs that show the exact action (diff, recipient,
  text); rate limits on outward actions; provenance on every message an agent
  sends.
- **Zen:** directive that memory, repository files, tool results and other
  conversations cannot grant authorization; PR-watch notifications "grant no
  additional permission to merge or write"; Slack approvals.

### 7. Production and deployment safety

- **Single-user today:** jin's deny rules (deploy, release, publish,
  production and secret changes; per simple command, looking through `sh -c`,
  `eval` and `npx`/`bunx`/`dlx`) apply to every agent: SDK chats through a
  PreToolUse hook that blocks on failure plus `canUseTool`, and Claude Code
  through a PreToolUse command hook (from `claude --settings`) that fails
  closed for shell commands when the daemon cannot be reached. Outward actions
  are approvals (SDK chats) or Claude Code's own permission prompt. `cws`
  itself only refuses commands that go through it.
- **Multi-tenant needs:** the same rules enforced outside the agent (in the
  broker: the GitHub App cannot trigger workflows or push to protected
  branches; secrets brokers expose no production configs); per-organisation
  policy that admins, not users, control.

### 8. The editor and terminal

- **Single-user today:** daemon-owned PTYs (shells and Claude Code) over
  ticketed websockets, and a file API confined to the task directory (paths
  resolved through symlinks; files over 1 MB and binaries refused). A
  terminal is remote code execution by design; acceptable only because the
  only user is the owner and everything is on loopback. Terminals do not run
  jin's agent policy (the user is typing); Claude Code in them gets jin's rules
  through its hooks. The daemon drops a parent Claude Code session's variables
  at start, including its messaging token, so they never reach these
  processes.
- **Multi-tenant needs:** the editor runs inside the user's sandbox, never
  on a shared host; per-session auth on the editor's websocket; no shared
  extension directory; extension allowlist (Open VSX supply chain); CSRF and
  origin checks on the proxy.

### 8a. Companion apps (Bobby)

- **Single-user today:** jin links pull requests to their review in Bobby
  (`~/bobby`), found through Bobby's own lock file and started with
  `bobby start` if needed. Reviews open in your browser (the daemon runs
  `open` on the review URL, nothing else): Bobby forbids
  framing (`frame-ancestors 'none'`) so another page cannot steer a click onto
  Approve, and its page asks before building a review it has never seen.
- **Multi-tenant needs:** per-user companion processes inside the user's
  sandbox, never a shared one holding a person's `gh` login; any embedding
  allowed only for the exact app origin.

### 8b. Remote machines

- **Single-user today:** jin reaches a machine with your own `ssh` (keys,
  agent, `~/.ssh/config`; BatchMode, so it never prompts and never stores a
  password). Its daemon listens on that machine's loopback only, and this
  machine reaches it through an SSH tunnel bound to this machine's loopback.
  The remote daemon's token is kept in `$JIN_HOME/machines/<id>.json` (mode
  0600) and read only by jin's web server. The remote daemon accepts only this
  jin's web origin. Sign-ins (gh, Claude Code, Doppler) run on the machine and
  their credentials stay there; jin copies none across. A Doppler service token,
  when used, travels over ssh's stdin, never on a command line. gh on a Linux
  machine without a keyring keeps its token in a plain file, as gh does.
  A new machine's host key is trusted on first use (`StrictHostKeyChecking=accept-new`),
  as ssh does for a host you have not connected to; a changed key afterwards is refused.
- **Multi-tenant needs:** machines are per user and never shared; tunnels
  authenticated per user; no stored daemon tokens outside the user's own
  machine.

### 9. Network

- **Single-user today:** jin listens on loopback only, on your Mac and on each
  machine; machines are reached over SSH. Agents have the machine's outbound
  access.
- **Multi-tenant needs:** egress policy per sandbox (deny by default, allow
  package registries and required APIs), no access to cloud metadata
  endpoints or internal networks, port exposure only through an authenticated
  proxy, DNS and SSRF controls for any fetch the platform does on a user's
  behalf.
- **Zen:** sandbox network policy is part of the provider-neutral contract;
  public HTTPS gateway required for local Claude turns.

### 10. Model providers and terms

- **Single-user today:** your own Claude and Codex logins, used by you.
- **Multi-tenant needs:** consumer subscriptions cannot be pooled or shared
  across users; a hosted product needs API or enterprise agreements, per-user
  attribution, spend limits, and a decision on whether user content may be
  used for training (it must not be, for company data).
- **Zen:** per-owner provider connections ("personal Claude", "personal
  Codex") with a credential bank and usage reads.

### 11. Data retention, privacy and deletion

- **Single-user today:** SQLite on your VM; you decide.
- **Multi-tenant needs:** retention limits for feed content and transcripts;
  per-user export and deletion that covers backups, snapshots and logs;
  encryption at rest; regional residency if customers require it; a list of
  every place user content persists (database, object storage, sandbox
  snapshots, workflow history, telemetry, model provider).

### 12. Logging, telemetry and audit

- **Single-user today:** event rows in SQLite, local logs.
- **Multi-tenant needs:** redaction before export (no secrets or message
  bodies in traces); tamper-evident audit log of tool calls, approvals and
  admin actions; per-tenant access to their own audit trail; alerting on
  denied actions and anomalous outward activity.
- **Zen:** OpenTelemetry with export redaction; Temporal history kept
  secret-free.

### 13. Durable workflows and queues

- **Single-user today:** none; supervised processes and SQLite.
- **Multi-tenant needs:** if a workflow engine is added, payloads bounded and
  secret-free, per-tenant fairness and limits, idempotent activities so
  retries never repeat an outward action.
- **Zen:** Temporal owns retries and timers; payloads bounded and secret-free;
  events persisted before they are published.

### 14. Supply chain

- **Single-user today:** your pinned dependencies; the workspace's own repos.
- **Multi-tenant needs:** pinned and verified sandbox images, minimum release
  age for new packages, SBOMs, signature and provenance checks, review gate on
  base image upgrades, and no mutable tags anywhere in images that run user
  code.
- **Zen:** exact pins, seven-day minimum release age, checksum, registry
  signature and provenance checks, CycloneDX SBOM before promotion.

### 15. Abuse, cost and availability

- **Multi-tenant needs:** per-user quotas on sandboxes, model spend and
  outward actions; protection against crypto-mining and spam from sandboxes;
  noisy-neighbour limits; graceful degradation when a provider is down.

### 16. Multiple organisations per user

- **Single-user today:** each workspace profile has its own harness config
  directory, so one organisation's connectors and logins never reach another
  organisation's sessions; feed and tasks are filtered by profile.
- **Multi-tenant needs:** organisation membership as the unit of isolation
  for code, credentials and feed; a user who belongs to two organisations
  must not be able to move data between them through an agent (cross-org
  exfiltration via prompt or tool use).

### 17. Incident response

- **Multi-tenant needs:** the ability to revoke all of one user's or one
  organisation's credentials at once, kill their sandboxes, and reconstruct
  what an agent did from the audit log; documented contacts and timelines.

## What changes first if Jin goes multi-tenant

In order of risk, not effort: compute isolation (3), credentials out of the
sandbox (5), tenant-scoped data (2), outward-action approvals bound to the
owner (6), identity (1). The single-user design keeps the seams for these:
the workspace adapter, the harness profile per organisation, policy hooks, and
approvals as data. It does not implement them.
