import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskRules } from "../src/claude-cli";
import { openDb } from "../src/db";
import { Hooks, KEEP_STEP } from "../src/hooks";
import { Router } from "../src/http";
import { Journal, journalRoutes, keepMemory, keepOnMachine, memoryText } from "../src/journal";
import { PreContext } from "../src/precontext";

/** The fixes from memory's self-review: each finding (P product, T technical) and what now holds. */

const terms: Record<string, { taskId: string; title: string }> = { t1: { taskId: "PLEN-1", title: "Claude 1" } };
const journalIn = () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "jin-review-")));
  return { db, j: new Journal(db, (id) => terms[id] ?? null, { workspaceOf: () => "composio" }) };
};

test("memory review T1: a failed pick is not a pick: the task is picked again, but not before a pause", async () => {
  const { db, j } = journalIn();
  const kept = j.promote("PLEN-1", [{ id: j.add("t1", { concern: "limiter", kind: "decision", text: "Retries in the proxy" }).entry.id }], "jin")[0]!;
  let now = 1_000_000;
  let fail = true;
  let calls = 0;
  const pre = new PreContext(db, {
    task: () => ({ workspace: "composio", brief: "limiter retries" }),
    candidates: async () => [kept],
    rows: async () => [kept],
    choose: async (_b, c) => {
      calls++;
      if (fail) throw new Error("model unavailable");
      return [{ id: c[0]!.id, reason: "limiter" }];
    },
    clock: () => now,
  });
  await pre.ensure("NEW-1");
  expect(pre.list("NEW-1")).toEqual([]);
  await pre.ensure("NEW-1"); // within the pause: not asked again
  expect(calls).toBe(1);
  now += 11 * 60_000;
  fail = false;
  await pre.ensure("NEW-1");
  expect(calls).toBe(2);
  expect(pre.list("NEW-1").map((p) => p.memoryId)).toEqual([kept.id]);
});

test("memory review T2: what you forget or reword on the home stays so when the row arrives again", () => {
  const { j } = journalIn();
  const home = journalIn().j;
  const [a, b] = j.promote(
    "PLEN-1",
    [{ id: j.add("t1", { concern: "auth", kind: "found", text: "Tokens refresh hourly" }).entry.id }, { id: j.add("t1", { concern: "limiter", kind: "decision", text: "Retries in the proxy" }).entry.id }],
    "jin",
  );
  home.importGlobal([a!, b!], "mac");
  home.editGlobal(a!.id, { forget: true });
  home.editGlobal(b!.id, { text: "Retries belong in the proxy layer" });
  home.importGlobal([a!, { ...b!, text: "Retries in the proxy (again)" }], "mac");
  expect(home.listGlobal().map((e) => [e.id, e.text])).toEqual([[b!.id, "Retries belong in the proxy layer"]]);
});

