import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSettings, settingsProblems } from "../src/claude-settings";

test("a missing file reads as empty settings; a write creates it", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "jin-claude-")), ".claude");
  const s = new ClaudeSettings(dir);
  const first = s.read();
  expect(first).toMatchObject({ exists: false, settings: {}, hash: "", error: null });
  const after = s.write({ model: "claude-opus-5-5" }, first.hash);
  expect(after.exists).toBe(true);
  expect(after.text).toBe('{\n  "model": "claude-opus-5-5"\n}\n');
  expect(existsSync(`${s.path}.jin-backup`)).toBe(false);
});

test("a write keeps keys the page has no form for, refuses a stale base, and backs up the old file", () => {
  const dir = mkdtempSync(join(tmpdir(), "jin-claude-"));
  const s = new ClaudeSettings(dir);
  writeFileSync(s.path, JSON.stringify({ statusLine: { type: "command", command: "x" }, permissions: { allow: ["Bash(ls:*)"] } }));
  const before = s.read();
  const next = { ...before.settings, permissions: { allow: ["Bash(ls:*)", "Read"], defaultMode: "plan" } };
  const after = s.write(next, before.hash);
  expect(after.settings).toEqual({ statusLine: { type: "command", command: "x" }, permissions: { allow: ["Bash(ls:*)", "Read"], defaultMode: "plan" } });
  expect(readFileSync(`${s.path}.jin-backup`, "utf8")).toBe(before.text);
  // Someone (or `claude` itself) changed it since: the old base no longer applies.
  expect(() => s.write(next, before.hash)).toThrow("changed since you opened it");
});

test("a file that does not parse is shown raw, with what is wrong", () => {
  const dir = mkdtempSync(join(tmpdir(), "jin-claude-"));
  const s = new ClaudeSettings(dir);
  writeFileSync(s.path, '{ "model": ');
  const r = s.read();
  expect(r.settings).toBeNull();
  expect(r.error).toContain("not valid JSON");
  expect(r.text).toBe('{ "model": ');
});

test("problems are named for the keys the page edits", () => {
  expect(settingsProblems([])).toEqual(["settings must be a JSON object"]);
  expect(settingsProblems({ permissions: { allow: "Read", defaultMode: "yolo" }, env: { TOKEN: 1 }, cleanupPeriodDays: -1 })).toEqual([
    "permissions.allow must be a list of strings",
    "permissions.defaultMode must be one of default, acceptEdits, plan, auto, dontAsk, bypassPermissions",
    "env must map names to string values",
    "cleanupPeriodDays must be a whole number of days",
  ]);
  expect(settingsProblems({ hooks: { Stop: [{ hooks: [{ type: "command", command: "" }] }], PreToolUse: [{ matcher: "Bash" }] } })).toEqual([
    "hooks.Stop[0].hooks[0] needs a command",
    "hooks.PreToolUse[0] needs a hooks list",
  ]);
  expect(settingsProblems({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] }, someFutureKey: { anything: true } })).toEqual([]);
});
