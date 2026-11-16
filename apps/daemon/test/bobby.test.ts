import { expect, test } from "bun:test";
import { parsePr } from "../src/bobby";

test("parses GitHub pull request URLs only", () => {
  expect(parsePr("https://github.com/ComposioHQ/platform/pull/14310")).toEqual({ owner: "ComposioHQ", repo: "platform", number: 14310 });
  expect(parsePr("https://github.com/ComposioHQ/platform/pull/14310/files#diff")).toEqual({ owner: "ComposioHQ", repo: "platform", number: 14310 });
  expect(parsePr("https://github.com/ComposioHQ/dashboard/issues/3311")).toBeNull();
  expect(parsePr("https://evil.example/ComposioHQ/platform/pull/1")).toBeNull();
});

test("jin frames a page only when its headers allow jin's origin", async () => {
  const { framesAllowed } = await import("../src/bobby");
  const jin = ["http://127.0.0.1:3917", "http://localhost:3917"];
  const h = (o: Record<string, string>) => new Headers(o);
  expect(framesAllowed(h({ "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; frame-ancestors 'none'" }), jin)).toBe(false);
  expect(framesAllowed(h({ "content-security-policy": "default-src 'self'; frame-ancestors http://127.0.0.1:3917 http://localhost:3917" }), jin)).toBe(true);
  expect(framesAllowed(h({ "content-security-policy": "frame-ancestors https://other.example" }), jin)).toBe(false);
  expect(framesAllowed(h({ "x-frame-options": "DENY" }), jin)).toBe(false);
  expect(framesAllowed(h({}), jin)).toBe(true);
});
