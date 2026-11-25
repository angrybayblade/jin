import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { chatPath, lastAssistantText, type Notice, Notifier, plain, clickTarget } from "../src/notify";

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

test("notifications can be turned off; a machine without a desktop keeps them for relay", () => {
  const sent: Notice[] = [];
  const n = new Notifier(config(), (x) => sent.push(x));
  expect(n.update({ enabled: false }).enabled).toBe(false);
  expect(new Notifier(config(), () => {}).settings.enabled).toBe(false); // saved
  expect(n.notify(notice({ key: "x" }))).toBe("off");
  n.update({ enabled: true });
  const vm = new Notifier(config("vm"), (x) => sent.push(x));
  expect(vm.since(-1)).toEqual({ seq: 0, notices: [] });
  expect(vm.notify(notice({ key: "y" }))).toBe("kept for relay");
  expect(vm.notify(notice({ key: "y" }))).toBe("repeat");
  expect(vm.notify(notice({ key: "z" }))).toBe("kept for relay");
  expect(sent).toHaveLength(0); // nothing shown on the machine itself
  expect(vm.since(0).notices.map((x) => [x.seq, x.key])).toEqual([[1, "y"], [2, "z"]]);
  expect(vm.since(1).notices.map((x) => x.key)).toEqual(["z"]);
  expect(vm.since(-1)).toEqual({ seq: 2, notices: [] }); // a fresh relay skips the backlog
});

test("previews are one plain line", () => {
  expect(plain("**Cleaned** the `cache`:\n\n- 9 GB → 1 GB\n```sh\nrm -rf x\n```\n[docs](https://x.y)")).toBe("Cleaned the cache: - 9 GB → 1 GB docs");
  expect(plain("x".repeat(300)).length).toBe(160);
  expect(chatPath({ kind: "jin", taskId: null })).toBe("/");
  expect(chatPath({ kind: "desk", taskId: null })).toBe("/desk");
  expect(chatPath({ kind: "slack", taskId: null })).toBe("/desk");
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

test("a click opens the place in jin's window when the app is installed, else in the browser", () => {
  const here = [import.meta.dir]; // a path that exists, standing in for jin.app
  expect(clickTarget({ path: "/t/PLEN-1" }, "http://127.0.0.1:3917", here)).toBe("jin://open?path=%2Ft%2FPLEN-1");
  expect(clickTarget({ path: "/", chat: "c1" }, "http://127.0.0.1:3917", here)).toBe(`jin://open?path=${encodeURIComponent("/?chat=c1")}`);
  expect(clickTarget({ path: "/c/slack" }, "http://127.0.0.1:3917", ["/nowhere/jin.app"])).toBe("http://127.0.0.1:3917/c/slack");
  // A Claude Code turn opens its own tab; something that happened elsewhere opens there.
  expect(clickTarget({ path: "/t/P-1", terminal: "t9" }, "http://127.0.0.1:3917", here)).toBe(`jin://open?path=${encodeURIComponent("/t/P-1?terminal=t9")}`);
  expect(clickTarget({ path: "/c/github", url: "https://github.com/o/r/pull/1#issuecomment-2" }, "http://127.0.0.1:3917", here)).toBe("https://github.com/o/r/pull/1#issuecomment-2");
});

test("live events notify by the kinds chosen per app; defaults leave out automated mail; a choice of kinds that no longer exist falls back to the defaults", async () => {
  const { liveNotifies } = await import("../src/notify");
  const base = { enabled: true, sound: true };
  const gh = (tags: string[]) => ({ toolkit: "github", tags, forYou: true });
  expect(liveNotifies(base, gh(["authored"]))).toBe(true);
  expect(liveNotifies(base, gh(["team-review", "mentioned"]))).toBe(true);
  expect(liveNotifies(base, { toolkit: "slack", tags: ["thread"], forYou: true })).toBe(true);
  expect(liveNotifies(base, { toolkit: "slack", tags: ["linked"], forYou: false })).toBe(false);
  expect(liveNotifies({ ...base, sources: { notion: ["comment"] } }, { toolkit: "notion", tags: ["discussion"], forYou: true })).toBe(true);
  expect(liveNotifies({ ...base, sources: { notion: ["mine"] } }, { toolkit: "notion", tags: ["discussion"], forYou: true })).toBe(false);
  expect(liveNotifies({ ...base, sources: { github: ["authored"] } }, gh(["reviewer"]))).toBe(false);
  expect(liveNotifies({ ...base, sources: { github: [] } }, gh(["authored"]))).toBe(false);
  expect(liveNotifies(base, { toolkit: "gmail", tags: ["automated"], forYou: false })).toBe(false);
  expect(liveNotifies(base, { toolkit: "other", forYou: true })).toBe(true);
});
