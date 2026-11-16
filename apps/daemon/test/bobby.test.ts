import { expect, test } from "bun:test";
import { openInBrowser, parsePr } from "../src/bobby";

test("parses GitHub pull request URLs only", () => {
  expect(parsePr("https://github.com/ComposioHQ/platform/pull/14310")).toEqual({ owner: "ComposioHQ", repo: "platform", number: 14310 });
  expect(parsePr("https://github.com/ComposioHQ/platform/pull/14310/files#diff")).toEqual({ owner: "ComposioHQ", repo: "platform", number: 14310 });
  expect(parsePr("https://github.com/ComposioHQ/dashboard/issues/3311")).toBeNull();
  expect(parsePr("https://evil.example/ComposioHQ/platform/pull/1")).toBeNull();
});

test("opens a review in the default browser, and says when it cannot", async () => {
  const ran: string[][] = [];
  await openInBrowser("http://127.0.0.1:4173/r/o/r/1", async (cmd) => (ran.push(cmd), 0));
  expect(ran).toEqual([[process.platform === "darwin" ? "open" : "xdg-open", "http://127.0.0.1:4173/r/o/r/1"]]);
  await expect(openInBrowser("http://x", async () => 1)).rejects.toThrow("could not open a browser");
});
