import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasTranscript } from "../src/claude-cli";

const dir = mkdtempSync(join(tmpdir(), "jin-claude-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a Claude Code session can be resumed only when its conversation was saved", () => {
  mkdirSync(join(dir, "projects", "-Users-me-tasks-PLEN-1"), { recursive: true });
  writeFileSync(join(dir, "projects", "-Users-me-tasks-PLEN-1", "abc-123.jsonl"), "{}\n");
  expect(hasTranscript("abc-123", dir)).toBe(true);
  expect(hasTranscript("never-used", dir)).toBe(false); // opened, nothing sent
  expect(hasTranscript("../etc/passwd", dir)).toBe(false);
  expect(hasTranscript("abc-123", join(dir, "missing"))).toBe(false);
});
