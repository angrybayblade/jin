import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDir, within } from "../src/files";

const root = mkdtempSync(join(tmpdir(), "jin-files-"));
mkdirSync(join(root, "platform/src"), { recursive: true });
mkdirSync(join(root, "platform/node_modules"), { recursive: true });
writeFileSync(join(root, "platform/src/a.ts"), "x");
symlinkSync("/etc", join(root, "platform/escape"));

test("paths stay inside the task", () => {
  expect(within(root, "platform/src/a.ts").endsWith("platform/src/a.ts")).toBe(true);
  expect(() => within(root, "../outside")).toThrow("outside");
  expect(() => within(root, "/etc/passwd")).toThrow("outside");
  expect(() => within(root, "platform/escape/hosts")).toThrow("outside");
});

test("listings hide dependency and build folders, directories first", () => {
  expect(listDir(root, "platform").map((e) => e.name)).toEqual(["escape", "src"]);
});
