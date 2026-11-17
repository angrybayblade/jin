import { expect, test } from "bun:test";
import { logEvent, readEvent, triggerConfig } from "../src/composio";

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
