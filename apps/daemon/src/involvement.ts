import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where you are involved, so that only that reaches the desk and notifications: Slack threads you
 * wrote in, started or were mentioned in, and which Notion comments concern you.
 */

const KEEP_DAYS = 30;

/** Slack threads you are in (`slack:<channel>:<root ts>`), with when you last were; kept for a month. */
export class SlackThreads {
  private file: string;
  private threads: Record<string, string> | null = null;

  constructor(home: string) {
    this.file = join(home, "slack-threads.json");
  }

  private load(): Record<string, string> {
    if (this.threads) return this.threads;
    try {
      this.threads = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>) : {};
    } catch {
      this.threads = {};
    }
    return this.threads;
  }

  /** Read the file again (the home moved here). */
  reload() {
    this.threads = null;
  }

  has(key: string): boolean {
    return key in this.load();
  }

  /** You wrote in it (or were mentioned): replies in it now concern you. */
  add(keys: string | string[], at = new Date().toISOString()) {
    const t = this.load();
    let changed = false;
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      if (!k.startsWith("slack:") || k.startsWith("slack:dm:")) continue;
      if (!t[k] || t[k]! < at) {
        t[k] = at;
        changed = true;
      }
    }
    if (!changed) return;
    const old = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
    for (const [k, v] of Object.entries(t)) if (v < old) delete t[k];
    writeFileSync(this.file, JSON.stringify(t));
  }

  get size(): number {
    return Object.keys(this.load()).length;
  }
}

/** A Slack search match (your own message) as the thread it belongs to; DMs have no thread to follow. */
export function slackThreadOfMatch(m: { ts?: string; permalink?: string; channel?: { id?: string; is_im?: boolean } }): string | null {
  const channel = m.channel?.id;
  if (!channel || !m.ts || m.channel?.is_im || channel.startsWith("D")) return null;
  const root = m.permalink?.match(/[?&]thread_ts=([\d.]+)/)?.[1] ?? m.ts;
  return `slack:${channel}:${root}`;
}

interface NotionComment {
  id?: string;
  discussion_id?: string;
  created_by?: { id?: string };
  rich_text?: { mention?: { user?: { id?: string } } }[];
}

const mentions = (c: NotionComment | null | undefined, me: string) => (c?.rich_text ?? []).some((r) => r.mention?.user?.id === me);

/**
 * Why a Notion comment concerns you, or null when it does not: on your page, in a discussion you
 * wrote in (or were tagged in before), or tagging you.
 */
export function notionInvolvement(o: { me: string; pageCreator: string | null; comment: NotionComment | null; discussion: NotionComment[] }): "mine" | "mention" | "discussion" | null {
  if (mentions(o.comment, o.me)) return "mention";
  if (o.pageCreator === o.me) return "mine";
  const d = o.comment?.discussion_id;
  if (d && o.discussion.some((c) => c.discussion_id === d && c.id !== o.comment?.id && (c.created_by?.id === o.me || mentions(c, o.me)))) return "discussion";
  return null;
}
