import { expect, test } from "bun:test";
import { parseGitmodules } from "../src/adapters/composio";

test("parses submodule paths, urls and branches", () => {
  const gm = parseGitmodules('[submodule "repos/platform"]\n\tpath = repos/platform\n\turl = git@github.com:ComposioHQ/platform.git\n\tbranch = master\n[submodule "repos/x"]\n\tpath = repos/x\n');
  expect(gm.get("repos/platform")).toEqual({ path: "repos/platform", url: "git@github.com:ComposioHQ/platform.git", branch: "master" });
  expect(gm.get("repos/x")).toEqual({ path: "repos/x" });
});
