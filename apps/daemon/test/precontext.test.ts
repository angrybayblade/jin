import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { Journal } from "../src/journal";
import { candidatesFor, PreContext } from "../src/precontext";

/**
 * Phase 3 of jin's memory: each task's pre-context. jin looks at the long-term rows of the task's
 * workspace and picks what bears on it; the picks are links to those rows (never copies), handed
 * to every agent in the task, and you can add or remove them.
 */

const terms: Record<string, { taskId: string; title: string }> = { a: { taskId: "OLD-1", title: "Claude 1" }, b: { taskId: "OLD-2", title: "Claude 1" }, c: { taskId: "JIN-1", title: "Claude 1" } };
const ws: Record<string, string> = { "OLD-1": "composio", "OLD-2": "composio", "NEW-1": "composio", "JIN-1": "jin" };

/** Long-term memory with a few kept rows from earlier tasks, and a pre-context over it with a stand-in chooser. */
const setup = (choose?: (brief: string, ids: string[]) => { id: string; reason: string }[]) => {
  const db = openDb(mkdtempSync(join(tmpdir(), "jin-pre-")));
  const j = new Journal(db, (id) => terms[id] ?? null, { workspaceOf: (t) => ws[t] ?? null });
  const keep = (term: string, task: string, e: Parameters<Journal["add"]>[1]) => j.promote(task, [{ id: j.add(term, e).entry.id }], "jin")[0]!;
  const proxy = keep("a", "OLD-1", { concern: "rate limiter", kind: "decision", text: "Retries belong in the proxy layer", why: "per-call retries doubled 429s" });
  const tokens = keep("a", "OLD-1", { concern: "auth", kind: "found", text: "Stripe tokens refresh every 15 minutes" });
  const oldWay = keep("b", "OLD-2", { concern: "rate limiter", kind: "decision", text: "Retries per call with jitter", why: "the reason it was decided" });
  j.drop("OLD-2", [oldWay.id]);
  const other = keep("c", "JIN-1", { concern: "rate limiter", kind: "decision", text: "The desktop app never retries", why: "the reason it was decided" });
  const chosen: { brief: string; ids: string[] }[] = [];
  let calls = 0;
  const pre = new PreContext(db, {
    task: (id) => ({ workspace: ws[id] ?? null, brief: id === "NEW-1" ? "Rate limiter: 429s from Stripe under load" : "Something else entirely" }),
    candidates: async (workspace, text) => candidatesFor(j, workspace, text),
    rows: async (ids) => ids.map((id) => db.query("select * from memory where id = ?").get(id)).filter(Boolean).map((r: any) => ({ id: r.id, text: r.text, kind: r.kind, taskId: r.task_id })) as never,
    choose: async (brief, candidates) => {
      calls++;
      chosen.push({ brief, ids: candidates.map((c) => c.id) });
      return choose ? choose(brief, candidates.map((c) => c.id)) : candidates.slice(0, 1).map((c) => ({ id: c.id, reason: "bears on rate limiting" }));
    },
  });
  return { db, j, pre, proxy, tokens, oldWay, other, chosen, calls: () => calls };
};

test("memory p3: candidates are the workspace's long-term rows on the task's words, and recent decisions; never dropped ones or another workspace's", async () => {
  const { j, proxy, tokens, oldWay, other } = setup();
  const found = candidatesFor(j, "composio", "Rate limiter: 429s from Stripe under load");
  const ids = found.map((e) => e.id);
  expect(ids).toContain(proxy.id);
  expect(ids).toContain(tokens.id); // "Stripe"
  expect(ids).not.toContain(oldWay.id);
  expect(ids).not.toContain(other.id);
  // The rows that match more of the task's words come first.
  expect(ids[0]).toBe(proxy.id);
  expect(candidatesFor(j, "composio", "").length).toBeLessThanOrEqual(50);
});

test("memory p3: jin's picks are kept with their reasons, only from the candidates; a refresh replaces jin's picks and keeps yours", async () => {
  const { pre, proxy, tokens } = setup((_b, ids) => [
    { id: ids[0]!, reason: "the limiter's earlier decision" },
    { id: "made-up", reason: "not a candidate" },
  ]);
  await pre.select("NEW-1");
  expect(pre.list("NEW-1")).toEqual([{ memoryId: proxy.id, reason: "the limiter's earlier decision", by: "jin" }]);
  pre.add("NEW-1", tokens.id, "you asked for it");
  await pre.select("NEW-1");
  expect(pre.list("NEW-1").map((p) => [p.memoryId, p.by]).sort()).toEqual([
    [proxy.id, "jin"],
    [tokens.id, "you"],
  ].sort());
});

test("memory p3: agents read the picks as the rows are now (linked, not copied), with why each is there", async () => {
  const { db, pre, proxy } = setup();
  await pre.select("NEW-1");
  db.query("update memory set text = ? where id = ?").run("Retries belong in the proxy layer, with a budget", proxy.id);
  const text = await pre.text("NEW-1");
  expect(text).toContain("Retries belong in the proxy layer, with a budget");
  expect(text).toContain("bears on rate limiting");
  expect(text).toContain(proxy.id);
  expect(await pre.text("OTHER-9")).toBe("");
});

test("memory p3: you add and remove picks", async () => {
  const { pre, tokens } = setup(() => []);
  await pre.select("NEW-1");
  expect(pre.list("NEW-1")).toEqual([]);
  pre.add("NEW-1", tokens.id);
  expect(pre.list("NEW-1")).toEqual([{ memoryId: tokens.id, reason: null, by: "you" }]);
  pre.remove("NEW-1", tokens.id);
  expect(pre.list("NEW-1")).toEqual([]);
});

test("memory p3: picking runs once per task: not twice at the same time, and not again once done (until a refresh)", async () => {
  const { pre, calls } = setup();
  await Promise.all([pre.ensure("NEW-1"), pre.ensure("NEW-1")]);
  await pre.ensure("NEW-1");
  expect(calls()).toBe(1);
  await pre.select("NEW-1");
  expect(calls()).toBe(2);
});

test("memory p3: a task's own kept rows are not its pre-context (they are in its journal)", async () => {
  const { pre, proxy, chosen } = setup();
  await pre.select("OLD-1");
  expect(chosen.flatMap((c) => c.ids)).not.toContain(proxy.id);
  expect(pre.list("OLD-1")).toEqual([]);
});
