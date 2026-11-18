import { expect, test } from "bun:test";
import type { FeedItem } from "../src/feed";
import { mentionContext, mentionLabels, Mentions, type MachineSnapshot } from "../src/mentions";

test("mentions are read from a message: PRs, ids; not emails or a bare @", () => {
  expect(mentionLabels("look at @platform#133 and @PLEN-1334, then (@ComposioHQ/mercury#9).")).toEqual(["platform#133", "PLEN-1334", "ComposioHQ/mercury#9"]);
  expect(mentionLabels("mail me@example.com or ping @ and @bob")).toEqual([]);
  expect(mentionLabels("@REV-111701 @REV-111701")).toEqual(["REV-111701"]);
});

const machines = async (): Promise<MachineSnapshot[]> => [
  {
    machine: "local",
    label: "d-jin",
    tasks: [],
    prs: [],
    terminals: [],
  },
  {
    machine: "mac",
    label: "virajs-mac",
    tasks: [
      { id: "PLEN-1334", title: null, slug: "limiter", state: "ready", issue: { tracker: "linear", id: "PLEN-1334" }, createdAt: "2026-11-01" },
      { id: "REV-111701", title: null, slug: "review rate limits", state: "ready", issue: null, createdAt: "2026-11-02" },
    ],
    prs: [{ taskId: "PLEN-1334", url: "https://github.com/ComposioHQ/platform/pull/133", repo: "ComposioHQ/platform", number: 133, title: "fix limiter", state: "OPEN", draft: false, review: "CHANGES_REQUESTED", checks: "failing" }],
    terminals: [{ taskId: "PLEN-1334", kind: "claude", status: "idle" }],
  },
];
const feed = (): FeedItem[] =>
  [{ thread: { key: "linear:PLEN-99", title: "PLEN-99 Retry webhooks", ref: "PLEN-99", url: "https://linear.app/composio/issue/PLEN-99/retry" } }] as unknown as FeedItem[];

test("search offers tasks first, then PRs and issues; a full ref jin does not know is looked up", async () => {
  const looked: string[] = [];
  const m = new Mentions({
    machines,
    feed,
    pr: async (repo, n) => (looked.push(`${repo}#${n}`), { title: "new thing", url: `https://github.com/${repo}/pull/${n}`, state: "OPEN", draft: true, review: null, checks: "pending", author: "sam" }),
    issue: async () => null,
  });
  const plen = await m.search("PLEN-13");
  expect(plen.map((x) => [x.kind, x.label])).toEqual([["task", "PLEN-1334"], ["issue", "PLEN-1334"]]);
  expect(plen[0]).toMatchObject({ url: "/m/mac/t/PLEN-1334", machineLabel: "virajs-mac", state: "Claude Code idle", detail: "PRs: platform#133 (open)" });
  expect((await m.search("plat")).map((x) => x.label)).toEqual(["platform#133"]);
  expect((await m.search("retry")).map((x) => x.label)).toEqual(["PLEN-99"]);
  // platform is ComposioHQ/platform (from what jin knows); an unknown PR is asked of gh.
  const fresh = await m.search("platform#7");
  expect(looked).toEqual(["ComposioHQ/platform#7"]);
  expect(fresh[0]).toMatchObject({ kind: "pr", label: "platform#7", state: "draft", detail: "checks pending · by sam" });
});

test("resolving a message: live PR state, the task and its Linear issue, and what the agent is told", async () => {
  const m = new Mentions({
    machines,
    feed,
    pr: async () => ({ title: "fix limiter", url: "https://github.com/ComposioHQ/platform/pull/133", state: "OPEN", draft: false, review: "CHANGES_REQUESTED", checks: "failing", author: "sarah" }),
    issue: async (id) => (id === "PLEN-1334" ? { title: "Limit per user", state: "In Progress", assignee: "Viraj", team: "Platform" } : null),
  });
  const found = await m.resolve("why is @platform#133 failing? see @PLEN-1334 and @NOPE-1");
  expect(found.map((x) => [x.kind, x.label])).toEqual([["pr", "platform#133"], ["task", "PLEN-1334"], ["issue", "PLEN-1334"]]);
  expect(found[2]).toMatchObject({ title: "Limit per user", state: "In Progress", detail: "assigned to Viraj · Platform" });
  const ctx = mentionContext(found);
  expect(ctx).toContain('- @platform#133: pull request "fix limiter" — open — checks failing · changes requested · by sarah (https://github.com/ComposioHQ/platform/pull/133)');
  expect(ctx).toContain("- @PLEN-1334: jin task on virajs-mac");
  expect(ctx).toContain('- @PLEN-1334: Linear issue "Limit per user" — In Progress — assigned to Viraj · Platform');
  expect(mentionContext([])).toBe("");
});
