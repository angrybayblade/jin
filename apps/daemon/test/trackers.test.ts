import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkspaces } from "../src/config";
import { Trackers } from "../src/trackers";

test("Linear: ids in any case, its pages, and a link once it has seen its workspace", () => {
  const t = new Trackers().get("linear")!;
  expect(t.parseId("plen-12")).toBe("PLEN-12");
  expect(t.parseId("platform#12")).toBeNull();
  expect(t.parseUrl(new URL("https://linear.app/acme/issue/eng-9/title"))).toBe("ENG-9");
  expect(t.urlOf("ENG-9")).toBeNull();
  t.learn!("https://linear.app/acme/issue/ENG-1/x");
  expect(t.urlOf("ENG-9")).toBe("https://linear.app/acme/issue/ENG-9");
});

test("GitHub Issues: repo#n within the workspace's owner, owner/repo#n, and issue pages (not PRs)", () => {
  const trackers = new Trackers({ owners: () => ["Acme"] });
  const t = trackers.get("github")!;
  expect(t.parseId("api#7")).toBe("acme/api#7");
  expect(t.parseId("other/api#7")).toBe("other/api#7");
  expect(t.parseId("ENG-7")).toBeNull();
  expect(t.parseUrl(new URL("https://github.com/acme/api/issues/7"))).toBe("acme/api#7");
  expect(t.parseUrl(new URL("https://github.com/acme/api/pull/7"))).toBeNull();
  expect(t.urlOf("acme/api#7")).toBe("https://github.com/acme/api/issues/7");
  expect(t.howToRead("acme/api#7")).toContain("gh issue view 7 -R acme/api");
  expect(trackers.ofKey("github:acme/api#7")).toMatchObject({ tracker: { id: "github" }, id: "acme/api#7" });
  expect(trackers.get("none")).toBeNull();
});

test("a workspace's tracker: as configured, else its provider's default; an unknown one is refused", () => {
  const home = mkdtempSync(join(tmpdir(), "jin-trackers-"));
  mkdirSync(join(home, "workspaces"));
  const ws = (id: string, extra: string) => writeFileSync(join(home, "workspaces", `${id}.yaml`), `id: ${id}\nadapter: ${id.startsWith("c") ? "cws" : "git"}\nroot: /nowhere\ngithub:\n  owners: [acme]\n${extra}`);
  ws("cws-default", "");
  ws("cws-github", "tracker: github\n");
  ws("cws-none", "tracker: none\n");
  ws("git-default", "");
  expect(Object.fromEntries(loadWorkspaces(home).map((w) => [w.id, w.tracker]))).toEqual({ "cws-default": "linear", "cws-github": "github", "cws-none": null, "git-default": null });
  ws("x-bad", "tracker: jira\n");
  expect(() => loadWorkspaces(home)).toThrow("tracker must be one of linear, github, none");
});
