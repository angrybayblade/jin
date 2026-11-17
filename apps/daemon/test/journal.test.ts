import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { evidenceOf, Journal } from "../src/journal";

const setup = () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "jin-journal-")));
  const terms: Record<string, { taskId: string | null; title: string; root?: string }> = { t1: { taskId: "PLEN-1", title: "Claude 1", root: "/ws/tasks/PLEN-1" }, t2: { taskId: "PLEN-1", title: "Claude 2", root: "/ws/tasks/PLEN-1" }, sh: { taskId: null, title: "Shell" } };
  return new Journal(db, (id) => terms[id] ?? null);
};

test("evidence: changed files (short paths), commits with their message, test runs; nothing for reads", () => {
  expect(evidenceOf("Edit", { file_path: "/ws/tasks/PLEN-1/platform/limiter.py" }, "/ws/tasks/PLEN-1")).toEqual({ type: "file", text: "platform/limiter.py" });
  expect(evidenceOf("Bash", { command: 'git commit -m "fix(apollo): retry on 429"' })).toEqual({ type: "commit", text: "fix(apollo): retry on 429" });
  // A workspace's own check command counts as a test run only where that workspace says so.
  expect(evidenceOf("Bash", { command: "cws check platform" })).toBeNull();
  expect(evidenceOf("Bash", { command: "cws check platform" }, undefined, [/\bcws check\b/])).toEqual({ type: "test", text: "cws check platform" });
  expect(evidenceOf("Bash", { command: "cd platform && pytest tests/limiter" })?.type).toBe("test");
  expect(evidenceOf("Read", { file_path: "/x" })).toBeNull();
  expect(evidenceOf("Bash", { command: "ls" })).toBeNull();
});

test("entries group by concern in the order concerns started; a new label hears the existing ones", () => {
  const j = setup();
  expect(j.add("t1", { concern: "rate limiter", kind: "decision", text: "Retry on 429", why: "Retry-After is unreliable" }).reply).toBe("ok");
  expect(j.add("t1", { concern: "tests", kind: "done", text: "Added limiter tests" }).reply).toBe('ok; new concern "tests" (existing: rate limiter)');
  // Another case or spacing is the same concern.
  expect(j.add("t2", { concern: "Rate  Limiter", kind: "found", text: "mercury already retries" }).reply).toBe("ok");
  const v = j.view("PLEN-1");
  expect(v.concerns.map((c) => [c.name, c.entries.map((e) => `${e.kind}:${e.session}`)])).toEqual([
    ["rate limiter", ["decision:Claude 1", "found:Claude 2"]],
    ["tests", ["done:Claude 1"]],
  ]);
  expect(() => j.add("t1", { concern: "x", kind: "blocked", text: "y" })).toThrow("kind must be one of");
  expect(() => j.add("sh", { concern: "x", kind: "done", text: "y" })).toThrow("Claude Code in a task");
});

test("evidence goes on the latest entry of the same turn; changes with no entry in their turn show as not journaled", () => {
  const j = setup();
  j.turnStarted("t1");
  j.add("t1", { concern: "rate limiter", kind: "decision", text: "Retry on 429" });
  j.evidence("t1", "Edit", { file_path: "/ws/tasks/PLEN-1/platform/limiter.py" });
  j.evidence("t1", "Edit", { file_path: "/ws/tasks/PLEN-1/platform/limiter.py" }); // once per file
  j.evidence("t1", "Bash", { command: "pytest" });
  // Next turn, nothing journaled: the edits are collected apart.
  j.turnStarted("t1");
  j.evidence("t1", "Write", { file_path: "/ws/tasks/PLEN-1/platform/README.md" });
  j.evidence("t1", "Edit", { file_path: "/ws/tasks/PLEN-1/platform/x.py" });
  const v = j.view("PLEN-1");
  expect(v.concerns[0]!.entries[0]!.refs).toEqual([
    { type: "file", text: "platform/limiter.py" },
    { type: "test", text: "pytest" },
  ]);
  expect(v.unjournaled.map((e) => e.refs.map((r) => r.text))).toEqual([["platform/README.md", "platform/x.py"]]);
});
