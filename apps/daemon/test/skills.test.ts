import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, Skills, tagsFor, taskPluginDir, taskSkills, withFrontmatter, writeTaskPlugin } from "../src/skills";

test("skills are kept with tags; a task's kind picks them by tag", () => {
  const home = mkdtempSync(join(tmpdir(), "jin-skills-"));
  const s = new Skills(home);
  s.save("review-deep", { body: "---\ndescription: Reviews a PR deeply\n---\n\nRead everything.", tags: ["pr-review", "PR-Review"] });
  s.save("house-style", { body: "# Our house style\n\nShort names.", tags: ["every-task"] });
  s.save("notes", { body: "Keep notes." });
  expect(s.list().map((x) => [x.name, x.description, x.tags])).toEqual([
    ["house-style", "Our house style", ["every-task"]],
    ["notes", "Keep notes.", []],
    ["review-deep", "Reviews a PR deeply", ["pr-review"]],
  ]);
  expect(s.bundle(tagsFor("review")).map((x) => x.name)).toEqual(["house-style", "review-deep"]);
  expect(s.bundle(tagsFor("linear")).map((x) => x.name)).toEqual(["house-style"]);
  expect(() => s.save("Bad Name", { body: "x" })).toThrow("lowercase");
  expect(() => s.save("x", { tags: ["a"] })).toThrow("needs its SKILL.md");
  s.remove("notes");
  expect(s.list().length).toBe(2);
});

test("a task's plugin holds its skills, with the frontmatter Claude Code needs", () => {
  const home = mkdtempSync(join(tmpdir(), "jin-skills-"));
  writeTaskPlugin(home, "REV-111701", [{ name: "review-deep", body: "---\ndescription: d\n---\nx", tags: [] }]);
  const dir = taskPluginDir(home, "REV-111701");
  expect(JSON.parse(readFileSync(join(dir, ".claude-plugin/plugin.json"), "utf8")).name).toBe("jin");
  expect(readFileSync(join(dir, "skills/review-deep/SKILL.md"), "utf8")).toStartWith("---\nname: review-deep\ndescription: d");
  expect(taskSkills(home, "REV-111701")).toEqual(["review-deep"]);
  writeTaskPlugin(home, "REV-111701", []);
  expect(existsSync(dir)).toBe(false);
  expect(describe(withFrontmatter("a", "plain text first line\nmore"))).toBe("plain text first line");
});
