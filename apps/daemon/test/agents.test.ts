import { expect, test } from "bun:test";
import { answer, codexCalls, patchFiles } from "../src/agent-hooks";
import { Agents, type AgentLaunch } from "../src/agents";
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
  const stub = (id: "claude" | "codex" | "pi", label: string): AgentLaunch => ({ id, label, bin: id, canFork: id === "claude", argv: () => [id], env: () => ({}), hasSession: () => false });
  const installed = new Set(["claude"]);
  const agents = new Agents(db, { claude: stub("claude", "Claude Code"), codex: stub("codex", "Codex"), pi: stub("pi", "pi") }, async (bin) => installed.has(bin));
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
