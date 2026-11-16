import { expect, test } from "bun:test";
import { readEvent, triggerConfig } from "../src/composio";

const me = { slack: "U_ME", linear: "lin-me", github: "me-gh", email: "me@example.com" };

test("a Slack DM is for you; your own DM and channel chatter without a mention are not shown", () => {
  const dm = readEvent({ triggerSlug: "SLACK_DIRECT_MESSAGE_RECEIVED", id: "e1", data: { text: "lunch?", user: "U_ALEX", channel: "D1", ts: "1.2" } }, me);
  expect(dm).toMatchObject({ toolkit: "slack", title: "Slack DM from U_ALEX", summary: "lunch?", forYou: true });
  expect(readEvent({ triggerSlug: "SLACK_DIRECT_MESSAGE_RECEIVED", data: { text: "sent by me", user: "U_ME" } }, me)).toBeNull();
  expect(readEvent({ type: "SLACK_CHANNEL_MESSAGE_RECEIVED", payload: { text: "deploy is green", user: "U_BOB", channel_type: "channel" } }, me)).toBeNull();
  const mention = readEvent({ metadata: { trigger_slug: "SLACK_CHANNEL_MESSAGE_RECEIVED" }, data: { text: "<@U_ME> can you look?", user: "U_BOB" } }, me);
  expect(mention).toMatchObject({ title: "Slack mention by U_BOB", forYou: true });
});

test("mail from a person is for you; automated mail is kept but quiet", () => {
  const person = readEvent({ triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE", data: { sender: "Alex <alex@acme.com>", subject: "Contract", messageText: "see attached", messageId: "m1" } }, me);
  expect(person).toMatchObject({ title: "Mail: Contract", forYou: true, url: "https://mail.google.com/mail/u/0/#inbox/m1" });
  const robot = readEvent({ triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE", data: { sender: "GitHub <notifications@github.com>", subject: "[x] PR merged" } }, me);
  expect(robot).toMatchObject({ forYou: false });
});

test("Linear: for you when assigned to you or you are mentioned", () => {
  const assigned = readEvent({ triggerSlug: "LINEAR_ISSUE_UPDATED_TRIGGER", data: { issue: { identifier: "PLEN-1", title: "Fix limiter", assignee: { id: "lin-me" }, url: "https://linear.app/x/PLEN-1" } } }, me);
  expect(assigned).toMatchObject({ title: "Linear updated PLEN-1 Fix limiter", forYou: true, url: "https://linear.app/x/PLEN-1" });
  const other = readEvent({ triggerSlug: "LINEAR_ISSUE_CREATED_TRIGGER", data: { issue: { identifier: "PLEN-2", title: "Other", assignee: { id: "lin-bob" } } } }, me);
  expect(other).toMatchObject({ forYou: false });
});

test("GitHub activity on watched PRs is for you, except your own", () => {
  const c = readEvent({ triggerSlug: "GITHUB_PR_REVIEW_COMMENT_CREATED_TRIGGER", data: { comment: { user: { login: "alex" }, body: "nit: rename", html_url: "https://github.com/o/r/pull/3#c1" }, pull_request: { number: 3, title: "Limiter" }, repository: { full_name: "o/r" } } }, me);
  expect(c).toMatchObject({ title: "GitHub review comment on o/r#3 Limiter", forYou: true, url: "https://github.com/o/r/pull/3#c1", summary: "nit: rename" });
  expect(readEvent({ triggerSlug: "GITHUB_ISSUE_COMMENT_CREATED_TRIGGER", data: { comment: { user: { login: "me-gh" }, body: "done" } } }, me)).toBeNull();
});

test("a trigger instance's config is read from Composio's doubly encoded JSON", () => {
  expect(triggerConfig({ id: "t", trigger_name: "X", toolkit_slug: "slack", connected_account_id: "c", status: "ACTIVE", disabled_at: null, trigger_data: '"{\\"team_id\\": \\"T1\\"}"' })).toEqual({ team_id: "T1" });
});
