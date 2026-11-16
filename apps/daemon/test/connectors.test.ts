import { expect, test } from "bun:test";
import { connectorsReady } from "../src/harness/claude";

type S = { name: string; status: string };
const seq = (...steps: S[][]) => {
  let i = 0;
  return async () => steps[Math.min(i++, steps.length - 1)] as never;
};

test("waits until the claude.ai connectors are listed and none is still connecting", async () => {
  const status = seq([], [{ name: "claude.ai Gmail", status: "pending" }], [{ name: "claude.ai Gmail", status: "connected" }, { name: "claude.ai Slack", status: "needs-auth" }]);
  let calls = 0;
  await connectorsReady(async () => (calls++, status()), 5000, 5000);
  expect(calls).toBe(3);
});

test("gives up soon when the user has no connectors, and at the limit when one never connects", async () => {
  let t = Date.now();
  await connectorsReady(async () => [], 5000, 300);
  expect(Date.now() - t).toBeLessThan(1500);
  t = Date.now();
  await connectorsReady(async () => [{ name: "claude.ai Gmail", status: "pending" }] as never, 400, 5000);
  expect(Date.now() - t).toBeLessThan(1500);
});
