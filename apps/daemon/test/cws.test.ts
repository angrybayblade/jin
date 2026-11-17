import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CwsAdapter, parseGitmodules, slugFromBranch } from "../src/adapters/cws";

test("parses submodule paths, urls and branches", () => {
  const gm = parseGitmodules('[submodule "repos/platform"]\n\tpath = repos/platform\n\turl = git@github.com:ComposioHQ/platform.git\n\tbranch = master\n[submodule "repos/x"]\n\tpath = repos/x\n');
  expect(gm.get("repos/platform")).toEqual({ path: "repos/platform", url: "git@github.com:ComposioHQ/platform.git", branch: "master" });
  expect(gm.get("repos/x")).toEqual({ path: "repos/x" });
});


test("derives a title from the cws branch", () => {
  expect(slugFromBranch("fix/PLEN-4560-show-apollo-429s-correctly", "PLEN-4560")).toBe("show apollo 429s correctly");
  expect(slugFromBranch("feat/VIRAJ-CTX", "VIRAJ-CTX")).toBe("VIRAJ-CTX");
  expect(slugFromBranch(undefined, "X-1")).toBe("X-1");
});

test("lists the workspace's tasks from task.json, skipping folders without one", () => {
  const root = mkdtempSync(join(tmpdir(), "jin-ws-"));
  mkdirSync(join(root, "tasks/PLEN-1/platform"), { recursive: true });
  mkdirSync(join(root, "tasks/leftover"), { recursive: true });
  writeFileSync(join(root, "tasks/PLEN-1/task.json"), JSON.stringify({ id: "PLEN-1", type: "bug", branch: "fix/PLEN-1-retry-webhooks", repos: ["platform"], created: "2026-11-10T00:00:00Z" }));
  const tasks = new CwsAdapter({ id: "composio", adapter: "cws", root, github: { owners: [] }, profile: {} }).listTasks();
  expect(tasks).toEqual([
    { id: "PLEN-1", type: "bug", slug: "retry webhooks", branch: "fix/PLEN-1-retry-webhooks", repos: ["platform"], root: join(root, "tasks/PLEN-1"), dirs: { platform: join(root, "tasks/PLEN-1/platform") }, createdAt: "2026-11-10T00:00:00Z", kind: "change", issue: { tracker: "linear", id: "PLEN-1" } },
  ]);
});

test("a review task lists its PRs and title, and has no branch", () => {
  const root = mkdtempSync(join(tmpdir(), "jin-ws-"));
  mkdirSync(join(root, "tasks/REV-111701/platform"), { recursive: true });
  const prs = [{ repo: "platform", number: 12, head: "abc", title: "Retry webhooks", url: "https://github.com/ComposioHQ/platform/pull/12" }];
  writeFileSync(join(root, "tasks/REV-111701/task.json"), JSON.stringify({ id: "REV-111701", kind: "review", type: "review", branch: "", repos: ["platform"], prs, title: "Retry webhooks", created: "2026-11-17T00:00:00Z" }));
  const [t] = new CwsAdapter({ id: "composio", adapter: "cws", root, github: { owners: [] }, profile: {} }).listTasks();
  expect(t).toMatchObject({ id: "REV-111701", kind: "review", type: "review", slug: "Retry webhooks", branch: null, prs });
});
