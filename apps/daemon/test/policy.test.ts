import { describe, expect, test } from "bun:test";
import { evaluate, simpleCommands } from "../src/policy";

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
