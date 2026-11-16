import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
  private recent = new Map<string, number>();
  private file: string;
  private cached: NotificationSettings | null = null;

  constructor(
    private config: Config,
    private deliver: (n: Notice, s: NotificationSettings) => void = defaultDelivery(config),
  ) {
    this.file = join(config.home, "notifications.json");
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
    writeFileSync(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
    this.cached = next;
    return next;
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
    if (this.config.mode !== "local") return "not in local mode";
    if (!this.settings.enabled) return "off";
    if (this.onScreen(n, at)) return "on screen";
    const last = this.recent.get(n.key);
    if (last && at - last < REPEAT_MS) return "repeat";
    this.recent.set(n.key, at);
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
  return (n, s) => deliverNative(n, s, config.webOrigin);
}

/** macOS: terminal-notifier when installed (click opens jin), else AppleScript. Linux: notify-send. */
export function deliverNative(n: Notice, s: NotificationSettings, webOrigin: string) {
  const quiet = { stdout: "ignore", stderr: "ignore" } as const;
  if (process.platform === "darwin") {
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

const DESK_LABELS: Record<string, string> = { jin: "jin", github: "GitHub", slack: "Slack", linear: "Linear", notion: "Notion", gmail: "Gmail" };

/** Where a chat lives in the web app. */
export function chatPath(s: { kind: string; taskId: string | null }): string {
  if (s.kind === "jin") return "/";
  if (s.kind === "task" && s.taskId) return `/t/${encodeURIComponent(s.taskId)}`;
  return `/c/${s.kind}`;
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
  terminals: { get(id: string): { id: string; kind: string; taskId: string | null; title: string } };
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
    const title = s.kind === "task" ? `${s.taskId} · agent` : (DESK_LABELS[s.kind] ?? s.kind);
    const base = { title, path: chatPath(s), chat: s.id };
    if (e.kind === "session.idle")
      notifier.notify({ ...base, key: `chat:${s.id}:done`, subtitle: plain(s.title, 60) || undefined, body: plain(lastSaid.get(s.id) ?? "") || "Finished" });
    else if (e.kind === "session.failed") notifier.notify({ ...base, key: `chat:${s.id}:failed`, subtitle: "Stopped with an error", body: plain(String(e.payload.error ?? "")) });
    else notifier.notify({ ...base, key: `chat:${s.id}:approval:${e.payload.approvalId}`, subtitle: "Needs your approval", body: plain(`${e.payload.tool}: ${e.payload.reason ?? ""}`) });
    if (e.kind !== "approval.requested") lastSaid.delete(s.id);
  });

  w.jobs.onFinish((j) => {
    const path = `/t/${encodeURIComponent(j.taskId)}`;
    if (j.state === "done") notifier.notify({ key: `job:${j.id}`, title: `${j.taskId} is ready`, subtitle: j.slug, body: j.terminalId ? "Claude Code started with your prompt." : "Worktrees are set up.", path });
    else notifier.notify({ key: `job:${j.id}`, title: `${j.taskId} setup failed`, subtitle: j.slug, body: plain(j.error ?? ""), path });
  });

  return (terminalId: string, before: string, after: string, event: string, input: Record<string, any>) => {
    const t = w.terminals.get(terminalId);
    if (t.kind !== "claude") return;
    const base = { title: t.taskId ? `${t.taskId} · ${t.title}` : t.title, path: t.taskId ? `/t/${encodeURIComponent(t.taskId)}` : "/", terminal: t.id };
    if (event === "Stop" && before !== "idle") notifier.notify({ ...base, key: `term:${t.id}:done`, subtitle: "Claude Code finished", body: plain(lastAssistantText(input)) || "Turn finished" });
    else if (after === "waiting" && before !== "waiting")
      notifier.notify({ ...base, key: `term:${t.id}:waiting`, subtitle: "Claude Code needs you", body: plain(String(input.message ?? input.tool_name ?? "Waiting for your approval")) });
  };
}
