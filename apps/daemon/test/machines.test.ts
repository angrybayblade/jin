import { expect, test } from "bun:test";
import { readDetections } from "../src/adapters";
import { describeTool, machineId, readAuthStatus, readSignIn, signInCommand, stripAnsi, validHost } from "../src/machines";

test("a machine's id comes from its host, and never collides", () => {
  expect(machineId("tmp-jin.exe.xyz")).toBe("tmp-jin");
  expect(machineId("me@Dev_Box.example.com")).toBe("dev-box");
  expect(machineId("tmp-jin.exe.xyz", new Set(["tmp-jin"]))).toBe("tmp-jin-2");
  expect(machineId("local")).toBe("local-2");
});

test("only host names reach ssh, never options", () => {
  for (const ok of ["tmp-jin.exe.xyz", "me@10.0.0.4", "devbox"]) expect(validHost(ok)).toBe(true);
  for (const bad of ["-oProxyCommand=sh", "a b", "host;rm", "", "user@-x"]) expect(validHost(bad)).toBe(false);
});

test("reads gh's device code, answers its prompts once, and sees it finish", () => {
  let out = "? Authenticate Git with your GitHub credentials? (Y/n) ";
  expect(readSignIn("gh", out).answer).toEqual({ prompt: "git", keys: "Y\r" });
  out += "Yes\n! First copy your one-time code: DD66-018E\nPress Enter to open https://github.com/login/device in your browser... ";
  const r = readSignIn("gh", out);
  expect(r).toMatchObject({ url: "https://github.com/login/device", code: "DD66-018E", answer: { prompt: "enter", keys: "\r" }, done: false });
  expect(readSignIn("gh", `${out}\n\x1b[32m✓\x1b[0m Logged in as angrybayblade\n`)).toMatchObject({ done: true, account: "angrybayblade" });
});

test("reads Claude Code's sign-in link and waits for the code it gives back", () => {
  const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc";
  const r = readSignIn("claude", `Opening browser to sign in…\r\nIf the browser didn't open, visit: ${url}\r\nPaste code here if prompted > `);
  expect(r).toMatchObject({ url, needsCode: true, done: false });
  expect(readSignIn("claude", `visit: ${url}\nPaste code here if prompted > Login successful.\n`)).toMatchObject({ needsCode: false, done: true });
});

test("reads Doppler's auth code and declines to open a browser", () => {
  const r = readSignIn("doppler", "? Open the authorization page in your browser? (Y/n) No\nComplete authorization at https://dashboard.doppler.com/workplace/auth/cli\nYour auth code is:\nworm_dingo_strawberry_leopard_spokane\nWaiting...");
  expect(r).toMatchObject({ url: "https://dashboard.doppler.com/workplace/auth/cli", code: "worm_dingo_strawberry_leopard_spokane", answer: { prompt: "open", keys: "n\r" } });
});

test("reads who is signed in from the status probe", () => {
  expect(readAuthStatus("gh yes angrybayblade\nclaude no\ndoppler missing\n")).toEqual({
    gh: { state: "signed-in", account: "angrybayblade" },
    claude: { state: "signed-out", account: null },
    doppler: { state: "missing", account: null },
  });
  expect(stripAnsi("\x1b[1mhi\x1b[0m\r")).toBe("hi");
});

test("reads the workspaces found on a machine, and the ones jin there uses", () => {
  const out = [
    "cws FOUND 11 /home/me/composio-workspace",
    "cws PREFERRED 12 /home/me/Workspace/composio-workspace",
    "cws FOUND 12 /home/me/workspace/composio-workspace", // the same folder, another spelling
    "git FOUND 13 /home/me/src/app",
    "cws USING 0 /home/me/composio-workspace",
    "noise",
  ].join("\n");
  expect(readDetections(out)).toEqual({
    found: [
      { provider: "cws", root: "/home/me/Workspace/composio-workspace", preferred: true }, // the tooling's own first
      { provider: "cws", root: "/home/me/composio-workspace", preferred: false },
      { provider: "git", root: "/home/me/src/app", preferred: false },
    ],
    using: ["/home/me/composio-workspace"],
  });
  expect(readDetections("")).toEqual({ found: [], using: [] });
});

