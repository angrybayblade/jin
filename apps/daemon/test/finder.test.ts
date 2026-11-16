import { expect, test } from "bun:test";
import { fuzzyScore } from "../src/finder";

const rank = (q: string, paths: string[]) =>
  paths
    .map((p) => ({ p, s: fuzzyScore(q, p) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => b.s! - a.s!)
    .map((x) => x.p);

test("characters must appear in order", () => {
  expect(fuzzyScore("rtry", "platform/apps/thermos/retry.go")).not.toBeNull();
  expect(fuzzyScore("yrt", "platform/apps/thermos/retry.go")).toBeNull();
});

test("file-name and word-start matches rank first", () => {
  expect(rank("retry", ["platform/docs/retrospective-try.md", "platform/apps/thermos/webhook/retry.go", "mercury/src/r/e/t/r/y.ts"])[0]).toBe("platform/apps/thermos/webhook/retry.go");
  expect(rank("tool router", ["platform/apps/apollo/src/toolRouter/session.ts", "platform/apps/apollo/src/tools/route-r.ts"])[0]).toBe("platform/apps/apollo/src/toolRouter/session.ts");
  expect(rank("errors", ["dashboard/src/lib/errors.ts", "dashboard/src/components/ErrorsBanner.tsx", "dashboard/src/errata/old.rs"])[0]).toBe("dashboard/src/lib/errors.ts");
});
