import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveEvent } from "../src/composio";
import { GithubWatch, prEvents, type WatchData } from "../src/github-watch";

const pr = (number: number, extra: Partial<Record<"comments" | "reviews" | "commits", unknown[]>> = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  repository: { nameWithOwner: "o/r" },
  comments: { nodes: extra.comments ?? [] },
  reviews: { nodes: extra.reviews ?? [] },
  commits: { nodes: extra.commits ?? [] },
});
const data = (reviewing: unknown[], mine: unknown[]) => ({ viewer: { login: "Me" }, reviewing: { nodes: reviewing }, mine: { nodes: mine } }) as WatchData;

test("comments, reviews, and others' commits on PRs you review; not your own activity", () => {
  const ev = prEvents(
    data(
      [pr(1, { comments: [{ id: "c1", url: "u1", body: "please rebase", createdAt: "t", author: { login: "alex" } }, { id: "c2", url: "u2", body: "done", createdAt: "t", author: { login: "me" } }], commits: [{ commit: { oid: "abc", url: "uc", messageHeadline: "fix lint", committedDate: "t", author: { user: { login: "alex" } } } }] })],
      [pr(2, { reviews: [{ id: "r1", url: "ur", body: "", state: "CHANGES_REQUESTED", submittedAt: "t", author: { login: "bob" }, comments: { nodes: [{ id: "x", url: "ux", body: "rename this", author: { login: "bob" } }] } }], commits: [{ commit: { oid: "def", url: "ud", messageHeadline: "wip", committedDate: "t", author: { user: { login: "me" } } } }] })],
    ),
  );
  expect(ev.map((e) => [e.id, e.title])).toEqual([
    ["c:c1", "Comment by alex on o/r#1 PR 1 (reviewing)"],
    ["k:abc", "New commit by alex on o/r#1 PR 1 (reviewing)"],
    ["r:r1", "Changes requested by bob on o/r#2 PR 2"],
  ]);
  expect(ev[2]).toMatchObject({ summary: "rename this", forYou: true, toolkit: "github" });
});

test("the first look only remembers; later looks deliver what is new, once", async () => {
  const home = mkdtempSync(join(tmpdir(), "jin-ghw-"));
  let answer = data([pr(1, { comments: [{ id: "c1", url: "u", body: "old", createdAt: "t", author: { login: "alex" } }] })], []);
  const got: LiveEvent[] = [];
  const w = new GithubWatch(home, (e) => got.push(e), async () => JSON.stringify({ data: answer }));
  expect(await w.check()).toBe(0);
  answer = data([pr(1, { comments: [{ id: "c1", url: "u", body: "old", createdAt: "t", author: { login: "alex" } }, { id: "c2", url: "u", body: "new", createdAt: "t", author: { login: "alex" } }] })], []);
  expect(await w.check()).toBe(1);
  expect(await w.check()).toBe(0);
  expect(got.map((e) => e.summary)).toEqual(["new"]);
  // A restart remembers too.
  const again = new GithubWatch(home, (e) => got.push(e), async () => JSON.stringify({ data: answer }));
  expect(await again.check()).toBe(0);
});