test("a machine removed while its tunnel opens stays gone, and its health check never throws", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Machines } = await import("../src/machines");
  const home = mkdtempSync(join(tmpdir(), "jin-mach-"));
  mkdirSync(join(home, "machines"));
  const record = { id: "gone", host: "gone.example", label: "gone", remotePort: 7317, localPort: null, token: "t", createdAt: new Date().toISOString(), version: null, workspace: null, system: null };
  const file = join(home, "machines", "gone.json");
  writeFileSync(file, JSON.stringify(record));
  const spawned: string[][] = [];
  const never = new Promise<number>(() => {});
  const spawn = ((cmd: string[]) => (spawned.push(cmd), { exited: never, kill() {}, stdout: new ReadableStream(), stderr: new ReadableStream() })) as never;
  const m = new Machines({ home } as never, [], spawn);
  // Removed while the tunnel looks for a free port: no ssh starts afterwards.
  const opening = m.openTunnel("gone");
  await m.remove("gone");
  await opening;
  expect(spawned).toEqual([]);
  // Open, then its record vanishes behind jin's back: the next health check drops the line.
  writeFileSync(file, JSON.stringify(record));
  await m.openTunnel("gone");
  rmSync(file);
  await (m as unknown as { probe(id: string): Promise<void> }).probe("gone");
  expect((m as unknown as { tunnels: Map<string, unknown> }).tunnels.size).toBe(0);
  m.closeTunnel("gone");
  rmSync(home, { recursive: true, force: true });
});

test("Codex signs in with a device code: the link and the code are read from what it prints", () => {
  const out = [
    "Welcome to Codex [v0.169.0]",
    "Follow these steps to sign in with ChatGPT using device code authorization:",
    "1. Open this link in your browser and sign in to your account",
    "   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m",
    "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m",
    "   \x1b[94mYWG8-DC4LF\x1b[0m",
  ].join("\n");
  expect(readSignIn("codex", out)).toMatchObject({ url: "https://auth.openai.com/codex/device", code: "YWG8-DC4LF", done: false });
  expect(readSignIn("codex", `${out}\nSuccessfully logged in\n`).done).toBe(true);
  expect(readAuthStatus("gh yes a\ncodex yes ChatGPT\n").codex).toEqual({ state: "signed-in", account: "ChatGPT" });
  expect(readAuthStatus("codex no\n").codex).toEqual({ state: "signed-out", account: null });
});

test("opencode signs in with ChatGPT's device code; pi and opencode report the providers they hold credentials for", () => {
  expect(signInCommand("opencode")).toBe("opencode providers login -p openai -m 'ChatGPT Pro/Plus (headless)'");
  const out = ["┌  Add credential", "│", "●  Go to: \x1b[36mhttps://auth.openai.com/codex/device\x1b[0m", "│", "●  Enter code: Z6OG-6058V", "│", "◒  Waiting for authorization"].join("\n");
  expect(readSignIn("opencode", out)).toMatchObject({ url: "https://auth.openai.com/codex/device", code: "Z6OG-6058V", done: false });
  expect(readAuthStatus("pi yes openai-codex, anthropic\nopencode no\n")).toMatchObject({
    pi: { state: "signed-in", account: "openai-codex, anthropic" },
    opencode: { state: "signed-out", account: null },
  });
  expect(describeTool("opencode")).toMatchObject({ providers: true, optional: true });
  // pi signs in only in its own terminal: the list says how, and offers no sign-in.
  expect(describeTool("pi")).toMatchObject({ providers: true, signInHint: expect.stringContaining("/login") });
});
