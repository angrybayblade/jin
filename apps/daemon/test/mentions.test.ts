import { expect, test } from "bun:test";
import type { FeedItem } from "../src/feed";
import { chatLines, mentionContext, mentionLabels, Mentions, type MachineSnapshot } from "../src/mentions";

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

test("what a chat mentioned: links of every kind, resolved @mentions, ids jin knows; newest first", async () => {
  const m = new Mentions({ machines, feed: () => [...feed(), { thread: { key: "slack:C0123ABCD:1731900000.123456", title: "#platform: deploy freeze?" } }] as unknown as FeedItem[], pr: async () => null, issue: async () => null });
  const refs = await m.inChat(
    chatLines([
      { seq: 1, kind: "prompt", payload: { text: "what's up with @PLEN-1334? and https://acme.slack.com/archives/C0123ABCD/p1731900000123456" } },
      { seq: 2, kind: "prompt.mentions", payload: { mentions: [{ label: "PLEN-1334", kind: "issue", key: "linear:PLEN-1334", title: "Limit per user", url: "https://linear.app/composio/issue/PLEN-1334", state: "In Progress", detail: null }] } },
      {
        seq: 3,
        kind: "message",
        payload: {
          text: "PLEN-1334 has platform#133 open ([fix limiter](https://github.com/ComposioHQ/platform/pull/133)). See the [design doc](https://www.notion.so/acme/Rate-limits-0123456789abcdef0123456789abcdef) and https://docs.example.com/limits. Not tickets: UTF-8, SHA-256, http://localhost:3000.",
        },
      },
    ]),
  );
  expect(refs.map((r) => [r.kind, r.label, r.by])).toEqual([
    ["issue", "PLEN-1334", "both"],
    ["task", "PLEN-1334", "both"],
    ["pr", "platform#133", "jin"],
    ["notion", "design doc", "jin"],
    ["link", "docs.example.com/limits", "jin"],
    ["slack", "Slack thread", "you"],
  ]);
  expect(refs[0]).toMatchObject({ state: "In Progress", count: 2, lastSeq: 3 });
  expect(refs[2]).toMatchObject({ title: "fix limiter", state: "open", count: 1 });
  expect(refs[5]).toMatchObject({ key: "slack:C0123ABCD:1731900000.123456", title: "#platform: deploy freeze?" });
});

test("a task without a title takes its Linear issue's, else its first PR's", async () => {
  const m = new Mentions({
    machines,
    feed,
    pr: async (repo, n) => (repo === "ComposioHQ/mercury" && n === 9 ? { title: "Add retries", url: `https://github.com/${repo}/pull/${n}`, state: "OPEN", draft: false, review: null, checks: null, author: "sam" } : null),
    issue: async (id) => (id === "PLEN-1334" ? { title: "Limit per user", state: "In Progress", assignee: null, team: null } : null),
  });
  expect(await m.titleFor("plen-1334")).toEqual({ title: "Limit per user", from: "issue" });
  // Linear is not answering: the feed's title for the issue, without its id.
  expect(await m.titleFor("PLEN-99")).toEqual({ title: "Retry webhooks", from: "issue" });
  expect(await m.titleFor("my-task", ["https://acme.slack.com/archives/C1/p1", "https://github.com/ComposioHQ/mercury/pull/9"])).toEqual({ title: "Add retries", from: "pr" });
  // platform#133 is ComposioHQ/platform's (jin knows it), and gh does not answer: the title jin knows.
  expect(await m.titleFor("my-task", ["platform#133"])).toEqual({ title: "fix limiter", from: "pr" });
  expect(await m.titleFor("my-task")).toBeNull();
});
