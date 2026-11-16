import { expect, test } from "bun:test";
import { githubItems } from "../src/feed";

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
