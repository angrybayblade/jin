import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, WorkspaceConfig } from "./config";
import type { Feed, NewItem } from "./feed";
import { body, HttpError, json, type Router } from "./http";
import { defaultSpawn, lines, type Proc, type Spawn } from "./machines";
import type { Notice } from "./notify";

/**
 * Live events through Composio: jin keeps `composio dev listen` running on this machine (the
 * always-on home), and each trigger event from Slack, Linear, Notion, Gmail or GitHub lands
 * in the feed and on its desk, and notifies you when it is for you. Composio's own CLI does
 * the work: sign-in, the developer project, connected accounts and trigger instances; its
 * state lives in Composio, jin keeps only which events you want ($JIN_HOME/composio.json).
 */

export const TOOLKITS = ["slack", "linear", "notion", "gmail", "github"] as const;
export type Toolkit = (typeof TOOLKITS)[number];

/** The events you can switch on, and the Composio triggers behind each. */
export const EVENTS = {
  slack_dms: { toolkit: "slack", label: "Slack: direct messages", triggers: ["SLACK_DIRECT_MESSAGE_RECEIVED"] },
  slack_mentions: { toolkit: "slack", label: "Slack: messages that mention you", triggers: ["SLACK_CHANNEL_MESSAGE_RECEIVED"] },
  linear: { toolkit: "linear", label: "Linear: issues and comments in your teams", triggers: ["LINEAR_ISSUE_CREATED_TRIGGER", "LINEAR_ISSUE_UPDATED_TRIGGER", "LINEAR_COMMENT_EVENT_TRIGGER"] },
  notion_comments: { toolkit: "notion", label: "Notion: comments", triggers: ["NOTION_COMMENT_CREATED"] },
  gmail: { toolkit: "gmail", label: "Gmail: new mail in your primary inbox", triggers: ["GMAIL_NEW_GMAIL_MESSAGE"] },
  github_prs: {
    toolkit: "github",
    label: "GitHub: comments, reviews and commits on PRs you review or wrote",
    triggers: ["GITHUB_PR_REVIEW_COMMENT_CREATED_TRIGGER", "GITHUB_ISSUE_COMMENT_CREATED_TRIGGER", "GITHUB_PULL_REQUEST_REVIEW_SUBMITTED_TRIGGER", "GITHUB_PULL_REQUEST_COMMIT_ADDED_TRIGGER"],
  },
} as const satisfies Record<string, { toolkit: Toolkit; label: string; triggers: readonly string[] }>;
export type EventKind = keyof typeof EVENTS;

interface Settings {
  /** The Composio user the accounts and triggers belong to. */
  userId: string;
  events: Partial<Record<EventKind, boolean>>;
  linearTeams: string[];
  /** Who you are on each service, to tell what is for you. */
  me: { slack?: string; linear?: string; github?: string; email?: string };
}

export interface LiveEvent {
  id: string;
  at: string;
  toolkit: string;
  trigger: string;
  title: string;
  summary: string;
  url: string | null;
  actor: string | null;
  /** For you: a DM, a mention, mail from a person, activity on your PR. */
  forYou: boolean;
}

export interface TriggerInstance {
  id: string;
  trigger_name: string;
  toolkit_slug: string;
  connected_account_id: string;
  status: string;
  disabled_at: string | null;
  trigger_data?: string;
}

const RECENT = 50;

