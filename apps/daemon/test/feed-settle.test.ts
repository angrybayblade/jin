import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvent } from "../src/composio";
import { openDb } from "../src/db";
import { Feed, type NewItem } from "../src/feed";
import { prSettlement } from "../src/github-watch";

const fresh = () => new Feed(openDb(mkdtempSync(join(tmpdir(), "jin-settle-"))));
const item = (ref: string, kind: string, key: string, at: string, tags?: string[]): NewItem => ({ workspace: "w", source: key.startsWith("github") ? "github" : "slack", kind, externalRef: ref, title: kind, summary: "", receivedAt: at, thread: { key, title: key, ref: null, url: null }, tags });
const open = (f: Feed) => f.list().filter((i) => i.state === "new").map((i) => i.externalRef).sort();

test("items keep why they concern you", () => {
  const f = fresh();
  f.add([item("a", "github_pr_review", "github:o/r#1", "2026-11-18T10:00:00Z", ["authored", "mentioned"])]);
  expect(f.list()[0]!.tags).toEqual(["authored", "mentioned"]);
});

test("acting on a thread clears what came before; PRs no longer open clear; a sweep clears the old", () => {
  const f = fresh();
  f.add([
    item("a", "github_pr_comment", "github:o/r#1", "2026-11-18T10:00:00Z"),
    item("b", "github_pr_comment", "github:o/r#1", "2026-11-18T12:00:00Z"),
    item("c", "github_pr_commit", "github:o/r#2", "2026-11-18T10:00:00Z"),
    item("d", "slack_direct_message_received", "slack:dm:D1", "2026-11-10T10:00:00Z"),
    item("e", "review_requested", "github:o/r#3", "2026-11-18T10:00:00Z"),
  ]);
  // You commented on #1 at 11:00: the earlier comment is handled, the later one is not.
  expect(f.clearThread("github:o/r#1", "2026-11-18T11:00:00Z")).toBe(1);
  // #2 is merged (not in the open set); #1 and #3 are open. Slack is not a PR.
  expect(f.settlePrs(new Set(["github:o/r#1", "github:o/r#3"]))).toBe(1);
  expect(open(f)).toEqual(["b", "d", "e"]);
  // The collector no longer lists #3 as waiting for your review.
  expect(f.settleCollected(["review_requested"], new Set())).toBe(1);
  expect(f.sweep("2026-11-15T00:00:00Z")).toBe(1);
  expect(open(f)).toEqual(["b"]);
});

test("a snooze that has run out brings the item back", () => {
  const f = fresh();
  f.add([item("a", "github_pr_comment", "github:o/r#1", "2026-11-18T10:00:00Z")]);
  const id = f.list()[0]!.id;
  f.setState(id, "snoozed", { snoozedUntil: new Date(Date.now() - 1000).toISOString() });
  expect(f.list()[0]!.state).toBe("new");
  f.setState(id, "snoozed", { snoozedUntil: new Date(Date.now() + 60_000).toISOString() });
  expect(f.list()[0]!.state).toBe("snoozed");
});

test("your own Slack reply or PR comment says which thread you handled", () => {
  const handled: string[] = [];
  const me = { slack: "U_ME", github: "viraj" };
  expect(readEvent({ triggerSlug: "SLACK_DIRECT_MESSAGE_RECEIVED", data: { text: "on it", user: "U_ME", channel: "D1", ts: "1.2" } }, me, undefined, (k) => handled.push(k))).toBeNull();
  expect(readEvent({ triggerSlug: "GITHUB_ISSUE_COMMENT", data: { user: "viraj", repository: { full_name: "O/r" }, issue: { number: 4, title: "x" } } }, { ...me }, undefined, (k) => handled.push(k))).toBeNull();
  expect(handled).toEqual(["slack:dm:D1", "github:o/r#4"]);
});

test("the watch knows which PRs are open and where you last acted", () => {
  const pr = (n: number, comments: [string, string][], reviews: [string, string, string][] = []) => ({
    number: n, title: `t${n}`, url: `https://github.com/O/r/pull/${n}`, repository: { nameWithOwner: "O/r" },
    comments: { nodes: comments.map(([login, at], i) => ({ id: `c${n}${i}`, url: "", body: "", createdAt: at, author: { login } })) },
    reviews: { nodes: reviews.map(([login, at, state], i) => ({ id: `r${n}${i}`, url: "", body: "", state, submittedAt: at, author: { login }, comments: { nodes: [] } })) },
    commits: { nodes: [] },
  });
  const s = prSettlement({ viewer: { login: "Viraj" }, reviewing: { nodes: [pr(1, [["sam", "2026-11-18T09:00:00Z"], ["viraj", "2026-11-18T10:00:00Z"]], [["viraj", "2026-11-18T11:00:00Z", "APPROVED"]])] }, mine: { nodes: [pr(2, [["sam", "2026-11-18T09:00:00Z"]])] } } as any);
  expect([...s.open]).toEqual(["github:o/r#1", "github:o/r#2"]);
  expect(s.mine).toEqual([{ key: "github:o/r#1", at: "2026-11-18T11:00:00Z" }]);
});
