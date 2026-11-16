import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, WorkspaceConfig } from "../src/config";
import { LocalSetup } from "../src/setup";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "jin-setup-"));
  const home = join(base, "user");
  const jinHome = join(base, "jin");
  const ws = join(home, "Workspace", "composio-workspace");
  mkdirSync(join(ws, "bin"), { recursive: true });
  writeFileSync(join(ws, "workspace.yaml"), "repos: {}\n");
  writeFileSync(join(ws, "bin", "cws"), "#!/bin/sh\n");
  mkdirSync(join(home, "composio-workspace"), { recursive: true }); // not a workspace: no workspace.yaml
  const config = { home: jinHome } as Config;
  const workspaces: WorkspaceConfig[] = [];
  const added: WorkspaceConfig[] = [];
  const setup = new LocalSetup(config, workspaces, (w) => (workspaces.push(w), added.push(w)), undefined, home);
  return { setup, ws, jinHome, workspaces, added };
}

test("finds a composio workspace in the usual places, and only real ones", () => {
  const { setup, ws } = fixture();
  expect(setup.candidates()).toEqual([ws]);
});

test("using a workspace writes its profile and makes it live at once", () => {
  const { setup, ws, jinHome, workspaces, added } = fixture();
  setup.useWorkspace(ws);
  expect(added.map((w) => [w.id, w.root])).toEqual([["composio", ws]]);
  expect(readFileSync(join(jinHome, "workspaces", "composio.yaml"), "utf8")).toContain(`root: ${ws}`);
  expect(setup.candidates()).toEqual([]);
  expect(() => setup.useWorkspace(ws)).toThrow("already has a composio workspace");
  expect(workspaces).toHaveLength(1);
});

test("refuses a folder that is not a composio workspace", () => {
  const { setup } = fixture();
  expect(() => setup.useWorkspace("/nonexistent/place")).toThrow("no composio workspace");
});