// ---------------------------------------------------------------- events, as jin reads them

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const pick = (o: unknown, ...paths: string[]): unknown => {
  for (const p of paths) {
    let v: unknown = o;
    for (const k of p.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};
const oneLine = (s: string, max = 200) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * One event from `composio dev listen --json`, as jin shows it. Payloads differ per trigger,
 * so fields are looked up where each service puts them; anything unknown still shows.
 */
export function readEvent(raw: Record<string, unknown>, me: Settings["me"] = {}): LiveEvent | null {
  const trigger = String(pick(raw, "triggerSlug", "trigger_slug", "type", "metadata.trigger_slug", "metadata.triggerSlug") ?? "").toUpperCase();
  if (!trigger) return null;
  const data = (pick(raw, "data", "payload", "originalPayload") ?? {}) as Record<string, unknown>;
  const toolkit = String(pick(raw, "toolkitSlug", "toolkit_slug", "metadata.toolkit_slug") ?? trigger.split("_")[0]!.toLowerCase()).toLowerCase();
  const id = String(pick(raw, "id", "metadata.id", "metadata.nano_id", "uuid") ?? pick(data, "id", "ts", "message_id", "messageId") ?? `${trigger}:${Date.now()}`);
  const at = new Date((pick(raw, "timestamp", "metadata.timestamp", "createdAt") as string | number | undefined) ?? Date.now()).toISOString();
  const text = str(pick(data, "text", "message.text", "body", "comment.body", "data.body", "preview.body", "messageText", "snippet", "rich_text.0.plain_text")) ?? "";
  let title = trigger.replace(/_TRIGGER$/, "").replace(/_/g, " ").toLowerCase();
  let actor = str(pick(data, "user_name", "user", "sender", "from", "actor.name", "comment.user.login", "review.user.login", "author", "created_by.name"));
  let url = str(pick(data, "permalink", "url", "html_url", "comment.html_url", "review.html_url", "pull_request.html_url", "issue.url", "data.url"));
  let forYou = false;

  if (toolkit === "slack") {
    const channelType = str(pick(data, "channel_type", "event.channel_type"));
    const dm = trigger.includes("DIRECT_MESSAGE") || channelType === "im";
    const mentionsMe = Boolean(me.slack && text.includes(`<@${me.slack}>`));
    if (!dm && !mentionsMe) return null; // channel chatter that is not for you
    if (me.slack && actor === me.slack) return null; // your own message
    title = dm ? `Slack DM${actor ? ` from ${actor}` : ""}` : `Slack mention${actor ? ` by ${actor}` : ""}`;
    forYou = true;
  } else if (toolkit === "gmail") {
    const from = str(pick(data, "sender", "from", "payload.from")) ?? "";
    const subject = str(pick(data, "subject", "payload.subject")) ?? "(no subject)";
    title = `Mail: ${subject}`;
    actor = from || actor;
    // Mail from a person (the trigger already keeps to the primary inbox); not automated senders.
    forYou = !/no-?reply|notifications?@|mailer-daemon|newsletter|digest/i.test(from) && !(me.email && from.includes(me.email));
    if (!url) {
      const mid = str(pick(data, "messageId", "message_id", "id"));
      if (mid) url = `https://mail.google.com/mail/u/0/#inbox/${mid}`;
    }
  } else if (toolkit === "linear") {
    const issue = (pick(data, "issue", "data.issue", "data") ?? {}) as Record<string, unknown>;
    const ident = str(pick(issue, "identifier")) ?? str(pick(data, "identifier"));
    const ititle = str(pick(issue, "title")) ?? str(pick(data, "title"));
    const kind = trigger.includes("COMMENT") ? "comment on" : trigger.includes("CREATED") ? "new issue" : "updated";
    title = `Linear ${kind} ${[ident, ititle].filter(Boolean).join(" ")}`.trim();
    url = url ?? str(pick(issue, "url"));
    const assignee = str(pick(issue, "assignee.id", "assigneeId")) ?? str(pick(data, "assigneeId"));
    const mentions = Boolean(me.linear && JSON.stringify(data).includes(me.linear));
    forYou = Boolean(me.linear && (assignee === me.linear || mentions));
    if (actor && me.linear && JSON.stringify(pick(data, "actor", "user") ?? "").includes(me.linear)) return null; // your own change
  } else if (toolkit === "notion") {
    title = `Notion comment${actor ? ` by ${actor}` : ""}`;
    forYou = Boolean(me.email && JSON.stringify(data).includes(me.email)) || true; // comments are few; each is worth a look
  } else if (toolkit === "github") {
    const pr = str(pick(data, "pull_request.title", "issue.title", "title"));
    const num = pick(data, "pull_request.number", "issue.number", "number", "pull_number");
    const repo = str(pick(data, "repository.full_name", "repo"));
    const what = trigger.includes("REVIEW_COMMENT") ? "review comment" : trigger.includes("ISSUE_COMMENT") ? "comment" : trigger.includes("REVIEW_SUBMITTED") ? "review" : trigger.includes("COMMIT") ? "new commits" : "activity";
    title = `GitHub ${what} on ${repo ?? ""}#${num ?? ""}${pr ? ` ${pr}` : ""}`.replace(/\s+/g, " ").trim();
    if (me.github && actor && actor.toLowerCase() === me.github.toLowerCase()) return null; // your own
    forYou = true; // jin only watches PRs you review or wrote
  }

  return { id, at, toolkit, trigger, title: oneLine(title, 120), summary: oneLine(text || title), url, actor, forYou };
}

// ---------------------------------------------------------------- the module

export class Composio {
  private dir: string;
  private file: string;
  private listener: { proc: Proc | null; state: "off" | "starting" | "running" | "down"; since: string | null; error: string | null; backoff: number; timer: ReturnType<typeof setTimeout> | null; stopped: boolean } = {
    proc: null,
    state: "off",
    since: null,
    error: null,
    backoff: 2000,
    timer: null,
    stopped: false,
  };
  private recent: LiveEvent[] = [];
  private seen = new Set<string>();
  private login: { url: string | null; state: "idle" | "waiting" | "done" | "failed"; error: string | null; proc: Proc | null } = { url: null, state: "idle", error: null, proc: null };
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: Config,
    private deps: { feed: Feed; workspaces: WorkspaceConfig[]; notify: (n: Notice) => void },
    private spawn: Spawn = defaultSpawn,
    private bin = process.env.JIN_COMPOSIO_BIN ?? (Bun.which("composio") || join(homedir(), ".local", "bin", "composio")),
  ) {
    this.dir = join(config.home, "composio");
    this.file = join(config.home, "composio.json");
  }

  // ---------------------------------------------------------------- settings and the CLI

  get settings(): Settings {
    const d: Settings = { userId: "jin", events: {}, linearTeams: [], me: {} };
    try {
      return existsSync(this.file) ? { ...d, ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<Settings>) } : d;
    } catch {
      return d;
    }
  }

  private save(patch: Partial<Settings>) {
    writeFileSync(this.file, JSON.stringify({ ...this.settings, ...patch }, null, 2), { mode: 0o600 });
  }

  get installed(): boolean {
    return existsSync(this.bin);
  }

  /** Run the composio CLI in jin's project folder; its JSON answer, or an error with what it said. */
  async cli<T = unknown>(args: string[], opts: { raw?: boolean } = {}): Promise<T> {
    if (!this.installed) throw new HttpError(409, "the composio CLI is not installed on this machine (curl -fsSL https://composio.dev/install | bash)");
    mkdirSync(this.dir, { recursive: true });
    const proc = Bun.spawn([this.bin, ...args], { cwd: this.dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new HttpError(502, `composio ${args[0]} ${args[1] ?? ""}: ${(err || out).replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-3).join(" ")}`);
    if (opts.raw) return out as T;
    const start = out.search(/[[{]/);
    return JSON.parse(start >= 0 ? out.slice(start) : out) as T;
  }

  private project(): { org_id: string; project_id: string; project_name: string } | null {
    const f = join(this.dir, ".composio", "project.json");
    try {
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- status

  async status() {
    const s = this.settings;
    const who = this.installed ? await this.cli<{ email?: string; current_org_name?: string }>(["whoami"]).catch(() => null) : null;
    const project = this.project();
    const accounts = who && project ? await this.cli<{ id: string; toolkit_slug: string; status: string }[]>(["dev", "connected-accounts", "list", "--user-id", s.userId, "--limit", "100"]).catch(() => []) : [];
    const triggers = who && project ? await this.triggers().catch(() => [] as TriggerInstance[]) : [];
    return {
      installed: this.installed,
      signedIn: Boolean(who?.email),
      email: who?.email ?? null,
      org: who?.current_org_name ?? null,
      login: { url: this.login.url, state: this.login.state, error: this.login.error },
      project: project ? { id: project.project_id, name: project.project_name, orgId: project.org_id } : null,
      userId: s.userId,
      accounts: TOOLKITS.map((t) => {
        const a = accounts.find((x) => x.toolkit_slug === t && x.status === "ACTIVE") ?? accounts.find((x) => x.toolkit_slug === t);
        return { toolkit: t, id: a?.id ?? null, status: a?.status ?? null };
      }),
      events: (Object.keys(EVENTS) as EventKind[]).map((k) => ({
        kind: k,
        label: EVENTS[k].label,
        toolkit: EVENTS[k].toolkit,
        on: Boolean(s.events[k]),
        triggers: triggers.filter((t) => (EVENTS[k].triggers as readonly string[]).includes(t.trigger_name) && t.status === "ACTIVE" && !t.disabled_at).length,
      })),
      linearTeams: s.linearTeams,
      listener: { state: this.listener.state, since: this.listener.since, error: this.listener.error },
      recent: this.recent.slice(0, 20),
    };
  }

  // ---------------------------------------------------------------- sign-in and project

  /** Start a sign-in: a link for your browser; jin waits for it to complete. */
  async startLogin(): Promise<string> {
    this.login.proc?.kill();
    const out = await this.cli<string>(["login", "--no-browser", "--no-wait", "--no-skill-install"], { raw: true });
    const url = out.match(/https:\/\/\S+/)?.[0] ?? null;
    if (!url) throw new HttpError(502, "composio did not give a sign-in link");
    this.login = { url, state: "waiting", error: null, proc: null };
    const proc = this.spawn([this.bin, "login", "--poll", "--no-skill-install"]);
    this.login.proc = proc;
    void proc.exited.then((code) => {
      if (this.login.proc !== proc) return;
      this.login = { url: null, state: code === 0 ? "done" : "failed", error: code === 0 ? null : "the sign-in did not complete (it expires after 10 minutes)", proc: null };
    });
    return url;
  }

  /** Your orgs and their projects, to choose where jin's triggers live. */
  async projects(): Promise<{ orgId: string; org: string; projects: { id: string; name: string }[] }[]> {
    const orgs = await this.cli<{ id: string; name: string }[]>(["orgs", "list"]);
    return Promise.all(
      orgs.map(async (o) => ({
        orgId: o.id,
        org: o.name,
        projects: (await this.cli<{ id: string; name: string }[]>(["dev", "projects", "list", "--org-id", o.id, "--limit", "50"]).catch(() => [])).map((p) => ({ id: p.id, name: p.name })),
      })),
    );
  }

  /** Use a project: jin's folder is bound to it (what `composio dev init` writes) and the CLI to its org. */
  async useProject(orgId: string, projectId: string, name: string) {
    await this.cli(["orgs", "switch", "--org-id", orgId]);
    mkdirSync(join(this.dir, ".composio"), { recursive: true });
    const prev = this.project() as Record<string, unknown> | null;
    writeFileSync(join(this.dir, ".composio", "project.json"), JSON.stringify({ ...(prev ?? {}), org_id: orgId, project_id: projectId, project_name: name, test_user_id: null }));
  }

  setUserId(userId: string) {
    if (!/^[\w.@-]{1,64}$/.test(userId)) throw new HttpError(400, "a user id is letters, digits and . _ @ -");
    this.save({ userId });
  }

  /** A link to connect an account for a service (Composio's own page). */
  async connect(toolkit: Toolkit): Promise<string> {
    const out = await this.cli<string>(["dev", "connected-accounts", "link", toolkit, "--no-wait", "--no-browser", "--user-id", this.settings.userId], { raw: true });
    const url = out.match(/https:\/\/\S+?(?=["\s]|$)/)?.[0];
    if (!url) throw new HttpError(502, `composio gave no link for ${toolkit}`);
    return url;
  }

  // ---------------------------------------------------------------- triggers

  async triggers(): Promise<TriggerInstance[]> {
    return this.cli<TriggerInstance[]>(["dev", "triggers", "status", "--show-disabled", "--limit", "500"]);
  }

  private async account(toolkit: Toolkit): Promise<string> {
    const list = await this.cli<{ id: string; toolkit_slug: string; status: string }[]>(["dev", "connected-accounts", "list", "--user-id", this.settings.userId, "--toolkits", toolkit, "--limit", "20"]);
    const a = list.find((x) => x.status === "ACTIVE");
    if (!a) throw new HttpError(409, `connect ${toolkit} first`);
    return a.id;
  }

  /** Make sure a trigger exists and is on (re-enabling one that was switched off rather than adding another). */
  private async ensure(slug: string, account: string, config: Record<string, unknown>, existing: TriggerInstance[]) {
    const same = existing.find((t) => t.trigger_name === slug && t.connected_account_id === account && sameConfig(t, config));
    if (same && same.status === "ACTIVE" && !same.disabled_at) return same.id;
    if (same) {
      await this.cli(["dev", "triggers", "enable", same.id], { raw: true });
      return same.id;
    }
    const made = await this.cli<{ id?: string; trigger_id?: string }>(["dev", "triggers", "create", slug, "--connected-account-id", account, "--trigger-config", JSON.stringify(config), "--user-id", this.settings.userId]);
    return made.id ?? made.trigger_id ?? "";
  }

  private async disable(id: string) {
    // Composio guards disabling: jin allows it for its own CLI on this machine.
    const cfg = join(process.env.JIN_COMPOSIO_CONFIG_DIR ?? join(homedir(), ".composio"), "config.json");
    try {
      const c = existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")) : {};
      if (!c.developer?.destructive_actions) writeFileSync(cfg, JSON.stringify({ ...c, developer: { ...(c.developer ?? {}), enabled: true, destructive_actions: true } }));
    } catch {
      // the CLI will say what is wrong
    }
    await this.cli(["dev", "triggers", "disable", id, "--dangerously-allow"], { raw: true });
  }

  /** Switch an event on or off: its triggers are made (or re-enabled) or switched off. */
  async setEvent(kind: EventKind, on: boolean, opts: { linearTeams?: string[] } = {}) {
    const ev = EVENTS[kind];
    if (!ev) throw new HttpError(400, `unknown event ${kind}`);
    if (opts.linearTeams) this.save({ linearTeams: opts.linearTeams });
    this.save({ events: { ...this.settings.events, [kind]: on } });
    const existing = await this.triggers();
    const mine = existing.filter((t) => (ev.triggers as readonly string[]).includes(t.trigger_name));
    if (!on) {
      for (const t of mine) if (t.status === "ACTIVE" && !t.disabled_at) await this.disable(t.id);
      return;
    }
    await this.learnMe(ev.toolkit).catch(() => {});
    const account = await this.account(ev.toolkit);
    const configs = this.configsFor(kind);
    const wanted = new Set<string>();
    for (const slug of ev.triggers) for (const c of configs) if (kind !== "github_prs") wanted.add(await this.ensure(slug, account, c, existing));
    if (kind === "github_prs") await this.reconcileGithub();
    // Triggers of this event that are no longer wanted (a Linear team taken off) are switched off.
    if (kind === "linear") for (const t of mine) if (!wanted.has(t.id) && t.status === "ACTIVE" && !t.disabled_at) await this.disable(t.id);
  }

  private configsFor(kind: EventKind): Record<string, unknown>[] {
    if (kind === "linear") {
      if (!this.settings.linearTeams.length) throw new HttpError(400, "choose at least one Linear team");
      return this.settings.linearTeams.map((team_id) => ({ team_id }));
    }
    if (kind === "gmail") return [{ query: "in:inbox category:primary", interval: 1 }];
    if (kind === "slack_mentions") return [{ is_bot_message: false }];
    return [{}];
  }

  /**
   * GitHub triggers watch one pull request each: keep them on the open PRs you are asked to
   * review or wrote (gh, on this machine), and off the ones that closed.
   */
  async reconcileGithub(): Promise<{ watching: number }> {
    if (!this.settings.events.github_prs) return { watching: 0 };
    const search = async (q: string) => {
      const p = Bun.spawn(["gh", "search", "prs", q, "--state=open", "--json", "number,repository", "--limit", "50"], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      return (await p.exited) === 0 ? (JSON.parse(out || "[]") as { number: number; repository: { nameWithOwner: string } }[]) : [];
    };
    const prs = [...(await search("--review-requested=@me")), ...(await search("--author=@me"))];
    const key = (owner: string, repo: string, n: number) => `${owner}/${repo}#${n}`.toLowerCase();
    const want = new Map(prs.map((p) => [key(...(p.repository.nameWithOwner.split("/") as [string, string]), p.number), p]));
    const account = await this.account("github");
    const existing = await this.triggers();
    const gh = existing.filter((t) => (EVENTS.github_prs.triggers as readonly string[]).includes(t.trigger_name));
    for (const p of want.values()) {
      const [owner, repo] = p.repository.nameWithOwner.split("/") as [string, string];
      for (const slug of EVENTS.github_prs.triggers) {
        const cfg = slug === "GITHUB_ISSUE_COMMENT_CREATED_TRIGGER" ? { owner, repo, issue_number: p.number } : { owner, repo, pull_number: p.number };
        await this.ensure(slug, account, cfg, existing).catch((err) => console.error(`github trigger ${slug} ${owner}/${repo}#${p.number}: ${err}`));
      }
    }
    for (const t of gh) {
      const c = triggerConfig(t);
      const k = c.owner && c.repo ? key(String(c.owner), String(c.repo), Number(c.pull_number ?? c.issue_number)) : null;
      if (k && !want.has(k) && t.status === "ACTIVE" && !t.disabled_at) await this.disable(t.id).catch(() => {});
    }
    return { watching: want.size };
  }

  /** Who you are on a service, so events about you can be told apart. */
  private async learnMe(toolkit: Toolkit) {
    const me = { ...this.settings.me };
    const run = async (slug: string) => this.cli<{ data?: Record<string, unknown> }>(["dev", "playground-execute", slug, "--user-id", this.settings.userId, "-d", "{}"]);
    if (toolkit === "linear" && !me.linear) {
      const r = await run("LINEAR_GET_CURRENT_USER");
      me.linear = str(pick(r.data, "user.id", "id")) ?? undefined;
      me.email = me.email ?? str(pick(r.data, "user.email")) ?? undefined;
    }
    if (toolkit === "slack" && !me.slack) {
      const r = await run("SLACK_TEST_AUTH").catch(() => run("SLACK_AUTH_TEST"));
      me.slack = str(pick(r.data, "user_id", "response_data.user_id")) ?? undefined;
    }
    if (toolkit === "github" && !me.github) {
      const p = Bun.spawn(["gh", "api", "user", "-q", ".login"], { stdout: "pipe", stderr: "ignore" });
      me.github = (await new Response(p.stdout).text()).trim() || undefined;
    }
    this.save({ me });
  }

  // ---------------------------------------------------------------- the listener

  /** Keep `composio dev listen` running while any event is on; restart it when it drops. */
  startListener() {
    const l = this.listener;
    l.stopped = false;
    if (l.proc) return;
    if (!this.installed || !this.project() || !Object.values(this.settings.events).some(Boolean)) {
      l.state = "off";
      return;
    }
    l.state = "starting";
    // In jin's folder: that is where the developer project is bound.
    const proc = this.spawn([this.bin, "dev", "listen", "--json", "--user-id", this.settings.userId], { cwd: this.dir });
    l.proc = proc;
    l.since = new Date().toISOString();
    let errTail = "";
    void lines(proc.stdout, (line) => {
      if (!line.startsWith("{")) return;
      l.state = "running";
      try {
        this.handle(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // not an event
      }
    });
    void lines(proc.stderr, (line) => {
      if (/DeprecationWarning|trace-warnings/.test(line)) return;
      errTail = line;
    });
    // It prints nothing until the first event: alive means listening.
    setTimeout(() => {
      if (l.proc === proc && l.state === "starting") l.state = "running";
    }, 5000);
    void proc.exited.then((code) => {
      if (l.proc !== proc) return;
      l.proc = null;
      l.state = l.stopped ? "off" : "down";
      l.error = l.stopped ? null : `composio dev listen exited (${code})${errTail ? `: ${errTail}` : ""}`;
      if (l.stopped) return;
      l.timer = setTimeout(() => this.startListener(), l.backoff);
      l.backoff = Math.min(l.backoff * 2, 60_000);
    });
    this.reconcileTimer ??= setInterval(() => void this.reconcileGithub().catch(() => {}), 10 * 60_000);
  }

  stopListener() {
    const l = this.listener;
    l.stopped = true;
    if (l.timer) clearTimeout(l.timer);
    l.proc?.kill();
    l.proc = null;
    l.state = "off";
  }

  restartListener() {
    this.stopListener();
    this.startListener();
  }

  stopAll() {
    this.stopListener();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.login.proc?.kill();
  }

  /** An event: into the feed (and so its desk and catch-up), and a notification when it is for you. */
  handle(raw: Record<string, unknown>) {
    // The first event of each trigger: its structure (field names and types, no values) goes to
    // the log, so the reading can be checked against real payloads without keeping messages.
    const slug = String(pick(raw, "triggerSlug", "trigger_slug", "type", "metadata.trigger_slug") ?? "?");
    if (!this.seen.has(slug)) {
      this.seen.add(slug);
      console.log(`live event shape ${slug}: ${JSON.stringify(shape(raw))}`);
    }
    const e = readEvent(raw, this.settings.me);
    if (!e) return;
    this.listener.backoff = 2000;
    this.recent.unshift(e);
    if (this.recent.length > RECENT) this.recent.length = RECENT;
    const workspace = this.deps.workspaces[0]?.id ?? "live";
    const item: NewItem = { workspace, source: e.toolkit as NewItem["source"], kind: e.trigger.toLowerCase(), externalRef: e.url ?? e.id, title: e.title, summary: e.summary, receivedAt: e.at };
    this.deps.feed.add([item]);
    if (e.forYou) {
      const desk = e.toolkit === "gmail" ? "/c/gmail" : `/c/${e.toolkit}`;
      this.deps.notify({ key: `live:${e.id}`, title: e.title, subtitle: e.actor ?? undefined, body: e.summary, path: desk });
    }
  }

  recentEvents(): LiveEvent[] {
    return this.recent;
  }
}

/** Field names and types only, a few levels deep: what an event looks like, without what it says. */
export function shape(o: unknown, depth = 0): unknown {
  if (Array.isArray(o)) return o.length ? [shape(o[0], depth + 1)] : [];
  if (o && typeof o === "object") return depth > 3 ? "object" : Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v, depth + 1)]));
  return typeof o;
}

/** A trigger instance's config, from the JSON Composio keeps for it. */
export function triggerConfig(t: TriggerInstance): Record<string, unknown> {
  try {
    let d: unknown = t.trigger_data ?? "{}";
    while (typeof d === "string") d = JSON.parse(d);
    return d && typeof d === "object" ? (d as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const sameConfig = (t: TriggerInstance, c: Record<string, unknown>) => {
  const have = triggerConfig(t);
  return Object.entries(c).every(([k, v]) => k === "interval" || have[k] === undefined || String(have[k]) === String(v));
};

export function composioRoutes(router: Router, c: Composio) {
  const tk = (t: string | undefined): Toolkit => {
    if (!t || !(TOOLKITS as readonly string[]).includes(t)) throw new HttpError(400, `toolkit must be one of ${TOOLKITS.join(", ")}`);
    return t as Toolkit;
  };
  router
    .on("GET", "/api/composio", async () => json(await c.status()))
    .on("POST", "/api/composio/login", async () => json({ url: await c.startLogin() }))
    .on("GET", "/api/composio/projects", async () => json(await c.projects()))
    .on("POST", "/api/composio/project", async (req) => {
      const b = await body<{ orgId?: string; projectId?: string; name?: string; userId?: string }>(req);
      if (!b.orgId || !b.projectId || !b.name) throw new HttpError(400, "orgId, projectId and name are required");
      await c.useProject(b.orgId, b.projectId, b.name);
      if (b.userId) c.setUserId(b.userId);
      c.restartListener();
      return json(await c.status());
    })
    .on("POST", "/api/composio/connect/:toolkit", async (_req, p) => json({ url: await c.connect(tk(p.toolkit)) }))
    .on("POST", "/api/composio/events/:kind", async (req, p) => {
      const b = await body<{ on?: boolean; linearTeams?: string[] }>(req);
      await c.setEvent(p.kind as EventKind, b.on !== false, { linearTeams: b.linearTeams });
      c.restartListener();
      return json(await c.status());
    })
    .on("GET", "/api/composio/linear-teams", async () => {
      const r = await c.cli<{ data?: { teams?: unknown; items?: unknown } }>(["dev", "playground-execute", "LINEAR_LIST_LINEAR_TEAMS", "--user-id", c.settings.userId, "-d", "{}"]);
      // Large answers are stored in a file; read it from there.
      let data = r.data as Record<string, unknown> | undefined;
      const file = (r as { outputFilePath?: string }).outputFilePath;
      if (!data && file && existsSync(file)) data = (JSON.parse(readFileSync(file, "utf8")) as { data: Record<string, unknown> }).data;
      const teams = (data?.teams ?? data?.items ?? []) as { id: string; name: string; key?: string }[];
      return json((Array.isArray(teams) ? teams : []).map((t) => ({ id: t.id, name: t.name, key: t.key ?? null })));
    })
    .on("POST", "/api/composio/listener", async (req) => {
      const { on } = await body<{ on?: boolean }>(req);
      if (on === false) c.stopListener();
      else c.restartListener();
      return json(await c.status());
    })
    .on("POST", "/api/composio/github/reconcile", async () => json(await c.reconcileGithub()));
}
