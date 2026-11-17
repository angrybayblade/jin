import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FiredEvent, hookPrompt, Hooks, matches } from "../src/hooks";
import type { Notice } from "../src/notify";

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), "jin-hooks-"));
  const chats: { title: string; prompt: string }[] = [];
  const notices: Notice[] = [];
  const hooks = new Hooks(home, { startChat: async (title, prompt) => (chats.push({ title, prompt }), { id: `chat-${chats.length}` }), notify: (n) => notices.push(n) });
  return { home, hooks, chats, notices };
};

const merged = (id: string): FiredEvent => ({ event: "task.merged", key: id, payload: { task: { id, title: "Fix limiter" }, prs: [{ url: "https://github.com/o/r/pull/1", state: "MERGED" }] }, machine: "viraj-mac" });

test("filters: exact (any case), patterns, nested fields; a missing field never matches", () => {
  const p = { toolkit: "slack", forYou: true, thread: { ref: "PLEN-12" } };
  expect(matches({}, p)).toBe(true);
  expect(matches({ toolkit: "Slack", forYou: "true" }, p)).toBe(true);
  expect(matches({ "thread.ref": "/^plen-/" }, p)).toBe(true);
  expect(matches({ toolkit: "linear" }, p)).toBe(false);
  expect(matches({ actor: "alex" }, p)).toBe(false);
});

test("a new home starts with the merge clean-up hook, kept on disk", () => {
  const { home, hooks } = setup();
  expect(hooks.list().map((h) => [h.name, h.event, h.enabled])).toEqual([["Clean up after a merge", "task.merged", true]]);
  expect(JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"))).toHaveLength(1);
});

test("an event runs each matching hook once, with its instructions and the event, and notifies with the chat", async () => {
  const { hooks, chats, notices } = setup();
  const runs = await hooks.fire(merged("PLEN-1"));
  expect(runs).toHaveLength(1);
  expect(chats[0]!.title).toBe("Clean up after a merge: PLEN-1");
  expect(chats[0]!.prompt).toContain("jin_archive_task");
  expect(chats[0]!.prompt).toContain('pass machine: "viraj-mac"');
  expect(chats[0]!.prompt).toContain('"id": "PLEN-1"');
  expect(notices[0]).toMatchObject({ title: "Clean up after a merge", subtitle: "PLEN-1", chat: "chat-1", path: "/" });
  // The same occurrence again: nothing new.
  expect(await hooks.fire(merged("PLEN-1"))).toEqual([]);
  expect(chats).toHaveLength(1);
});

test("hooks you add: validated, filtered, and off means off", async () => {
  const { hooks, chats } = setup();
  expect(() => hooks.save({ name: "x", event: "nope" as never, instructions: "y" })).toThrow("event must be one of");
  expect(() => hooks.save({ name: "", event: "live.event", instructions: "y" })).toThrow("needs a name");
  const dm = hooks.save({ name: "Triage DMs", event: "live.event", filter: { toolkit: "slack" }, instructions: "Summarise it." }, "jin");
  expect(dm.createdBy).toBe("jin");
  await hooks.fire({ event: "live.event", key: "e1", payload: { toolkit: "gmail" }, machine: null });
  expect(chats).toHaveLength(0);
  await hooks.fire({ event: "live.event", key: "e2", payload: { toolkit: "slack", title: "DM" }, machine: null });
  expect(chats.map((c) => c.title)).toEqual(["Triage DMs: DM"]);
  hooks.save({ id: dm.id, enabled: false });
  await hooks.fire({ event: "live.event", key: "e3", payload: { toolkit: "slack" }, machine: null });
  expect(chats).toHaveLength(1);
});

test("the prompt says where the event happened", () => {
  const h = { name: "n", instructions: "do it", event: "pr.merged" as const };
  expect(hookPrompt(h, { event: "pr.merged", key: "k", payload: {}, machine: null })).toContain("It happened on this machine.");
});
