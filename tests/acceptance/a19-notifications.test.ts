// A19: finished chat turns and task setups notify; what is on screen does not.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scripted, setupEnv, startDaemon, until, type Daemon, type TestEnv } from "./helpers";

let env: TestEnv;
let d: Daemon;
const log = () => (existsSync(join(env.home, "notifications.log")) ? readFileSync(join(env.home, "notifications.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeAll(async () => {
  env = setupEnv();
  d = await startDaemon(env);
});
afterAll(async () => {
  await d.stop();
  env.cleanup();
});

test("A19 a finished chat turn notifies with its answer, unless you are watching that chat", async () => {
  const c = await d.json("/api/chats", { method: "POST", json: { kind: "jin", prompt: scripted([{ text: "Here is **your** catch-up." }]) } });
  await until(() => log().length === 1, 15000, "notification");
  expect(log()[0]).toMatchObject({ title: "jin", body: "Here is your catch-up.", path: "/", chat: c.id, sound: true });

  // Watching that chat: the next turn is not announced.
  await d.json("/api/presence", { method: "POST", json: { path: "/", chat: c.id, focused: true } });
  await d.json(`/api/sessions/${c.id}/messages`, { method: "POST", json: { prompt: scripted([{ text: "more" }]) } });
  await until(async () => (await d.json(`/api/sessions/${c.id}`)).state === "idle", 15000, "turn");
  await Bun.sleep(300);
  expect(log()).toHaveLength(1);

  // Turned off: nothing; a desk's turn is labelled with the desk.
  await d.json("/api/presence", { method: "POST", json: { path: "/", focused: false } });
  await d.json("/api/notifications", { method: "PATCH", json: { enabled: false } });
  const off = await d.json("/api/chats", { method: "POST", json: { kind: "jin", prompt: scripted([{ text: "quiet" }]) } });
  await until(async () => (await d.json(`/api/sessions/${off.id}`)).state === "idle", 15000, "turn");
  await d.json("/api/notifications", { method: "PATCH", json: { enabled: true, sound: false } });
  await d.json("/api/chats", { method: "POST", json: { kind: "slack", prompt: scripted([{ text: "2 threads need you" }]) } });
  await until(() => log().length === 2, 15000, "desk notification");
  expect(log()[1]).toMatchObject({ title: "Slack", body: "2 threads need you", path: "/c/slack", sound: false });
});

test("A19 a task setup notifies when it is ready", async () => {
  await d.json("/api/task-jobs", { method: "POST", json: { id: "N-1", repos: ["platform"], slug: "notify me" } });
  await until(() => log().some((n) => n.title === "N-1 is ready"), 20000, "setup notification");
  expect(log().find((n) => n.title === "N-1 is ready")).toMatchObject({ subtitle: "notify me", path: "/t/N-1" });
});
