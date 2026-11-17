import { expect, test } from "bun:test";
import { headline, logEvent, readEvent, triggerConfig, whereOf } from "../src/composio";

const me = { slack: "U_ME", linear: "lin-me", github: "me-gh", email: "me@example.com" };

test("a Slack DM is for you; your own DM and channel chatter without a mention are not shown", () => {
  const dm = readEvent({ triggerSlug: "SLACK_DIRECT_MESSAGE_RECEIVED", id: "e1", data: { text: "lunch?", user: "U_ALEX", channel: "D1", ts: "1.2" } }, me);
  expect(dm).toMatchObject({ toolkit: "slack", title: "", actor: "U_ALEX", summary: "lunch?", forYou: true, thread: { key: "slack:dm:D1", title: "DM with U_ALEX" } });
  expect(readEvent({ triggerSlug: "SLACK_DIRECT_MESSAGE_RECEIVED", data: { text: "sent by me", user: "U_ME" } }, me)).toBeNull();
  expect(readEvent({ type: "SLACK_CHANNEL_MESSAGE_RECEIVED", payload: { text: "deploy is green", user: "U_BOB", channel_type: "channel" } }, me)).toBeNull();
  const mention = readEvent({ metadata: { trigger_slug: "SLACK_CHANNEL_MESSAGE_RECEIVED" }, data: { text: "<@U_ME> can you look?", user: "U_BOB", channel: "C1", ts: "5.1" } }, me);
  expect(mention).toMatchObject({ title: "mentioned you", actor: "U_BOB", forYou: true, thread: { key: "slack:C1:5.1" } });
  // A reply in the same thread lands in the same group.
  const reply = readEvent({ triggerSlug: "SLACK_CHANNEL_MESSAGE_RECEIVED", data: { text: "<@U_ME> ping", user: "U_CAT", channel: "C1", ts: "6.0", thread_ts: "5.1" } }, me);
  expect(reply?.thread?.key).toBe("slack:C1:5.1");
});

