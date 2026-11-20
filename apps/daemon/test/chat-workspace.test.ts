import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import type { HarnessRun } from "../src/harness/types";
import { Sessions } from "../src/sessions";

// Chats start in the workspace (its CLAUDE.md and skills load), keep notes in their own folder,
// and do not change the workspace; with no workspace on the machine they say so, not clone.
const setup = (withRoot = true) => {
  const home = mkdtempSync(join(tmpdir(), "jin-chatws-"));
  const root = join(home, "composio-workspace");
  if (withRoot) mkdirSync(root);
  const runs: HarnessRun[] = [];
  const verdicts: { allow: boolean; reason?: string }[] = [];
  const sessions = new Sessions({
    db: openDb(home),
    config: { home } as never,
    tasks: {} as never,
    adapters: new Map(),
    workspaces: [{ id: "composio-workspace", root, adapter: "cws", profile: {} } as never],
    harness: () => ({
      id: "claude",
      adapter: "test",
      run: async (r: HarnessRun) => {
        runs.push(r);
        verdicts.push(await r.gate("Write", { file_path: join(root, "repos/platform/x.py") }, r.signal));
        verdicts.push(await r.gate("Write", { file_path: join(home, "chats/desk/notes.md") }, r.signal));
        return { sessionId: "s1" };
      },
    }),
  });
  return { home, root, runs, verdicts, sessions };
};

test("a new chat starts in the workspace, with its scratch folder added; it cannot edit the workspace", async () => {
  const { home, root, runs, verdicts, sessions } = setup();
  sessions.startChat("desk", "catch me up", undefined, "Desk");
  await Bun.sleep(50);
  expect(runs[0]!.cwd).toBe(root);
  expect(runs[0]!.addDirs).toEqual([join(home, "chats", "desk")]);
  expect(runs[0]!.instructions).toContain("never clone a repo into a temporary folder");
  expect(verdicts[0]).toMatchObject({ allow: false });
  expect(verdicts[0]!.reason).toContain("start a task");
  expect(verdicts[1]).toEqual({ allow: true });
});

test("with no workspace on this machine: the scratch folder, and gh instead of cloning", async () => {
  const { home, runs, sessions } = setup(false);
  sessions.startChat("jin", "what is apollo?", undefined, "Q");
  await Bun.sleep(50);
  expect(runs[0]!.cwd).toBe(join(home, "chats", "jin"));
  expect(runs[0]!.addDirs).toEqual([]);
  expect(runs[0]!.instructions).toContain("not on this machine");
});
