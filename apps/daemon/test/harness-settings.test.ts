import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSettings, editsBetween, JsonSettings, settingsProblems } from "../src/harness-settings";

const dir = (p: string) => mkdtempSync(join(tmpdir(), `jin-${p}-`));

test("edits name only the keys that changed, walking into objects on both sides", () => {
  expect(
    editsBetween(
      { model: "a", keep: 1, compaction: { enabled: true, reserveTokens: 1 }, list: ["x"] },
      { model: "b", keep: 1, compaction: { enabled: true }, list: ["x", "y"], added: { z: 1 } },
    ),
  ).toEqual([
    { path: ["model"], value: "b" },
    { path: ["compaction", "reserveTokens"], value: undefined },
    { path: ["list"], value: ["x", "y"] },
    { path: ["added"], value: { z: 1 } },
  ]);
});

test("pi: a missing file reads as empty; a write creates it", async () => {
  const s = new JsonSettings("pi", [join(dir("pi"), "settings.json")], "json");
  const first = await s.read();
  expect(first).toMatchObject({ agent: "pi", exists: false, settings: {}, hash: "", error: null, format: "json" });
  const after = await s.write({ settings: { defaultThinkingLevel: "high" }, base: first.hash });
  expect(after.settings).toEqual({ defaultThinkingLevel: "high" });
  expect(existsSync(`${s.path}.jin-backup`)).toBe(false);
});

test("opencode: the forms' changes keep the file's comments and other keys; a stale base is refused", async () => {
  const d = dir("opencode");
  const path = join(d, "opencode.jsonc");
  const text = `{\n  // my default\n  "model": "openai/gpt-5",\n  "share": "manual", // never auto\n  "provider": { "x": { "options": {} } }\n}\n`;
  writeFileSync(path, text);
  const s = new JsonSettings("opencode", [path, join(d, "opencode.json")], "jsonc");
  const before = await s.read();
  expect(before.settings).toEqual({ model: "openai/gpt-5", share: "manual", provider: { x: { options: {} } } });
  const after = await s.write({ settings: { ...before.settings, model: "openai/gpt-5.5", instructions: ["~/rules.md"] }, base: before.hash });
  expect(after.text).toContain("// my default");
  expect(after.text).toContain("// never auto");
  expect(after.text).toContain('"model": "openai/gpt-5.5"');
  expect(after.settings).toEqual({ model: "openai/gpt-5.5", share: "manual", provider: { x: { options: {} } }, instructions: ["~/rules.md"] });
  expect(readFileSync(`${path}.jin-backup`, "utf8")).toBe(text);
  expect(s.write({ settings: before.settings, base: before.hash })).rejects.toThrow("changed since you opened it");
});

test("opencode: text replaces the file once it parses; a file that does not parse is shown as text", async () => {
  const d = dir("opencode");
  const path = join(d, "opencode.json");
  writeFileSync(path, '{ "model": ');
  const s = new JsonSettings("opencode", [join(d, "opencode.jsonc"), path], "jsonc");
  const broken = await s.read();
  expect(broken.path).toBe(path);
  expect(broken.settings).toBeNull();
  expect(broken.error).toContain("not valid JSON");
  expect(s.write({ settings: {}, base: broken.hash })).rejects.toThrow("fix the file's text first");
  expect(s.write({ text: '{ "model": "nope" }', base: broken.hash })).rejects.toThrow("provider/model");
  const fixed = await s.write({ text: '{ "model": "openai/gpt-5" } // fixed', base: broken.hash });
  expect(fixed).toMatchObject({ settings: { model: "openai/gpt-5" }, error: null });
  expect(fixed.text).toContain("// fixed");
});

