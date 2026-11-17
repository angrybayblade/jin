import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { Feed, githubItems } from "../src/feed";

const ws = (id: string, owners: string[]) => ({ id, adapter: "composio" as const, root: "/x", github: { owners }, profile: { claudeConfigDir: "/c" } });
const node = (repo: string, n: number, ci?: string) => ({
  number: n, title: `t${n}`, url: `https://github.com/${repo}/pull/${n}`, updatedAt: "2026-11-15T00:00:00Z",
  repository: { nameWithOwner: repo }, commits: { nodes: ci ? [{ commit: { statusCheckRollup: { state: ci } } }] : [] },
});

test("items go to the workspace that owns the repo, case-insensitively", () => {
  const items = githubItems({ reviewRequested: { nodes: [node("composiohq/platform", 1), node("Other/x", 2)] } }, [ws("composio", ["ComposioHQ"]), ws("other", ["Other"])]);
  expect(items.map((i) => [i.workspace, i.title])).toEqual([["composio", "t1"], ["other", "t2"]]);
});

test("only failing or errored checks on your PRs become items", () => {
  const items = githubItems({ authored: { nodes: [node("A/a", 1, "FAILURE"), node("A/a", 2, "ERROR"), node("A/a", 3, "PENDING"), node("A/a", 4)] } }, [ws("a", [])]);
  expect(items.map((i) => i.title)).toEqual(["t1", "t2"]);
});

test("a name learned for a Slack id shows on past items of that person", () => {
  const feed = new Feed(openDb(mkdtempSync(join(tmpdir(), "jin-feed-"))));
  const thread = { key: "slack:dm:D1", title: "DM with U0CAT00001", ref: null, url: null };
  feed.add([
    { workspace: "w", source: "slack", kind: "dm", externalRef: "a", title: "", summary: "hi", receivedAt: "t", thread, actor: "U0CAT00001" },
    { workspace: "w", source: "slack", kind: "dm", externalRef: "b", title: "", summary: "ask @U0CAT00001", receivedAt: "t", thread: { ...thread, key: "slack:dm:D2", title: "DM with U0BOB00001" }, actor: "U0BOB00001" },
    { workspace: "w", source: "github", kind: "c", externalRef: "c", title: "U0CAT00001", summary: "", receivedAt: "t" },
  ]);
  feed.rename("slack", "U0CAT00001", "Cat Lee");
  const by = Object.fromEntries(feed.list().map((i) => [i.externalRef, i]));
  expect(by.a).toMatchObject({ actor: "Cat Lee", thread: { title: "DM with Cat Lee" } });
  expect(by.b).toMatchObject({ actor: "U0BOB00001", summary: "ask @Cat Lee" });
  expect(by.c!.title).toBe("U0CAT00001"); // another source keeps its text
});
