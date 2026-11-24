import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HOOKS, Hooks, PREVIOUS_DEFAULTS } from "../src/hooks";

test("memory p2: the merge cleanup keeps what the task learned before it cleans up; an untouched older default takes the new wording, an edited one stays", () => {
  const home = mkdtempSync(join(tmpdir(), "jin-hooks-mem-"));
  const cleanup = DEFAULT_HOOKS.find((h) => h.name === "Clean up after a merge")!;
  expect(cleanup.instructions).toContain("jin_task_memory");
  expect(cleanup.instructions).toContain("jin_keep_memory");
  const older = PREVIOUS_DEFAULTS["Clean up after a merge"]!.at(-1)!;
  writeFileSync(
    join(home, "hooks.json"),
    JSON.stringify([
      { ...cleanup, id: "h1", instructions: older, createdAt: "2026-01-01" },
      { ...cleanup, id: "h2", name: "Clean up after a merge", instructions: `${older}\n5. Also tell #eng.`, createdAt: "2026-01-01" },
    ]),
  );
  const hooks = new Hooks(home, { startChat: async () => ({ id: "c" }), notify: () => {} });
  expect(hooks.list().map((h) => [h.id, h.instructions === cleanup.instructions])).toEqual([
    ["h1", true],
    ["h2", false],
  ]);
});

test("memory p2: Wrap up starts jin's keep-what-it-learned step for any task, naming its machine", async () => {
  const started: { title: string; prompt: string }[] = [];
  const hooks = new Hooks(mkdtempSync(join(tmpdir(), "jin-wrap-")), { startChat: async (title, prompt) => (started.push({ title, prompt }), { id: "c1" }), notify: () => {} });
  const r = await hooks.wrapUp({ task: { id: "REV-7", title: "Review keyring auth" }, machine: "oai-pipeline" });
  expect(r).toEqual({ chatId: "c1" });
  expect(started[0]!.title).toBe("Wrap up: REV-7");
  expect(started[0]!.prompt).toContain("jin_task_memory");
  expect(started[0]!.prompt).toContain("jin_keep_memory");
  expect(started[0]!.prompt).toContain('"machine": "oai-pipeline"');
  // Only what it learned: no archiving, no removal.
  expect(started[0]!.prompt).not.toContain("jin_remove_task");
});
