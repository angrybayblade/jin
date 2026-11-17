import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveEvent } from "../src/composio";
import { GithubWatch, prEvents, type WatchData } from "../src/github-watch";

const pr = (number: number, extra: Partial<Record<"comments" | "reviews" | "commits" | "requested", unknown[]>> = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  repository: { nameWithOwner: "o/r" },
  comments: { nodes: extra.comments ?? [] },
  reviews: { nodes: extra.reviews ?? [] },
  commits: { nodes: extra.commits ?? [] },
  reviewRequests: { nodes: (extra.requested ?? []).map((r) => ({ requestedReviewer: r })) },
});
const data = (reviewing: unknown[], mine: unknown[], reviewed: unknown[] = []) => ({ viewer: { login: "Me" }, reviewing: { nodes: reviewing }, mine: { nodes: mine }, reviewed: { nodes: reviewed } }) as WatchData;

test("comments, reviews, and others' commits on PRs you review; not your own activity", () => {
  const ev = prEvents(
    data(
      [pr(1, { comments: [{ id: "c1", url: "u1", body: "please rebase", createdAt: "t", author: { login: "alex" } }, { id: "c2", url: "u2", body: "done", createdAt: "t", author: { login: "me" } }], commits: [{ commit: { oid: "abc", url: "uc", messageHeadline: "fix lint", committedDate: "t", author: { user: { login: "alex" } } } }] })],
      [pr(2, { reviews: [{ id: "r1", url: "ur", body: "", state: "CHANGES_REQUESTED", submittedAt: "t", author: { login: "bob" }, comments: { nodes: [{ id: "x", url: "ux", body: "rename this", author: { login: "bob" } }] } }], commits: [{ commit: { oid: "def", url: "ud", messageHeadline: "wip", committedDate: "t", author: { user: { login: "me" } } } }] })],
    ),
  );
  expect(ev.map((e) => [e.id, e.actor, e.title, e.thread?.key])).toEqual([
    ["c:c1", "alex", "commented", "github:o/r#1"],
    ["k:abc", "alex", "pushed", "github:o/r#1"],
    ["r:r1", "bob", "requested changes", "github:o/r#2"],
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

test("each event says why it concerns you: your PR, asked of you, only of your team, a mention", () => {
  const comment = (id: string, body: string) => ({ id, url: id, body, createdAt: "t", author: { login: "alex" } });
  const ev = prEvents(
    data(
      [
        pr(1, { requested: [{ __typename: "User", login: "me" }], comments: [comment("a", "looks good")] }),
        pr(2, { requested: [{ __typename: "Team", slug: "platform" }], comments: [comment("b", "fyi"), comment("c", "cc @me can you check?"), comment("d", "ping @meow")] }),
      ],
      [pr(3, { comments: [comment("e", "nice")] })],
      [pr(4, { comments: [comment("f", "updated per your review")] })],
    ),
  );
  const tags = Object.fromEntries(ev.map((e) => [e.id, e.tags]));
  expect(tags).toEqual({ "c:a": ["reviewer"], "c:b": ["team-review"], "c:c": ["team-review", "mentioned"], "c:d": ["team-review"], "c:f": ["reviewer"], "c:e": ["authored"] });
});