test("mail from a person is for you; automated mail is kept but quiet", () => {
  const person = readEvent({ triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE", data: { sender: "Alex <alex@acme.com>", subject: "Contract", messageText: "see attached", messageId: "m1", threadId: "t1" } }, me);
  expect(person).toMatchObject({ actor: "Alex", forYou: true, url: "https://mail.google.com/mail/u/0/#inbox/m1", thread: { key: "gmail:t1", title: "Contract" } });
  const robot = readEvent({ triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE", data: { sender: "GitHub <notifications@github.com>", subject: "[x] PR merged" } }, me);
  expect(robot).toMatchObject({ forYou: false });
});

test("Linear: for you when assigned to you or you are mentioned", () => {
  const assigned = readEvent({ triggerSlug: "LINEAR_ISSUE_UPDATED_TRIGGER", data: { issue: { identifier: "PLEN-1", title: "Fix limiter", assignee: { id: "lin-me" }, url: "https://linear.app/x/PLEN-1" } } }, me);
  expect(assigned).toMatchObject({ title: "updated", forYou: true, url: "https://linear.app/x/PLEN-1", thread: { key: "linear:PLEN-1", title: "Fix limiter", ref: "PLEN-1" } });
  const other = readEvent({ triggerSlug: "LINEAR_ISSUE_CREATED_TRIGGER", data: { issue: { identifier: "PLEN-2", title: "Other", assignee: { id: "lin-bob" } } } }, me);
  expect(other).toMatchObject({ forYou: false });
});

test("GitHub activity on watched PRs is for you, except your own", () => {
  const c = readEvent({ triggerSlug: "GITHUB_PR_REVIEW_COMMENT_CREATED_TRIGGER", data: { comment: { user: { login: "alex" }, body: "nit: rename", html_url: "https://github.com/o/r/pull/3#c1" }, pull_request: { number: 3, title: "Limiter" }, repository: { full_name: "o/r" } } }, me);
  expect(c).toMatchObject({ title: "commented on a review", forYou: true, url: "https://github.com/o/r/pull/3#c1", summary: "nit: rename", thread: { key: "github:o/r#3", title: "Limiter", ref: "r#3" } });
  expect(readEvent({ triggerSlug: "GITHUB_ISSUE_COMMENT_CREATED_TRIGGER", data: { comment: { user: { login: "me-gh" }, body: "done" } } }, me)).toBeNull();
});

test("summaries drop the markup bots write", () => {
  const c = readEvent({ triggerSlug: "GITHUB_ISSUE_COMMENT_CREATED_TRIGGER", data: { comment: { user: { login: "cursor" }, body: "<!-- BUGBOT_REVIEW --> Cursor Bugbot found **1 issue**. <a href=\"https://x\">Fix</a> see [docs](https://d) - [ ] check `foo`" }, issue: { number: 4 }, repository: { full_name: "o/r" } } }, me);
  expect(c?.summary).toBe("Cursor Bugbot found 1 issue. Fix see docs check foo");
});

test("a trigger instance's config is read from Composio's doubly encoded JSON", () => {
  expect(triggerConfig({ id: "t", trigger_name: "X", toolkit_slug: "slack", connected_account_id: "c", status: "ACTIVE", disabled_at: null, trigger_data: '"{\\"team_id\\": \\"T1\\"}"' })).toEqual({ team_id: "T1" });
});

test("a trigger log (as composio dev logs triggers gives it) reads as its event", () => {
  // The shape of a real SLACK_DIRECT_MESSAGE_RECEIVED log; the values are made up.
  const payload = { attachments: [], blocks: [], bot_id: null, channel: "D9", channel_type: "im", files: null, parent_user_id: null, subtype: null, team_id: "T1", text: "got a minute?", thread_ts: null, ts: "1700000000.1", user: "U_ALEX" };
  const raw = logEvent({ id: "log1", appName: "slack", createdAt: "2026-11-17T03:00:00.000Z", meta: { id: "evt1", triggerName: "SLACK_DIRECT_MESSAGE_RECEIVED", triggerClientPayload: JSON.stringify(payload) } });
  expect(raw).toMatchObject({ triggerSlug: "SLACK_DIRECT_MESSAGE_RECEIVED", id: "evt1", timestamp: "2026-11-17T03:00:00.000Z" });
  expect(readEvent(raw!, me)).toMatchObject({ id: "evt1", actor: "U_ALEX", summary: "got a minute?", tags: ["dm"], thread: { key: "slack:dm:D9" }, at: "2026-11-17T03:00:00.000Z" });
  expect(logEvent({ id: "x", createdAt: "t", meta: {} })).toBeNull();
});

test("each app's event reads with who, where and what, from the fields that app uses", () => {
  // Gmail's trigger names its fields in snake_case.
  const mail = readEvent({ triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE", data: { sender: "Alex <alex@acme.com>", subject: "Contract", message_text: "see attached", message_id: "m1", thread_id: "t1" } }, me);
  expect(mail).toMatchObject({ actor: "Alex", summary: "see attached", thread: { key: "gmail:t1" } });
  // Linear's user is an object: its name is the actor; an issue change says where it stands.
  const comment = readEvent({ triggerSlug: "LINEAR_COMMENT_EVENT_TRIGGER", data: { action: "create", data: { body: "on it", user: { id: "u2", name: "Bea" }, issue: { identifier: "PLEN-3", title: "Limiter" } }, url: "https://linear.app/x/PLEN-3#c" } }, me);
  expect(comment).toMatchObject({ actor: "Bea", title: "commented", summary: "on it", thread: { key: "linear:PLEN-3", title: "Limiter" } });
  const moved = readEvent({ triggerSlug: "LINEAR_ISSUE_UPDATED_TRIGGER", data: { data: { identifier: "PLEN-4", title: "Docs", state: { name: "In Review" }, assignee: { id: "u3", name: "Cat" } } } }, me);
  expect(moved?.summary).toBe("Status: In Review · Assignee: Cat");
  // A Slack message that only shares another one, or a file, still says something.
  const shared = readEvent({ triggerSlug: "SLACK_DIRECT_MESSAGE_RECEIVED", data: { text: "", user: "U_ALEX", channel: "D1", attachments: [{ text: "the original message" }] } }, me);
  expect(shared?.summary).toBe("the original message");
  // Notion's event holds only ids: comments on one page group under it (its title comes later).
  const n1 = readEvent({ triggerSlug: "NOTION_COMMENT_CREATED", id: "e1", data: { authors: [{ id: "nu1", type: "person" }], comment_id: "c1", data: { page_id: "p-1", parent: { id: "b1", type: "block" } } } }, me);
  const n2 = readEvent({ triggerSlug: "NOTION_COMMENT_CREATED", id: "e2", data: { authors: [{ id: "nu1", type: "person" }], comment_id: "c2", data: { page_id: "p-1", parent: { id: "b2", type: "block" } } } }, me);
  expect(n1?.thread?.key).toBe("notion:p-1");
  expect(n2?.thread?.key).toBe("notion:p-1");
});

test("a notification names the app and the place, and someone when the actor is unknown", () => {
  expect(whereOf({ toolkit: "notion", thread: { key: "k", title: "Launch plan", ref: null, url: null } })).toBe("Notion · Launch plan");
  expect(whereOf({ toolkit: "linear", thread: { key: "k", title: "Limiter", ref: "PLEN-3", url: null } })).toBe("Linear · PLEN-3 Limiter");
  expect(headline({ toolkit: "linear", actor: null, title: "updated" })).toBe("Someone updated");
  expect(headline({ toolkit: "slack", actor: "Cat", title: "" })).toBe("Cat");
});

test("Notion comments stored before their details were looked up are read again from the trigger logs", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDb } = await import("../src/db");
  const { Feed } = await import("../src/feed");
  const { Composio } = await import("../src/composio");
  const home = mkdtempSync(join(tmpdir(), "jin-notion-"));
  const feed = new Feed(openDb(home));
  // As the old reading stored it: a thread of its own, "Notion page", nobody, nothing said.
  feed.add([{ workspace: "w", source: "notion", kind: "notion_comment_created", externalRef: "notion#log_1", title: "commented", summary: "", receivedAt: new Date().toISOString(), thread: { key: "notion:log_1", title: "Notion page", ref: null, url: null }, actor: null }]);
  const payload = { authors: [{ id: "nu1", type: "person" }], comment_id: "c1", data: { page_id: "p1", parent: { id: "b1", type: "block" } } };
  const cli = async (args: string[]) => {
    if (args[1] === "logs" && args.includes("NOTION_COMMENT_CREATED")) return { data: [{ id: "log_1", appName: "notion", createdAt: new Date().toISOString(), meta: { triggerName: "NOTION_COMMENT_CREATED", triggerClientPayload: JSON.stringify(payload) } }] };
    if (args[2] === "NOTION_RETRIEVE_COMMENT") return { successful: true, data: { discussion_id: "d-1", display_name: { resolved_name: "Dee Park" }, rich_text: [{ plain_text: "ship Friday?" }] } };
    if (args[2] === "NOTION_RETRIEVE_PAGE") return { successful: true, data: { url: "https://www.notion.so/Launch-p1", properties: { Name: { type: "title", title: [{ plain_text: "Launch plan" }] } } } };
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  // Composio's own methods, with its CLI and settings stood in for.
  const fields = { deps: { feed }, settings: { userId: "u", me: {} }, config: { home }, cli, notionNames: null };
  const c = Object.create(Composio.prototype, Object.fromEntries(Object.entries(fields).map(([k, value]) => [k, { value, writable: true }])));
  expect(await c.repairNotion()).toBe(1);
  expect(feed.list()[0]).toMatchObject({ actor: "Dee Park", summary: "ship Friday?", thread: { key: "notion:p1", title: "Launch plan", url: "https://www.notion.so/Launch-p1" } });
  expect(await c.repairNotion()).toBe(0);
});
