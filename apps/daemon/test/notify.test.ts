import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { chatPath, lastAssistantText, type Notice, Notifier, plain } from "../src/notify";

const home = mkdtempSync(join(tmpdir(), "jin-notify-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const config = (mode: "local" | "vm" = "local") => ({ home, mode, webOrigin: "http://127.0.0.1:3917" }) as Config;
const notice = (over: Partial<Notice> = {}): Notice => ({ key: "k", title: "jin", body: "done", path: "/", chat: "c1", ...over });

test("a finished turn notifies once, unless that chat is on screen", () => {
  const sent: Notice[] = [];
  const n = new Notifier(config(), (x) => sent.push(x));
  n.update({ enabled: true, sound: true });
  expect(n.notify(notice(), 1000)).toBeNull();
  expect(n.notify(notice(), 2000)).toBe("repeat");
  // Looking at that chat: skipped. Looking at another chat or tab, or unfocused: sent.
  n.presence = { path: "/", chat: "c1", terminal: null, focused: true, at: 10_000 };
  expect(n.notify(notice({ key: "a" }), 10_500)).toBe("on screen");
  expect(n.notify(notice({ key: "b", chat: "c2" }), 10_500)).toBeNull();
  n.presence = { path: "/t/P-1", chat: null, terminal: "t1", focused: true, at: 10_000 };
  expect(n.notify(notice({ key: "c", path: "/t/P-1", chat: undefined, terminal: "t2" }), 10_500)).toBeNull();
  expect(n.notify(notice({ key: "d", path: "/t/P-1", chat: undefined, terminal: "t1" }), 10_500)).toBe("on screen");
  n.presence = { path: "/", chat: "c1", terminal: null, focused: false, at: 10_000 };
  expect(n.notify(notice({ key: "e" }), 10_500)).toBeNull();
  // A stale report (window closed without saying so) does not hide notifications.
  n.presence = { path: "/", chat: "c1", terminal: null, focused: true, at: 10_000 };
  expect(n.notify(notice({ key: "f" }), 60_000)).toBeNull();
  expect(sent.map((s) => s.key)).toEqual(["k", "b", "c", "e", "f"]);
});

test("notifications can be turned off, and stay off on an always-on VM", () => {
  const sent: Notice[] = [];
  const n = new Notifier(config(), (x) => sent.push(x));
  expect(n.update({ enabled: false }).enabled).toBe(false);
  expect(new Notifier(config(), () => {}).settings.enabled).toBe(false); // saved
  expect(n.notify(notice({ key: "x" }))).toBe("off");
  n.update({ enabled: true });
  expect(new Notifier(config("vm"), (x) => sent.push(x)).notify(notice({ key: "y" }))).toBe("not in local mode");
  expect(sent).toHaveLength(0);
});

test("previews are one plain line", () => {
  expect(plain("**Cleaned** the `cache`:\n\n- 9 GB → 1 GB\n```sh\nrm -rf x\n```\n[docs](https://x.y)")).toBe("Cleaned the cache: - 9 GB → 1 GB docs");
  expect(plain("x".repeat(300)).length).toBe(160);
  expect(chatPath({ kind: "jin", taskId: null })).toBe("/");
  expect(chatPath({ kind: "slack", taskId: null })).toBe("/c/slack");
  expect(chatPath({ kind: "task", taskId: "PLEN-1" })).toBe("/t/PLEN-1");
});

test("Claude Code's last words come from the hook input or its transcript", () => {
  expect(lastAssistantText({ last_assistant_message: "All tests pass." })).toBe("All tests pass.");
  const file = join(home, "t.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "user", message: { content: "fix it" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Fixed the retry loop." }, { type: "tool_use", name: "Bash" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
  ].join("\n"));
  expect(lastAssistantText({ transcript_path: file })).toBe("Fixed the retry loop.");
  expect(lastAssistantText({ transcript_path: join(home, "missing.jsonl") })).toBe("");
});
