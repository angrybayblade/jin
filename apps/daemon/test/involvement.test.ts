import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { Feed, type NewItem } from "../src/feed";
import { notionInvolvement, SlackThreads, slackThreadOfMatch } from "../src/involvement";

/** Only what involves you reaches the desk and notifications. */

test("Slack threads you are in are remembered (DMs are not threads), and survive a restart", () => {
  const home = mkdtempSync(join(tmpdir(), "jin-inv-"));
  const t = new SlackThreads(home);
  t.add(["slack:C1:5.1", "slack:dm:D1", "github:o/r#1"]);
  expect(t.has("slack:C1:5.1")).toBe(true);
  expect(t.has("slack:dm:D1")).toBe(false);
  expect(new SlackThreads(home).size).toBe(1);
  // A search match is the thread it belongs to: a reply names its root in the permalink.
  expect(slackThreadOfMatch({ ts: "9.0", permalink: "https://x.slack.com/archives/C1/p90?thread_ts=5.1&cid=C1", channel: { id: "C1" } })).toBe("slack:C1:5.1");
  expect(slackThreadOfMatch({ ts: "9.0", permalink: "https://x.slack.com/archives/C1/p90", channel: { id: "C1" } })).toBe("slack:C1:9.0");
  expect(slackThreadOfMatch({ ts: "9.0", channel: { id: "D1", is_im: true } })).toBeNull();
});

test("a Notion comment concerns you on your page, tagging you, or in a discussion you wrote or were tagged in", () => {
  const me = "n-me";
  const c = (id: string, by: string, d = "d1", tag?: string) => ({ id, discussion_id: d, created_by: { id: by }, rich_text: tag ? [{ mention: { user: { id: tag } } }] : [] });
  expect(notionInvolvement({ me, pageCreator: me, comment: c("x", "bob"), discussion: [] })).toBe("mine");
  expect(notionInvolvement({ me, pageCreator: "bob", comment: c("x", "bob", "d1", me), discussion: [] })).toBe("mention");
  expect(notionInvolvement({ me, pageCreator: "bob", comment: c("x", "bob"), discussion: [c("a", me)] })).toBe("discussion");
  expect(notionInvolvement({ me, pageCreator: "bob", comment: c("x", "bob"), discussion: [c("a", "cat", "d1", me)] })).toBe("discussion");
  // Your comment in another discussion on the page does not make this one yours.
  expect(notionInvolvement({ me, pageCreator: "bob", comment: c("x", "bob"), discussion: [c("a", me, "d2"), c("b", "cat")] })).toBeNull();
});

test("what came in before the rule and does not involve you is dismissed, once", () => {
  const feed = new Feed(openDb(mkdtempSync(join(tmpdir(), "jin-inv-"))));
  const item = (ref: string, source: NewItem["source"], tags?: string[]): NewItem => ({ workspace: "w", source, kind: "k", externalRef: ref, title: "", summary: "", receivedAt: new Date().toISOString(), tags });
  feed.add([
    item("gh-none", "github"),
    item("gh-team", "github", ["team-review"]),
    item("gh-team-mention", "github", ["team-review", "mentioned"]),
    item("gh-mine", "github", ["authored"]),
    item("gh-review", "github", ["reviewer", "requested"]),
    item("sl-chatter", "slack"),
    item("sl-dm", "slack", ["dm"]),
    item("sl-linked", "slack", ["linked"]),
    item("li-other", "linear", ["other"]),
    item("li-mine", "linear", ["assigned"]),
    item("no-comment", "notion", ["comment"]),
  ]);
  expect(feed.dismissUninvolved()).toBe(3);
  const open = feed.list().filter((i) => i.state === "new").map((i) => i.externalRef).sort();
  expect(open).toEqual(["gh-mine", "gh-review", "gh-team-mention", "li-mine", "li-other", "no-comment", "sl-dm", "sl-linked"]);
  expect(feed.dismissUninvolved()).toBe(0);
});

