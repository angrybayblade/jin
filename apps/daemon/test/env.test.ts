import { expect, test } from "bun:test";
import { dropInheritedClaudeSession } from "../src/env";

test("drops a parent Claude Code session's variables and keeps user configuration", () => {
  const env: Record<string, string | undefined> = {
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_MESSAGING_TOKEN: "secret",
    CLAUDE_CODE_SESSION_ID: "abc",
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_MODEL: "x",
    PATH: "/bin",
  };
  expect(dropInheritedClaudeSession(env).sort()).toEqual(["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ID"]);
  expect(env).toEqual({ CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_MODEL: "x", PATH: "/bin" });
});
