import { expect, test } from "bun:test";
import { HttpError, json, Router } from "../src/http";
import { viewRoutes } from "../src/views";

// The routes a view composes, stood in for: each call is counted.
function app() {
  const calls: string[] = [];
  const r = new Router();
  const sessions = [{ id: "s2" }, { id: "s1" }];
  const seen = (url: URL) => calls.push(url.pathname + url.search);
  r.on("GET", "/api/sessions", (_q, _p, u) => (seen(u), json(u.searchParams.get("kind") === "desk" ? [{ id: "d1" }] : sessions)))
    .on("GET", "/api/approvals", (_q, _p, u) => (seen(u), json([{ id: "a1" }])))
    .on("GET", "/api/feed", (_q, _p, u) => (seen(u), json([{ id: "f1", state: u.searchParams.get("state") }])))
    .on("GET", "/api/sessions/:id", (_q, p, u) => (seen(u), json({ id: p.id })))
    .on("GET", "/api/sessions/:id/events", (_q, p, u) => (seen(u), json([{ seq: 1, of: p.id }])))
    .on("GET", "/api/docs/:id", (_q, p, u) => {
      seen(u);
      if (p.id === "dmissing") throw new HttpError(404, "no doc dmissing");
      return json({ id: p.id, chatId: p.id === "dchat" ? "s9" : null });
    })
    .on("GET", "/api/task-jobs", (_q, _p, u) => (seen(u), json([{ taskId: "T-SETUP", state: "running" }, { taskId: "T-1", state: "done" }])))
    .on("GET", "/api/tasks/:id", (_q, p, u) => {
      seen(u);
      if (p.id === "T-GONE") throw new HttpError(404, "unknown task");
      return json({ id: p.id, state: p.id === "T-OLD" ? "removed" : "ready" });
    })
    .on("GET", "/api/terminals", (_q, _p, u) => (seen(u), json([{ id: "term1" }])))
    .on("GET", "/api/tasks/:id/prs", (_q, _p, u) => (seen(u), json([])))
    .on("GET", "/api/tasks", (_q, _p, u) => (seen(u), json([{ id: "T-1" }])))
    .on("GET", "/api/prs", () => {
      throw new HttpError(500, "gh is not signed in");
    })
    .on("GET", "/api/status", (_q, _p, u) => (seen(u), json({ workspaces: ["w"] })))
    .on("GET", "/api/docs", (_q, _p, u) => (seen(u), json([{ id: "d1" }])))
    .on("GET", "/api/notifications", (_q, _p, u) => (seen(u), json({ enabled: true, sound: false })));
  viewRoutes(r);
  const view = async (path: string) => {
    const url = new URL(path, "http://x");
    const m = r.match("GET", url.pathname)!;
    try {
      const res = await m.handler(new Request(url), m.params, url);
      return { status: res.status, body: (await res.json()) as any };
    } catch (err) {
      return { status: (err as HttpError).status, body: { error: (err as Error).message } };
    }
  };
  return { calls, view };
}

test("a chat page in one call: its chats, approvals, the open chat (asked for, else the newest) and its events", async () => {
  const a = app();
  expect((await a.view("/api/views/chat?kind=jin&chat=s1")).body).toEqual({ sessions: [{ id: "s2" }, { id: "s1" }], approvals: [{ id: "a1" }], session: { id: "s1" }, events: [{ seq: 1, of: "s1" }] });
  expect((await a.view("/api/views/chat?kind=jin")).body.session).toEqual({ id: "s2" });
  expect((await a.view("/api/views/chat?kind=jin&chat=gone")).body.session).toEqual({ id: "s2" });
  expect((await a.view("/api/views/chat?kind=jin&chat=new")).body).toMatchObject({ session: null, events: [] });
  expect(a.calls.filter((c) => c.includes("/events"))).toEqual(["/api/sessions/s1/events", "/api/sessions/s2/events", "/api/sessions/s2/events"]);
});

test("the desk's view brings the feed in the states it asks for", async () => {
  const a = app();
  const { body } = await a.view("/api/views/chat?kind=desk&feed=new,stale");
  expect(body).toMatchObject({ session: { id: "d1" }, events: [{ of: "d1" }], feed: [{ id: "f1", state: "new,stale" }] });
  expect((await a.view("/api/views/chat?kind=jin")).body.feed).toBeUndefined();
});

test("a doc's view: the doc with its chat, or none; a missing doc says so", async () => {
  const a = app();
  expect((await a.view("/api/views/doc/dchat")).body).toEqual({ doc: { id: "dchat", chatId: "s9" }, chat: { session: { id: "s9" }, events: [{ seq: 1, of: "s9" }] } });
  expect((await a.view("/api/views/doc/dplain")).body).toEqual({ doc: { id: "dplain", chatId: null }, chat: null });
  expect(await a.view("/api/views/doc/dmissing")).toEqual({ status: 404, body: { error: "no doc dmissing" } });
});

test("a task's view: its setup while that runs, the task when it is not ready, else the task with its terminals and PRs", async () => {
  const a = app();
  expect((await a.view("/api/views/task/T-SETUP")).body).toEqual({ job: { taskId: "T-SETUP", state: "running" }, task: null });
  expect((await a.view("/api/views/task/T-GONE")).body).toEqual({ job: null, task: null });
  expect((await a.view("/api/views/task/T-OLD")).body).toEqual({ job: null, task: { id: "T-OLD", state: "removed" } });
  expect((await a.view("/api/views/task/T-1")).body).toEqual({ job: null, task: { id: "T-1", state: "ready" }, terminals: [{ id: "term1" }], prs: [] });
});

test("the sidebar's view of a machine, in one call: a part that fails is empty, not the whole", async () => {
  const a = app();
  expect((await a.view("/api/views/sidebar")).body).toEqual({ tasks: [{ id: "T-1" }], terminals: [{ id: "term1" }], jobs: [{ taskId: "T-SETUP", state: "running" }, { taskId: "T-1", state: "done" }], prs: [], status: { workspaces: ["w"] } });
});

test("the shell's view of the home: every chat, approvals, docs and notification settings", async () => {
  const a = app();
  expect((await a.view("/api/views/shell")).body).toEqual({ sessions: [{ id: "s2" }, { id: "s1" }], approvals: [{ id: "a1" }], docs: [{ id: "d1" }], notifications: { enabled: true, sound: false } });
});
