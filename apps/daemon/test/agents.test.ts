import { expect, test } from "bun:test";
import { answer, codexCalls, patchFiles } from "../src/agent-hooks";
import { Agents, majors, versionOf, type AgentLaunch } from "../src/agents";
import { codexHookFlags } from "../src/codex-cli";
import { openDb } from "../src/db";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PATCH = ["*** Begin Patch", "*** Add File: notes.md", "+hi", "*** Update File: src/a.ts", "@@", "-x", "+y", "*** Move to: src/b.ts", "*** Delete File: /abs/old.ts", "*** End Patch"].join("\n");

test("an apply_patch call is an edit of each file it adds, changes, moves to or deletes", () => {
  expect(patchFiles(PATCH, "/task")).toEqual(["/task/notes.md", "/task/src/a.ts", "/task/src/b.ts", "/abs/old.ts"]);
  expect(codexCalls("apply_patch", { command: PATCH }, "/task").map((c) => [c.tool, c.input.file_path])).toEqual([
    ["Edit", "/task/notes.md"],
    ["Edit", "/task/src/a.ts"],
    ["Edit", "/task/src/b.ts"],
    ["Edit", "/abs/old.ts"],
  ]);
  expect(codexCalls("Bash", { command: "ls" })).toEqual([{ tool: "Bash", input: { command: "ls" } }]);
});

test("jin's ask: Claude Code prompts; Codex leaves shell commands to its sandbox and blocks other tools", () => {
  const ask = { decision: "ask" as const, reason: "pushes to a remote" };
  expect(answer("claude", "Bash", ask)).toEqual({ decision: "ask", reason: "pushes to a remote" });
  expect(answer("codex", "Bash", ask)).toEqual({});
  expect(answer("codex", "mcp__slack__send_message", ask).decision).toBe("deny");
  expect(answer("codex", "Bash", { decision: "deny", reason: "deploys" })).toEqual({ decision: "deny", reason: "deploys" });
  expect(answer("codex", "Bash", { decision: "allow", reason: "" })).toEqual({});
});

test("jin's Codex hooks are the same flags on every launch (Codex trusts them by their text)", () => {
  const a = codexHookFlags("/bin/bun", "/jin/codex-hook.ts");
  expect(a).toEqual(codexHookFlags("/bin/bun", "/jin/codex-hook.ts"));
  const pre = a.find((f) => f.startsWith("hooks.PreToolUse="))!;
  expect(pre).toBe('hooks.PreToolUse=[{matcher="*", hooks=[{type="command", command="\\"/bin/bun\\" \\"/jin/codex-hook.ts\\" PreToolUse", timeout=30}]}]');
  expect(a.filter((f) => f !== "-c").map((f) => f.split("=")[0])).toEqual(["hooks.PreToolUse", "hooks.PostToolUse", "hooks.PermissionRequest", "hooks.SessionStart", "hooks.UserPromptSubmit", "hooks.Stop"]);
});

test("a machine's default agent: Claude Code until set, only an installed one, and new tabs need theirs installed", async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "jin-agents-")));
  const stub = (id: "claude" | "codex" | "pi" | "opencode", label: string): AgentLaunch => ({ id, label, bin: id, canFork: id === "claude", argv: () => [id], env: () => ({}), hasSession: () => false });
  const installed = new Set(["claude"]);
  const agents = new Agents(db, { claude: stub("claude", "Claude Code"), codex: stub("codex", "Codex"), pi: stub("pi", "pi"), opencode: stub("opencode", "opencode") }, async (bin) => ({ installed: installed.has(bin), version: "1.0.0" }));
  expect(agents.defaultId()).toBe("claude");
  await expect(agents.setDefault("codex")).rejects.toThrow("not installed");
  await expect(agents.pick("codex")).rejects.toThrow("not installed");
  expect(() => agents.launch("cursor")).toThrow("agent must be one of");
  installed.add("codex");
  expect(await agents.setDefault("codex")).toBe("codex");
  expect(agents.defaultId()).toBe("codex");
  expect((await agents.pick()).id).toBe("codex");
  expect((await agents.pick("claude")).id).toBe("claude");
});

test("an agent at a version jin has not checked is refused: as the default, and for a new tab or chat", async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "jin-agents-v-")));
  const versions: Record<string, string | null> = { claude: "2.0.0", codex: "0.169.0", pi: "1.5.2", opencode: "2.3.0" };
  const stub = (id: "claude" | "codex" | "pi" | "opencode", supports?: (v: string | null) => string | null): AgentLaunch => ({ id, label: id, bin: id, canFork: false, argv: () => [id], env: () => ({}), hasSession: () => false, supports });
  const agents = new Agents(
    db,
    { claude: stub("claude"), codex: stub("codex"), pi: stub("pi", majors("pi", [1], "")), opencode: stub("opencode", majors("opencode", [1], "Its plugins changed.")) },
    async (bin) => ({ installed: true, version: versions[bin] ?? null }),
  );
  const list = await agents.list();
  expect(list.find((a) => a.id === "pi")).toMatchObject({ version: "1.5.2", problem: null });
  expect(list.find((a) => a.id === "opencode")).toMatchObject({ version: "2.3.0", problem: "jin supports opencode 1.x; this machine has 2.3.0. Its plugins changed." });
  await expect(agents.setDefault("opencode")).rejects.toThrow("jin supports opencode 1.x");
  await expect(agents.pick("opencode")).rejects.toThrow("this machine has 2.3.0");
  expect((await agents.pick("pi")).id).toBe("pi");
  expect(majors("pi", [1], "")(null)).toContain("could not read pi's version");
  expect(versionOf("opencode v2.3.0\n")).toBe("2.3.0");
  expect(versionOf("codex-cli 0.169.0")).toBe("0.169.0");
});
