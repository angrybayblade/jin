import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { body, json, type Router } from "./http";

/** What the person is looking at, reported by the open jin window. */
export interface Presence {
  path: string;
  chat: string | null;
  terminal: string | null;
  focused: boolean;
  at: number;
}

export interface NotificationSettings {
  enabled: boolean;
  sound: boolean;
  /** Per app, the kinds of live event that notify (see LIVE_KINDS); an app left out uses its defaults. */
  sources?: Record<string, string[]>;
}

/** The kinds of live event per app that a notification can be chosen for, and which are on by default. */
export const LIVE_KINDS: Record<string, { label: string; kinds: { id: string; label: string; on: boolean }[] }> = {
  github: {
    label: "GitHub",
    kinds: [
      { id: "authored", label: "Activity on PRs I authored", on: true },
      { id: "reviewer", label: "PRs I'm a reviewer on (asked directly, or reviewed)", on: true },
      { id: "mentioned", label: "Comments that mention me", on: true },
    ],
  },
  slack: {
    label: "Slack",
    kinds: [
      { id: "dm", label: "Direct messages", on: true },
      { id: "mention", label: "Mentions", on: true },
      { id: "thread", label: "Replies in threads I'm in (wrote in, started or was mentioned in)", on: true },
    ],
  },
  linear: {
    label: "Linear",
    kinds: [
      { id: "assigned", label: "Issues assigned to me", on: true },
      { id: "created", label: "Issues I opened", on: true },
      { id: "mentioned", label: "Mentions", on: true },
      { id: "subscribed", label: "Issues I follow (commented on or subscribed to)", on: true },
    ],
  },
  notion: {
    label: "Notion",
    kinds: [
      { id: "mine", label: "Comments on my pages", on: true },
      { id: "discussion", label: "Replies in discussions I'm in", on: true },
      { id: "mention", label: "Comments that tag me", on: true },
    ],
  },
  gmail: {
    label: "Gmail",
    kinds: [
      { id: "person", label: "Mail from people", on: true },
      { id: "automated", label: "Automated mail (no-reply, notifications)", on: false },
    ],
  },
};

/** The kinds chosen for an app: the saved choice, else the defaults. */
export function chosenKinds(s: NotificationSettings, app: string): string[] {
  const kinds = LIVE_KINDS[app]?.kinds ?? [];
  // A choice saved before an app's kinds changed (none of its kinds exist now) falls back to the defaults.
  const saved = s.sources?.[app]?.filter((id) => kinds.some((k) => k.id === id));
  return saved?.length || (s.sources?.[app] && !s.sources[app]!.length) ? (saved ?? []) : kinds.filter((k) => k.on).map((k) => k.id);
}

/** Whether a live event notifies: one of its tags is chosen for its app (untagged events fall back to "for you"). */
export function liveNotifies(s: NotificationSettings, e: { toolkit: string; tags?: string[]; forYou: boolean }): boolean {
  if (!e.tags?.length || !LIVE_KINDS[e.toolkit]) return e.forYou;
  const chosen = chosenKinds(s, e.toolkit);
  return e.tags.some((t) => chosen.includes(t));
}

export interface Notice {
  /** Same key within a few seconds is sent once (a turn ending reports from more than one place). */
  key: string;
  title: string;
  subtitle?: string;
  body: string;
  /** Where it happened, to skip it when that is on screen, and to open it on click. */
  path: string;
  chat?: string;
  terminal?: string;
  /** Where it happened outside jin (a PR comment, a Slack message): a click opens this instead. */
  url?: string;
}

const DEFAULTS: NotificationSettings = { enabled: true, sound: true };
const SOUND = "Glass";
const FRESH_MS = 20_000;
const REPEAT_MS = 4_000;

/** Plain one-line text for a notification body. */
export function plain(text: string, max = 160): string {
  const s = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>~]|\[(.*?)\]\(.*?\)/g, (m, link) => link ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Desktop notifications (with a sound) when a chat turn, a Claude Code turn or a task setup
 * finishes, or something needs approval. Sent by the daemon, so they arrive with the window
 * closed too; skipped when the window is focused on that very chat or tab. Local mode only:
 * an always-on VM has no desktop to show them on.
 */
