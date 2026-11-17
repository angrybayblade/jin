import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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

test("finds a cws workspace in the usual places, and only real ones", () => {
  const { setup, ws } = fixture();
  expect(setup.candidates()).toEqual([{ provider: "cws", root: realpathSync(ws), preferred: false }]);
});

test("using a workspace writes its profile and makes it live at once", () => {
  const { setup, ws, jinHome, workspaces, added } = fixture();
  setup.useWorkspace(ws);
  expect(added.map((w) => [w.id, w.adapter, w.root])).toEqual([["composio", "cws", ws]]);
  const yaml = readFileSync(join(jinHome, "workspaces", "composio.yaml"), "utf8");
  expect(yaml).toContain(`root: ${ws}`);
  expect(yaml).toContain("adapter: cws");
  expect(setup.candidates()).toEqual([]);
  expect(() => setup.useWorkspace(ws)).toThrow("jin already uses the workspace");
  expect(workspaces).toHaveLength(1);
});

test("the workspace cws belongs to comes first, wherever it is", () => {
  const { setup, ws } = fixture();
  const home = join(ws, "..", "..");
  const elsewhere = join(home, "projects", "cw");
  mkdirSync(join(elsewhere, "bin"), { recursive: true });
  writeFileSync(join(elsewhere, "workspace.yaml"), "repos: {}\n");
  writeFileSync(join(elsewhere, "bin", "cws"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  symlinkSync(join(elsewhere, "bin", "cws"), join(home, ".local", "bin", "cws"));
  expect(setup.candidates()).toEqual([
    { provider: "cws", root: realpathSync(elsewhere), preferred: true },
    { provider: "cws", root: realpathSync(ws), preferred: false },
  ]);
});

test("refuses a folder that is no kind of workspace jin knows", () => {
  const { setup } = fixture();
  expect(() => setup.useWorkspace("/nonexistent/place")).toThrow("is not a workspace jin can use");
});
