import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { Feed, type NewItem } from "../src/feed";
import { Watches } from "../src/links";
import { cleanTriage, SlackReads, slackPlace, StaleChecker, Triager } from "../src/triage";

/** The desk's life cycle: triage on arrival, the Slack read check, the context check (stale), and task ownership. */

const setup = () => new Feed(openDb(mkdtempSync(join(tmpdir(), "jin-triage-"))));
const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const slack = (o: { ref: string; channel: string; ts: string; threadTs?: string; tags: string[]; minAgo?: number; text?: string; dm?: boolean }): NewItem => ({
  workspace: "w",
  source: "slack",
  kind: o.dm ? "slack_direct_message_received" : "slack_channel_message_received",
  externalRef: o.ref,
  title: "",
  summary: o.text ?? "hello",
  receivedAt: at(o.minAgo ?? 1),
  actor: "sam",
  tags: o.tags,
  thread: { key: o.dm ? `slack:dm:${o.channel}` : `slack:${o.channel}:${o.threadTs ?? o.ts}`, title: "t", ref: null, url: null },
  meta: { channel: o.channel, ts: o.ts, threadTs: o.threadTs ?? o.ts },
});
const byRef = (feed: Feed, ref: string) => feed.list().find((i) => i.externalRef === ref)!;

test("triage: each new item gets jin's read; odd answers fall back to cautious values; a skipped item is read again", async () => {
  const feed = setup();
  feed.add([slack({ ref: "a", channel: "D1", ts: "100.1", tags: ["dm"], dm: true }), slack({ ref: "b", channel: "C1", ts: "100.2", tags: ["mention"] }), slack({ ref: "c", channel: "C1", ts: "100.3", tags: ["mention"] })]);
  const [a, b] = [byRef(feed, "a"), byRef(feed, "b")];
  const seen: string[][] = [];
  const t = new Triager(feed, {
    classify: async (items) => {
      seen.push(items.map((i) => i.id));
      return {
        [a.id]: { bucket: "now", severity: "high", action: "reply", group: "work", why: "sam is blocked", taskHint: "PLEN-1" },
        [b.id]: { bucket: "whenever", severity: "huge", action: "dance", group: "family", why: 7, taskHint: "MADE-UP" },
      } as never;
    },
    me: () => ({ slack: "U1" }),
    tasks: () => [{ id: "PLEN-1", title: "limiter" }],
    ownerOf: () => null,
  });
  expect(await t.run()).toBe(2);
  expect(byRef(feed, "a").triage).toEqual({ bucket: "now", severity: "high", action: "reply", group: "work", why: "sam is blocked", taskHint: "PLEN-1" });
  expect(byRef(feed, "a").priority!.score).toBeGreaterThan(3);
  expect(byRef(feed, "b").triage).toEqual({ bucket: "today", severity: "medium", action: "read", group: "work", why: "", taskHint: null });
  expect(byRef(feed, "c").triage).toBeNull();
  await t.run();
  expect(seen[1]).toEqual([byRef(feed, "c").id]);
  expect(cleanTriage(null, new Set())).toBeNull();
});

test("read check: a read DM or mention is seen and stays; a read message only for your information is done; thread replies and unread ones are left", async () => {
  const feed = setup();
  feed.add([
    slack({ ref: "dm-read", channel: "D1", ts: "100.5", tags: ["dm"], dm: true }),
    slack({ ref: "dm-unread", channel: "D1", ts: "300.0", tags: ["dm"], dm: true }),
    slack({ ref: "fyi-read", channel: "C2", ts: "100.0", tags: ["linked"] }),
    slack({ ref: "reply", channel: "C2", ts: "150.0", threadTs: "90.0", tags: ["mention"] }),
  ]);
  const asked: string[] = [];
  const reads = new SlackReads(feed, { lastRead: async (ch) => (asked.push(ch), ch === "D1" ? "200.0" : "200.0") });
  expect(await reads.run()).toEqual({ seen: 1, done: 1 });
  expect(asked.sort()).toEqual(["C2", "D1"]);
  expect(byRef(feed, "dm-read")).toMatchObject({ state: "new" });
  expect(byRef(feed, "dm-read").seenAt).not.toBeNull();
  expect(byRef(feed, "dm-unread").seenAt).toBeNull();
  expect(byRef(feed, "fyi-read").state).toBe("done");
  expect(byRef(feed, "reply")).toMatchObject({ state: "new", seenAt: null });
  expect(slackPlace(byRef(feed, "reply"))).toBeNull();
});

test("context check: what was handled since goes stale with why, the rest stays (not judged again at once); reopen brings it back", async () => {
  const feed = setup();
  feed.add([slack({ ref: "answered", channel: "D1", ts: "1.0", tags: ["dm"], dm: true, minAgo: 300 }), slack({ ref: "waiting", channel: "D2", ts: "2.0", tags: ["dm"], dm: true, minAgo: 300 }), slack({ ref: "fresh", channel: "D3", ts: "3.0", tags: ["dm"], dm: true, minAgo: 5 })]);
  const judged: string[] = [];
  const checker = new StaleChecker(feed, {
    since: async (i) => (i.externalRef === "answered" ? "you: done, merged it" : ""),
    judge: async (item, since) => (judged.push(item.text), since.startsWith("you:") ? { verdict: "handled", why: "you answered" } : { verdict: "open", why: "no answer" }),
  });
  expect(await checker.run()).toBe(1);
  expect(byRef(feed, "answered")).toMatchObject({ state: "stale", staleWhy: "you answered" });
  expect(byRef(feed, "waiting").state).toBe("new");
  expect(byRef(feed, "fresh").state).toBe("new");
  expect(judged).toHaveLength(2);
  // Checked now: not judged again on the next run.
  await checker.run();
  expect(judged).toHaveLength(2);
  // A read item is checked even when it is fresh.
  feed.markSeen([byRef(feed, "fresh").id]);
  await checker.run();
  expect(judged).toHaveLength(3);
  expect(feed.reopen(byRef(feed, "answered").id)).toMatchObject({ state: "new", staleWhy: null, seenAt: null });
  // Done stamps seen_at; reopened, it is not read at its source as far as jin knows.
  feed.setState(byRef(feed, "waiting").id, "done");
  expect(feed.reopen(byRef(feed, "waiting").id)).toMatchObject({ state: "new", seenAt: null });
});

test("task group: the home knows which task follows each key (PRs, issues, threads, a Slack channel's messages)", () => {
  const w = new Watches(mkdtempSync(join(tmpdir(), "jin-watch-")));
  w.set("mac", ["slack:C1:1.0"], [
    { key: "github:ComposioHQ/platform#12", taskId: "PLEN-1", title: "limiter" },
    { key: "slack-channel:C9", taskId: "PLEN-2", title: "keyring" },
  ]);
  expect(w.ownerOf("github:composiohq/platform#12")).toEqual({ taskId: "PLEN-1", machine: "mac", title: "limiter" });
  expect(w.ownerOf("slack:C9:5.0", "C9")).toEqual({ taskId: "PLEN-2", machine: "mac", title: "keyring" });
  expect(w.ownerOf("linear:OTHER-1")).toBeNull();
  expect(w.tasks().map((t) => t.taskId).sort()).toEqual(["PLEN-1", "PLEN-2"]);
  // A machine that says nothing about tasks keeps what it said before.
  w.set("mac", ["slack:C1:1.0"]);
  expect(w.ownerOf("github:composiohq/platform#12")?.taskId).toBe("PLEN-1");
});