export class Notifier {
  presence: Presence | null = null;
  /** Without a desktop (vm mode): notices kept for the jin that onboarded this machine to show. */
  private outbox: (Notice & { seq: number; at: number })[] = [];
  private seq = 0;
  private recent = new Map<string, number>();
  private file: string;
  private cached: NotificationSettings | null = null;

  constructor(
    private config: Config,
    private deliver: (n: Notice, s: NotificationSettings) => void = defaultDelivery(config),
  ) {
    this.file = join(config.home, "notifications.json");
  }

  /** Read the settings again (the home moved here). */
  reload() {
    this.cached = null;
  }

  get settings(): NotificationSettings {
    if (this.cached) return this.cached;
    try {
      this.cached = existsSync(this.file) ? { ...DEFAULTS, ...JSON.parse(readFileSync(this.file, "utf8")) } : { ...DEFAULTS };
    } catch {
      this.cached = { ...DEFAULTS };
    }
    return this.cached!;
  }

  update(patch: Partial<NotificationSettings>): NotificationSettings {
    const next = { ...this.settings };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (typeof patch.sound === "boolean") next.sound = patch.sound;
    if (patch.sources && typeof patch.sources === "object") {
      const sources = { ...(next.sources ?? {}) };
      for (const [app, kinds] of Object.entries(patch.sources)) {
        if (!LIVE_KINDS[app] || !Array.isArray(kinds)) continue;
        sources[app] = kinds.filter((k) => LIVE_KINDS[app]!.kinds.some((x) => x.id === k));
      }
      next.sources = sources;
    }
    writeFileSync(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
    this.cached = next;
    return next;
  }

  /** Notices kept since `after` (vm mode), and the latest seq; a relay starting fresh asks with after = -1 to skip the backlog. */
  since(after: number): { seq: number; notices: (Notice & { seq: number; at: number })[] } {
    return { seq: this.seq, notices: after < 0 ? [] : this.outbox.filter((x) => x.seq > after) };
  }

  /** Whether the person is looking at this right now. */
  onScreen(n: Notice, at = Date.now()): boolean {
    const p = this.presence;
    if (!p || !p.focused || at - p.at > FRESH_MS || p.path !== n.path) return false;
    if (n.chat && p.chat && p.chat !== n.chat) return false;
    if (n.terminal && p.terminal && p.terminal !== n.terminal) return false;
    return true;
  }

  /** Returns why a notice was not sent, or null when it was. */
  notify(n: Notice, at = Date.now()): string | null {
    if (!this.settings.enabled) return "off";
    if (this.onScreen(n, at)) return "on screen";
    const last = this.recent.get(n.key);
    if (last && at - last < REPEAT_MS) return "repeat";
    this.recent.set(n.key, at);
    if (this.config.mode !== "local") {
      this.outbox.push({ ...n, seq: ++this.seq, at });
      if (this.outbox.length > 100) this.outbox.splice(0, this.outbox.length - 100);
      return "kept for relay";
    }
    try {
      this.deliver(n, this.settings);
    } catch {
      return "delivery failed";
    }
    return null;
  }
}

/** The desktop, or with JIN_NOTIFY_LOG a file of JSON lines (tests and headless runs). */
function defaultDelivery(config: Config): (n: Notice, s: NotificationSettings) => void {
  const log = process.env.JIN_NOTIFY_LOG;
  if (log) return (n, s) => appendFileSync(log, `${JSON.stringify({ ...n, sound: s.sound })}\n`);
  return (n, s) => deliverNative(n, s, config.webOrigin, config.home);
}

/** jin's notifier app (apps/notifier, installed by scripts/release-local.sh): notifications as jin that open the place on click. */
export function notifierPath(home: string): string | null {
  const p = join(home, "notifier", "jin.app", "Contents", "MacOS", "jin-notifier");
  return existsSync(p) ? p : null;
}

/** Where a click takes you: jin's window (jin://, when the desktop app is installed), else the web app in a browser. */
export function clickTarget(n: Pick<Notice, "path" | "chat" | "terminal" | "url">, webOrigin: string, apps = [join(homedir(), "Applications", "jin.app"), "/Applications/jin.app"]): string {
  // Something that happened elsewhere (a PR comment, a Slack message, a Linear issue): open it there.
  if (n.url && /^https?:\/\//.test(n.url)) return n.url;
  const params = new URLSearchParams();
  if (n.chat) params.set("chat", n.chat);
  if (n.terminal) params.set("terminal", n.terminal);
  const q = params.toString();
  const where = n.path + (q ? `${n.path.includes("?") ? "&" : "?"}${q}` : "");
  if (apps.some((a) => existsSync(a))) return `jin://open?path=${encodeURIComponent(where)}`;
  return new URL(where, webOrigin).toString();
}

/** macOS: jin's notifier (click opens the place in jin), else terminal-notifier, else AppleScript. Linux: notify-send. */
export function deliverNative(n: Notice, s: NotificationSettings, webOrigin: string, home = join(homedir(), ".jin")) {
  const quiet = { stdout: "ignore", stderr: "ignore" } as const;
  if (process.platform === "darwin") {
    const own = notifierPath(home);
    if (own) {
      const args = [own, "--title", n.title, "--body", n.body || " ", "--group", n.key.split(":")[0] ?? "jin", "--open", clickTarget(n, webOrigin)];
      if (n.subtitle) args.push("--subtitle", n.subtitle);
      if (s.sound) args.push("--sound");
      Bun.spawn(args, quiet);
      return;
    }
    const tn = Bun.which("terminal-notifier");
    if (tn) {
      const args = [tn, "-title", n.title, "-message", n.body || " ", "-group", n.key, "-open", new URL(n.path + (n.chat ? `?chat=${n.chat}` : ""), webOrigin).toString()];
      if (n.subtitle) args.push("-subtitle", n.subtitle);
      if (s.sound) args.push("-sound", SOUND);
      Bun.spawn(args, quiet);
      return;
    }
    // Text goes in as arguments, never into the script.
    const script = ["on run argv", `display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)${s.sound ? ` sound name "${SOUND}"` : ""}`, "end run"];
    Bun.spawn(["osascript", ...script.flatMap((l) => ["-e", l]), n.title, n.subtitle ?? "", n.body || " "], quiet);
    return;
  }
  if (process.platform === "linux" && Bun.which("notify-send")) {
    Bun.spawn(["notify-send", "--app-name=jin", n.subtitle ? `${n.title} · ${n.subtitle}` : n.title, n.body], quiet);
    if (s.sound && Bun.which("canberra-gtk-play")) Bun.spawn(["canberra-gtk-play", "-i", "complete"], quiet);
  }
}

export function notifyRoutes(router: Router, notifier: Notifier) {
  router
    .on("GET", "/api/notifications", () => json(notifier.settings))
    // What each app's live events can notify for, with what is chosen now.
    .on("GET", "/api/notifications/kinds", () =>
      json(Object.entries(LIVE_KINDS).map(([app, v]) => ({ app, label: v.label, kinds: v.kinds.map((k) => ({ ...k, chosen: chosenKinds(notifier.settings, app).includes(k.id) })) }))),
    )
    // The jin that onboarded this machine collects what it could not show (vm mode).
    .on("GET", "/api/notifications/outbox", (_req, _p, url) => json(notifier.since(Number(url.searchParams.get("after") ?? -1))))
    .on("PATCH", "/api/notifications", async (req) => json(notifier.update(await body<Partial<NotificationSettings>>(req))))
    .on("POST", "/api/notifications/test", () => {
      notifier.presence = null; // a test always shows
      const skipped = notifier.notify({ key: `test:${Date.now()}`, title: "jin", subtitle: "Notifications are on", body: "You'll hear this when a turn finishes or something needs you.", path: "/" });
      return json({ sent: skipped === null, skipped });
    })
    .on("POST", "/api/presence", async (req) => {
      const b = await body<Partial<Presence>>(req);
      notifier.presence = {
        path: String(b.path ?? "/"),
        chat: typeof b.chat === "string" ? b.chat : null,
        terminal: typeof b.terminal === "string" ? b.terminal : null,
        focused: Boolean(b.focused),
        at: Date.now(),
      };
      return json({ ok: true });
    });
}

// ---------------------------------------------------------------- what is worth a notification

const DESK_LABELS: Record<string, string> = { jin: "jin", desk: "Desk", github: "GitHub", slack: "Slack", linear: "Linear", notion: "Notion", gmail: "Gmail" };

/** Where a chat lives in the web app. */
export function chatPath(s: { kind: string; taskId: string | null }): string {
  if (s.kind === "jin") return "/";
  if ((s.kind === "task" || s.kind === "room") && s.taskId) return `/t/${encodeURIComponent(s.taskId)}`;
  // The desk agent, and the chats of the desks it replaced.
  return "/desk";
}

/** The last thing Claude Code said in a turn, from the hook input or the end of its transcript. */
export function lastAssistantText(input: Record<string, any>): string {
  if (typeof input.last_assistant_message === "string") return input.last_assistant_message;
  const file = typeof input.transcript_path === "string" ? input.transcript_path : null;
  if (!file || !existsSync(file)) return "";
  try {
    const text = readFileSync(file, "utf8");
    const lines = text.slice(-400_000).trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const j = JSON.parse(lines[i]!);
      if (j.type !== "assistant") continue;
      const content = j.message?.content;
      const said = Array.isArray(content) ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join(" ") : typeof content === "string" ? content : "";
      if (said.trim()) return said;
    }
  } catch {
    // a partial line or an unreadable file: no preview
  }
  return "";
}

interface Watched {
  sessions: { onEvent(fn: (e: { sessionId: string; kind: string; payload: Record<string, any> }) => void): void; get(id: string): { id: string; kind: string; taskId: string | null; title: string } };
  jobs: { onFinish(fn: (j: { id: string; taskId: string; slug: string; state: string; error?: string | null; terminalId?: string | null }) => void): void };
  terminals: { get(id: string): { id: string; kind: string; agent?: string | null; taskId: string | null; title: string } };
}

/** Turn finished work into notifications. Returns the Claude Code hook listener for claudeHookRoutes. */
export function watchForNotifications(notifier: Notifier, w: Watched) {
  const lastSaid = new Map<string, string>();
  w.sessions.onEvent((e) => {
    if (e.kind === "message" && typeof e.payload.text === "string") {
      lastSaid.set(e.sessionId, e.payload.text);
      return;
    }
    if (e.kind !== "session.idle" && e.kind !== "session.failed" && e.kind !== "approval.requested") return;
    const s = w.sessions.get(e.sessionId);
    const title = s.kind === "task" ? `${s.taskId} · agent` : s.kind === "room" ? `${s.taskId} · room` : (DESK_LABELS[s.kind] ?? s.kind);
    const base = { title, path: chatPath(s), chat: s.id };
    if (e.kind === "session.idle")
      notifier.notify({ ...base, key: `chat:${s.id}:done`, subtitle: plain(s.title, 60) || undefined, body: plain(lastSaid.get(s.id) ?? "") || "Finished" });
    else if (e.kind === "session.failed") notifier.notify({ ...base, key: `chat:${s.id}:failed`, subtitle: "Stopped with an error", body: plain(String(e.payload.error ?? "")) });
    else notifier.notify({ ...base, key: `chat:${s.id}:approval:${e.payload.approvalId}`, subtitle: "Needs your approval", body: plain(`${e.payload.tool}: ${e.payload.reason ?? ""}`) });
    if (e.kind !== "approval.requested") lastSaid.delete(s.id);
  });

  w.jobs.onFinish((j) => {
    const path = `/t/${encodeURIComponent(j.taskId)}`;
    if (j.state === "done") notifier.notify({ key: `job:${j.id}`, title: `${j.taskId} is ready`, subtitle: j.slug, body: j.terminalId ? "The agent started with your prompt." : "Worktrees are set up.", path });
    else notifier.notify({ key: `job:${j.id}`, title: `${j.taskId} setup failed`, subtitle: j.slug, body: plain(j.error ?? ""), path });
  });

  return (terminalId: string, before: string, after: string, event: string, input: Record<string, any>) => {
    const t = w.terminals.get(terminalId);
    if (t.kind !== "agent") return;
    const base = { title: t.taskId ? `${t.taskId} · ${t.title}` : t.title, path: t.taskId ? `/t/${encodeURIComponent(t.taskId)}` : "/", terminal: t.id };
    const who = t.agent === "codex" ? "Codex" : t.agent === "pi" ? "pi" : t.agent === "opencode" ? "opencode" : "Claude Code";
    if (event === "Stop" && before !== "idle") notifier.notify({ ...base, key: `term:${t.id}:done`, subtitle: `${who} finished`, body: plain(lastAssistantText(input)) || "Turn finished" });
    else if (after === "waiting" && before !== "waiting")
      notifier.notify({ ...base, key: `term:${t.id}:waiting`, subtitle: `${who} needs you`, body: plain(String(input.message ?? input.tool_name ?? "Waiting for your approval")) });
  };
}
