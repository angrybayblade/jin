import { expect, test } from "bun:test";
import { parsePr } from "../src/bobby";

test("parses GitHub pull request URLs only", () => {
  expect(parsePr("https://github.com/ComposioHQ/platform/pull/14310")).toEqual({ owner: "ComposioHQ", repo: "platform", number: 14310 });
  expect(parsePr("https://github.com/ComposioHQ/platform/pull/14310/files#diff")).toEqual({ owner: "ComposioHQ", repo: "platform", number: 14310 });
  expect(parsePr("https://github.com/ComposioHQ/dashboard/issues/3311")).toBeNull();
  expect(parsePr("https://evil.example/ComposioHQ/platform/pull/1")).toBeNull();
});