test("memory review T3: keeping on another machine survives the home failing, and kept rows reach it later", async () => {
  const { j } = journalIn();
  const home = journalIn().j;
  const e = j.add("t1", { concern: "limiter", kind: "decision", text: "Retries in the proxy" }).entry;
  let homeDown = true;
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    if (method === "POST" && path === "/api/tasks/PLEN-1/memory/keep") {
      const b = body as { promote: { id: string }[] };
      return { kept: j.promote("PLEN-1", b.promote, "jin"), dropped: 0, summary: null } as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const flaky = { importGlobal: (rows: Parameters<Journal["importGlobal"]>[0], m: string | null, o?: { missingOnly?: boolean }) => {
    if (homeDown) throw new Error("home is not answering");
    home.importGlobal(rows, m, o);
  } };
  const out = await keepOnMachine({ call, home: flaky, machine: "mac" }, "PLEN-1", { promote: [{ id: e.id }] });
  expect(out).toMatchObject({ kept: 1, pending: expect.stringContaining("home") });
  // The task machine sends what it kept and the home is missing (as its daemon does every so often).
  homeDown = false;
  home.importGlobal(j.ownGlobal(), "mac", { missingOnly: true });
  expect(home.search("proxy", { level: "global" }).map((x) => x.id)).toEqual([e.id]);
  // Sending again only fills what is missing: a home edit stays.
  home.editGlobal(e.id, { text: "Retries belong in the proxy layer" });
  home.importGlobal(j.ownGlobal(), "mac", { missingOnly: true });
  expect(home.search("proxy", { level: "global" }).map((x) => x.text)).toEqual(["Retries belong in the proxy layer"]);
});

test("memory review T4: a daemon from before memory still reads and writes the journal on the new database", () => {
  const { db, j } = journalIn();
  j.add("t1", { concern: "limiter", kind: "decision", text: "Retries in the proxy" });
  // What the previous daemon ran against its `journal` table.
  db.query("insert into journal (id, task_id, terminal_id, session, concern, kind, text, why, refs, at) values ('old', 'PLEN-1', 't1', 'Claude 1', 'limiter', 'done', 'From an older jin', null, '[]', '2026-01-01')").run();
  db.query("update journal set refs = ? where id = ?").run('[{"type":"test","text":"bun test"}]', "old");
  const rows = db.query("select id, text, refs from journal where task_id = ? order by at").all("PLEN-1") as { id: string; text: string; refs: string }[];
  expect(rows.map((r) => r.text)).toContain("From an older jin");
  expect(j.view("PLEN-1").concerns[0]!.entries.map((e) => e.text)).toContain("From an older jin");
  expect(db.query("select refs from memory where id = 'old'").get()).toEqual({ refs: '[{"type":"test","text":"bun test"}]' });
});

test("memory review P1: a tab starts with the task's pre-context in its instructions", () => {
  const rules = taskRules({ taskId: "NEW-1", journal: true, preContext: "Notes kept by earlier tasks…\n- decision: Retries belong in the proxy layer" });
  expect(rules).toContain("Retries belong in the proxy layer");
});

test("memory review P2: Wrap up says it started, and where", async () => {
  const notes: { title: string; chat?: string }[] = [];
  const hooks = new Hooks(mkdtempSync(join(tmpdir(), "jin-wrap-n-")), { startChat: async () => ({ id: "c9" }), notify: (n) => void notes.push(n) });
  await hooks.wrapUp({ task: { id: "REV-7", title: "Review" }, machine: null });
  expect(notes).toEqual([expect.objectContaining({ title: "Wrap up", chat: "c9" })]);
});

test("memory review P3: keeping says what was kept, with the Memory page to see it", async () => {
  const { j } = journalIn();
  const e = j.add("t1", { concern: "limiter", kind: "decision", text: "Retries in the proxy" }).entry;
  const notes: { title: string; body: string; path: string }[] = [];
  await keepMemory(
    { task: { promote: async (items, by) => j.promote("PLEN-1", items, by), drop: async (ids) => j.drop("PLEN-1", ids), summarize: async (s) => j.summarize("PLEN-1", s) }, home: j, machine: null, notify: (n) => void notes.push(n) },
    { promote: [{ id: e.id }], summary: { text: "Retries moved." } },
  );
  expect(notes).toEqual([expect.objectContaining({ title: "jin kept 1 memory from PLEN-1", path: "/memory" })]);
  expect(notes[0]!.body).toContain("Retries in the proxy");
});

test("memory review P4: memory reaches agents as notes to check, never instructions; jin keeps its own wording", async () => {
  expect(memoryText([])).not.toContain("verify");
  const { j } = journalIn();
  const e = j.promote("PLEN-1", [{ id: j.add("t1", { concern: "limiter", kind: "decision", text: "Retries in the proxy" }).entry.id }], "jin")[0]!;
  expect(memoryText([e])).toMatch(/notes .* verify/i);
  expect(KEEP_STEP).toMatch(/own words/i);
});

test("memory review T5: a tab's memory_search asks the home for its task's workspace, and the home's import can only fill gaps", async () => {
  const { j } = journalIn();
  const router = new Router();
  const asked: [string | null, string][] = [];
  journalRoutes(router, j, {
    taskOfTerminal: (id) => (id === "t1" ? { taskId: "PLEN-1", workspace: "composio" } : null),
    longTerm: async (workspace, q) => (asked.push([workspace, q]), []),
  });
  const call = async (method: string, path: string, payload?: unknown) => {
    const url = new URL(`http://x${path}`);
    const m = router.match(method, url.pathname)!;
    const req = new Request(url, { method, ...(payload ? { body: JSON.stringify(payload), headers: { "content-type": "application/json" } } : {}) });
    return m.handler(req, m.params, url) as Promise<Response>;
  };
  const res = await call("GET", "/api/terminals/t1/memory-search?q=retries");
  expect(await res.text()).toBe("Nothing in long-term memory matches.");
  expect(asked).toEqual([["composio", "retries"]]);
  // The home: a resend fills only what is missing.
  const kept = j.promote("PLEN-1", [{ id: j.add("t1", { concern: "c", kind: "decision", text: "Kept here" }).entry.id }], "jin")[0]!;
  j.editGlobal(kept.id, { text: "Reworded on the home" });
  await call("POST", "/api/memory/import", { rows: [{ ...kept, text: "Old wording" }], machine: "mac", missingOnly: true });
  expect(j.listGlobal().map((e) => e.text)).toEqual(["Reworded on the home"]);
});
