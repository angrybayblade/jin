import { expect, test } from "bun:test";
import { deskStatuses } from "../src/desks";

test("each desk finds its connector or MCP server, connected first", () => {
  const s = deskStatuses([
    { name: "claude.ai Gmail", status: "connected" },
    { name: "claude.ai Slack", status: "needs-auth" },
    { name: "slack", status: "connected" },
    { name: "claude.ai Linear", status: "failed" },
  ]);
  expect(s).toEqual([
    { kind: "gmail", state: "connected", via: "claude.ai Gmail" },
    { kind: "slack", state: "connected", via: "slack" },
    { kind: "linear", state: "failed", via: "claude.ai Linear" },
    { kind: "notion", state: "missing", via: null },
  ]);
});
