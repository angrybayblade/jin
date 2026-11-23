# Jin: known limitations

What jin 0.1.0 does not do, or does only partly, and what to do instead. Each item says
whether it is a design choice for a single-user tool or a gap to close.

## Scope

- **One person.** jin trusts whoever reaches 127.0.0.1 on your machine: there are no
  accounts, sign-in or roles. Everything a shared or hosted jin would need is listed in
  [security.md](security.md). *Design choice.*
- **macOS for the app; Linux (or macOS) for machines.** The desktop app, notifications and
  the Dock badge are macOS only. A machine is anything you reach with `ssh` that can run Bun;
  jin runs there as a systemd user service, or in the background without systemd. *Design
  choice for now.*

## Agents and safety

- **Guardrails, not a sandbox.** Agents run as you. jin's policy stops them reading its
  credentials, database and SSH keys, asks before outward actions and before `curl`/`wget`
  send data off the machine, and tells them never to follow instructions found in outside
  content. A misled model is stopped; a determined process running as you is not. The same
  holds for read-only room agents: they are kept from writing by tool patterns, not by an
  isolated filesystem. *Gap* for anything beyond one trusted user: see security.md §3.
- **Room agents answer only you.** An agent runs when you @-mention it; an agent mentioning
  another runs nobody. Agents see each other's final messages, not their reasoning. Each role
  keeps one resumed session, so a very long room grows those sessions until you clear the
  room (which starts every agent afresh and drops the messages); summarising and restarting
  an agent on its own is not built yet. There is no agent-kept state card:
  the room's outputs are its docs and the diff. *Deliberate for the first version.*

- **pi signs in on its own.** A pi machine's tabs, task chats and rooms run pi with its own
  models and sign-ins; sign in with `/login` in a pi tab there (the Sign-ins card does not
  cover pi yet). A pi session cannot be forked or moved, and jin's skills are Claude Code
  only. *Gap.*
- **Codex covers a task's work, not jin's own chats.** On a machine set to Codex, its
  terminal tabs, task chats and agent rooms run Codex; jin's chat, the desks and doc chats
  stay on Claude, since they work through claude.ai's connectors. A Codex tab cannot ask you
  before an outward MCP tool (jin blocks it; a task chat or room asks in jin), cannot be
  forked, and asks you before each `jin-task` command (Codex's sandbox keeps the network,
  localhost included, off). jin's skills are added to Claude Code only. *Gap*; opencode is not
  supported yet.

## Integrations

- **Workspaces and issue trackers are pluggable; event sources are not.** A workspace
  provider (`cws`, `git`) and an issue tracker (`linear`, `github`, `none`) are each a small
  contract you can add to. The feed and desks (Slack, Gmail, Linear and Notion events) come
  through Composio only, and the GitHub feed through `gh`. *Gap.*
- **Linear issue links need one Linear link first, after every restart.** An issue's page
  lives at `linear.app/<workspace>/issue/<ID>`. jin learns `<workspace>` from the first
  Linear URL it sees (a link on a task, or a Linear item in the feed) and keeps it only in
  memory, so after the daemon restarts an issue shows its id without a link until it sees
  one again. A `tracker: { id: linear, workspace: <slug> }` setting would remove the wait.
  *Gap.*

## Reaching jin

- **From another device, use an SSH tunnel.** Opening jin by a Tailscale name works for
  pages and actions but not for terminals, chat streams or room drafts, which connect from
  the browser straight to the daemon on loopback. `JIN_WEB_HOSTS` must also be in the web
  server's environment, which an app opened from the Dock does not pass on. Details and the
  tunnel command: [security.md §8c](security.md#8c-reaching-jin-from-another-device-tailscale).
  *Gap.*

## Errors

- **Most failures are shown; some fall back quietly.** Failed actions show the daemon's
  reason, background failures land in **Settings → Problems**, and interrupted jobs and room
  turns resume or say they stopped. About a hundred places still fall back silently on
  purpose (a missing optional file, a machine that does not answer a probe, a badge count
  that cannot be read). Some of those would be better reported. *Gap, low risk.*

## Development

- **Keep a development `JIN_HOME` out of `/tmp`.** macOS deletes files in `/tmp` that have
  not been opened for three days, and `config.yaml` and machine records are read only at
  startup. Use a folder in your home directory (the README does).
- **Use webpack for the dev server.** `next dev` with Turbopack reloads task pages in a loop;
  run it with `--webpack` (the README does).
