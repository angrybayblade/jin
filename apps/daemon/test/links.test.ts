import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvent } from "../src/composio";
import { openDb } from "../src/db";
import { activity, belongs, ownLinks, parseLink, TaskLinks, Watches } from "../src/links";

test("links are read from the URLs you paste", () => {
  const at = new Date("2026-11-17T10:00:00Z");
  expect(parseLink("https://acme.slack.com/archives/C0123ABCD/p1700000000123456", at)).toMatchObject({ key: "slack:C0123ABCD:1700000000.123456", kind: "slack-thread" });
  // A reply's link: its thread is the one in thread_ts.
  expect(parseLink("https://acme.slack.com/archives/C0123ABCD/p1700000099000001?thread_ts=1700000000.123456&cid=C0123ABCD", at)?.key).toBe("slack:C0123ABCD:1700000000.123456");
  expect(parseLink("https://acme.slack.com/archives/C0123ABCD", at)).toMatchObject({ key: "slack-channel:C0123ABCD", kind: "slack-channel", since: "2026-11-17T10:00:00.000Z" });
  expect(parseLink("https://www.notion.so/acme/Launch-plan-1a2b3c4d5e6f40718293a4b5c6d7e8f9", at)).toMatchObject({ key: "notion:1a2b3c4d5e6f40718293a4b5c6d7e8f9", kind: "notion", label: "Launch plan" });
  expect(parseLink("https://www.notion.so/acme/x?p=1a2b3c4d5e6f40718293a4b5c6d7e8f9&pm=s", at)?.key).toBe("notion:1a2b3c4d5e6f40718293a4b5c6d7e8f9");
  expect(parseLink("https://linear.app/acme/issue/PLEN-244/fix-it", at)).toMatchObject({ key: "linear:PLEN-244", kind: "linear" });
  expect(parseLink("https://example.com/x", at)).toBeNull();
  expect(parseLink("not a url", at)).toBeNull();
});

test("a task's Activity: its PRs, its issue, and what it links, by exact thread", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "jin-links-")));
  const links = new TaskLinks(db);
  links.add("PLEN-244", "https://acme.slack.com/archives/C1/p1700000000123456");
  links.add("PLEN-244", "https://www.notion.so/acme/Plan-1a2b3c4d5e6f40718293a4b5c6d7e8f9");
  const chan = links.add("PLEN-244", "https://acme.slack.com/archives/C2");
  const own = ownLinks({ id: "PLEN-244", kind: "change", createdAt: "t" }, [{ repo: "ComposioHQ/platform", number: 12, url: "https://github.com/ComposioHQ/platform/pull/12", title: "Retry" }]);
  expect(own.map((l) => [l.key, l.how])).toEqual([["linear:PLEN-244", "issue"], ["github:composiohq/platform#12", "pr"]]);
  const all = [...own, ...links.list("PLEN-244")];
  const item = (key: string, at = "2026-11-17T12:00:00Z") => ({ id: key, thread: { key, title: "", ref: null, url: null }, receivedAt: at }) as any;
  const after = Math.floor(Date.parse(chan.since!) / 1000) + 60;
  const items = [
    item("github:composiohq/platform#12"),
    item("linear:PLEN-244"),
    item("slack:C1:1700000000.123456"),
    item("notion:1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9"), // dashes or not, the same page
    item(`slack:C2:${after}.000100`), // a thread started in the channel after it was linked
    item("slack:C2:1600000000.000100"), // one started before: not this task's
    item("github:composiohq/platform#13"),
    item("slack:C9:1700000000.123456"),
  ];
  expect(activity(all, items).map((i) => i.id).sort()).toEqual(["github:composiohq/platform#12", "linear:PLEN-244", "notion:1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9", "slack:C1:1700000000.123456", `slack:C2:${after}.000100`].sort());
  expect(belongs(item("slack:C2:1600000000.000100"), chan)).toBe(false);
  // A review task has no issue of its own.
  expect(ownLinks({ id: "REV-111701", kind: "review", createdAt: "t" }, [])).toEqual([]);
});

test("on the home, Slack chatter in a followed thread or channel is kept, quietly", () => {
  const w = new Watches(mkdtempSync(join(tmpdir(), "jin-watch-")));
  w.set("mac", ["slack:C1:1700000000.123456", "slack-channel:C2", "notion:x"]);
  const me = { slack: "U_ME" };
  const msg = (channel: string, ts: string, thread_ts?: string) => readEvent({ triggerSlug: "SLACK_CHANNEL_MESSAGE_RECEIVED", id: ts, data: { text: "deploying now", user: "U_BOB", channel, channel_type: "channel", ts, thread_ts } }, me, (k, c) => w.watched(k, c));
  expect(msg("C1", "1700000050.000001", "1700000000.123456")).toMatchObject({ forYou: false, tags: ["linked"], title: "wrote", thread: { key: "slack:C1:1700000000.123456" } });
  expect(msg("C2", "1700000060.000001")).toMatchObject({ forYou: false, tags: ["linked"] });
  expect(msg("C3", "1700000070.000001")).toBeNull();
  expect(w.all()).toEqual(["slack:C1:1700000000.123456", "slack-channel:C2"]);
});

test("the context Claude Code asks for: PRs, what the task follows with how to read it, the latest one line each", async () => {
  const { renderContext } = await import("../src/links");
  const at = Date.parse("2026-11-17T12:00:00Z");
  const links = [
    ...ownLinks({ id: "PLEN-244", kind: "change", createdAt: "t" }, [{ repo: "ComposioHQ/platform", number: 12, url: "https://github.com/ComposioHQ/platform/pull/12", title: "Retry" }]),
    { taskId: "PLEN-244", key: "slack:C1:1700000000.123456", kind: "slack-thread" as const, url: "https://acme.slack.com/archives/C1/p1700000000123456", label: "Slack thread in C1", since: null, how: "manual" as const, addedAt: "t" },
  ];
  const item = (key: string, title: string, actor: string, summary: string, mins: number) => ({ id: `${key}${mins}`, kind: "x", actor, title, summary, receivedAt: new Date(at - mins * 60_000).toISOString(), thread: { key, title: key.startsWith("slack") ? "Thread in #eng" : "Limiter", ref: key.startsWith("linear") ? "PLEN-244" : null, url: null } }) as any;
  const text = renderContext(
    { id: "PLEN-244", kind: "change", title: null, slug: "limiter" },
    links,
    [{ url: "https://github.com/ComposioHQ/platform/pull/12", title: "Retry", state: "OPEN", draft: false, checks: "failing", review: "CHANGES_REQUESTED" }],
    [item("slack:C1:1700000000.123456", "wrote", "Bob", "we agreed on 100 rps", 30), item("linear:PLEN-244", "commented", "Bea", "scope is personal routes only", 120), item("slack:C9:1.0", "wrote", "X", "unrelated", 5)],
    { at },
  );
  expect(text).toContain("Task PLEN-244 (change): limiter");
  expect(text).toContain("https://github.com/ComposioHQ/platform/pull/12  open, checks failing, changes requested  Retry");
  expect(text).toContain("read: the Slack tools: read the thread (channel C1, thread ts 1700000000.123456)");
  expect(text).toContain("read: the Linear tools: the issue PLEN-244 and its comments");
  expect(text).toContain("30m  Bob wrote: we agreed on 100 rps");
  expect(text).toContain("2h  Bea commented: scope is personal routes only");
  expect(text).not.toContain("unrelated");
});