test("Notion: you are found by your email among the workspace's users; your own comment, others' discussions and your page are told apart", async () => {
  const { Composio } = await import("../src/composio");
  const home = mkdtempSync(join(tmpdir(), "jin-inv-"));
  const feed = new Feed(openDb(home));
  const calls: string[] = [];
  const cli = async (args: string[]) => {
    const slug = args[2]!;
    const input = JSON.parse(args[args.indexOf("-d") + 1]!) as Record<string, string>;
    calls.push(slug);
    if (slug === "NOTION_WHO_AM_I") return { successful: true, data: { data: { type: "bot", owner_email: "Me@x.com" } } };
    if (slug === "NOTION_LIST_USERS")
      return input.start_cursor
        ? { successful: true, data: { response_data: { results: [{ id: "n-me", person: { email: "me@x.com" } }], has_more: false } } }
        : { successful: true, data: { response_data: { results: [{ id: "n-bob", person: { email: "bob@x.com" } }], has_more: true, next_cursor: "2" } } };
    if (slug === "NOTION_RETRIEVE_PAGE") return { successful: true, data: { created_by: { id: input.page_id === "p-mine" ? "n-me" : "n-bob" } } };
    if (slug === "NOTION_RETRIEVE_COMMENT") return { successful: true, data: { id: input.comment_id, discussion_id: input.comment_id === "c-in" ? "d-in" : "d-out", parent: { block_id: "b1" }, rich_text: [] } };
    if (slug === "NOTION_FETCH_COMMENTS") return { successful: true, data: { results: [{ id: "c0", discussion_id: "d-in", created_by: { id: "n-me" } }] } };
    throw new Error(`unexpected ${slug}`);
  };
  const fields = { deps: { feed }, settings: { userId: "u", me: {} }, config: { home }, cli, notionNames: null, save(patch: Record<string, unknown>) { Object.assign(this.settings, patch); } };
  const c = Object.create(Composio.prototype, Object.fromEntries(Object.entries(fields).map(([k, value]) => [k, { value, writable: true }])));
  const ev = (author: string, comment: string, page: string) => ({ triggerSlug: "NOTION_COMMENT_CREATED", data: { authors: [{ id: author }], comment_id: comment, data: { page_id: page } } });
  expect(await c.notionMe()).toBe("n-me");
  expect(await c.notionWhy(ev("n-me", "c-in", "p-other"))).toBe("own");
  expect(await c.notionWhy(ev("n-bob", "c-x", "p-mine"))).toBe("mine");
  expect(await c.notionWhy(ev("n-bob", "c-in", "p-other"))).toBe("discussion");
  expect(await c.notionWhy(ev("n-bob", "c-out", "p-other"))).toBeNull();
  // Known now: not looked up again.
  const before = calls.filter((s) => s === "NOTION_LIST_USERS").length;
  await c.notionMe();
  expect(calls.filter((s) => s === "NOTION_LIST_USERS").length).toBe(before);
});

test("a large tool answer stored in a file is read from there", async () => {
  const { Composio } = await import("../src/composio");
  const { writeFileSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "jin-inv-"));
  const file = join(home, "out.json");
  const ts = (Date.now() / 1000 - 3600).toFixed(6);
  writeFileSync(file, JSON.stringify({ successful: true, data: { messages: { matches: [{ ts, permalink: "https://x/archives/C1/p90?thread_ts=5.1", channel: { id: "C1" } }], paging: { pages: 1 } } } }));
  const threads = new SlackThreads(home);
  const fields = { deps: { feed: null, slackThreads: threads }, settings: { userId: "u", me: { slack: "U_ME" } }, config: { home }, cli: async () => ({ successful: true, error: null, storedInFile: true, outputFilePath: file }) };
  const c = Object.create(Composio.prototype, Object.fromEntries(Object.entries(fields).map(([k, value]) => [k, { value, writable: true }])));
  expect(await c.seedSlackThreads()).toBe(1);
  expect(threads.has("slack:C1:5.1")).toBe(true);
});