test("the forms' keys are checked per agent", () => {
  expect(settingsProblems("pi", { defaultThinkingLevel: "huge", enabledModels: "x" })).toEqual(["defaultThinkingLevel must be one of off, minimal, low, medium, high, xhigh, max", "enabledModels must be a list of strings"]);
  expect(settingsProblems("codex", { sandbox_mode: "yolo", mcp_servers: { a: { args: [] } } })).toEqual(["sandbox_mode must be one of read-only, workspace-write, danger-full-access", "mcp_servers.a needs a command or a url"]);
  expect(settingsProblems("codex", { approval_policy: { granular: {} } })).toEqual([]);
  expect(settingsProblems("opencode", { permissions: [{ action: "shell", resource: "git push*", effect: "maybe" }], mcp: { servers: { a: { type: "local", command: [] } } } })).toEqual([
    "permissions[0] needs an action, a resource and an effect (allow, ask, deny)",
    "mcp.servers.a needs a command",
  ]);
});

/** A stand-in for Codex's app-server: a version per file content, and batchWrite applied to the parsed TOML. */
function fakeCodex(home: string) {
  const calls: { method: string; params: unknown }[] = [];
  const path = join(home, "config.toml");
  const version = () => `v:${existsSync(path) ? readFileSync(path, "utf8").length : 0}`;
  const server = () => ({
    closed: Promise.resolve(),
    initialize: async () => {},
    close: () => {},
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "config/read") return { layers: [{ name: { type: "user" }, version: version() }] };
      const p = params as { expectedVersion: string; edits: { keyPath: string; value: unknown }[] };
      if (p.expectedVersion !== version()) throw new Error("Configuration was modified since last read. Fetch latest version and retry.");
      writeFileSync(path, `${readFileSync(path, "utf8")}# edited\n`);
      return { status: "ok" };
    },
  });
  return { calls, server };
}

test("codex: the forms' changes go to Codex as edits of just those keys, quoted where Codex needs it", async () => {
  const home = dir("codex");
  writeFileSync(join(home, "config.toml"), `# mine\nmodel = "gpt-5"\nmodel_reasoning_effort = "high"\n\n[projects."/Users/me/x"]\ntrust_level = "trusted"\n`);
  const fake = fakeCodex(home);
  const s = new CodexSettings(home, fake.server as never);
  const before = await s.read();
  expect(before).toMatchObject({ agent: "codex", format: "toml", hash: "v:105", error: null });
  const next = { ...before.settings!, model: "gpt-5.5", projects: { "/Users/me/x": { trust_level: "untrusted" } } } as Record<string, unknown>;
  delete next.model_reasoning_effort;
  await s.write({ settings: next, base: before.hash });
  expect(fake.calls.find((c) => c.method === "config/batchWrite")?.params).toEqual({
    expectedVersion: "v:105",
    edits: [
      { keyPath: "model", mergeStrategy: "replace", value: "gpt-5.5" },
      { keyPath: "model_reasoning_effort", mergeStrategy: "replace", value: null },
      { keyPath: 'projects."/Users/me/x".trust_level', mergeStrategy: "replace", value: "untrusted" },
    ],
  });
  expect(readFileSync(join(home, "config.toml.jin-backup"), "utf8")).toStartWith("# mine\n");
  // Codex's own version check: the file changed since.
  expect(s.write({ settings: next, base: before.hash })).rejects.toThrow("changed since you opened it");
});

test("codex: text is checked as TOML and written over the file; without Codex's version, the file's own stands in", async () => {
  const home = dir("codex");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), "model = ");
  const broken = () => ({ closed: Promise.resolve(), initialize: async () => {}, close: () => {}, request: async () => Promise.reject(new Error("bad config")) });
  const s = new CodexSettings(home, broken as never);
  const r = await s.read();
  expect(r.settings).toBeNull();
  expect(r.error).toContain("not valid TOML");
  expect(r.hash).toStartWith("file:");
  expect(s.write({ text: "model = [", base: r.hash })).rejects.toThrow("not valid TOML");
  const fixed = await s.write({ text: 'model = "gpt-5.5"\n', base: r.hash });
  expect(fixed.settings).toEqual({ model: "gpt-5.5" });
});
