import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { TaskJobs } from "../src/jobs";
import { Problems } from "../src/problems";

test("a background failure is kept, the same one counted, newest first", () => {
  const p = new Problems();
  const log = console.error;
  console.error = () => {};
  try {
    p.add("PR sync", new Error("gh: rate limited"));
    p.add("tunnel to hub", "ssh exited");
    p.add("PR sync", new Error("gh:   rate\nlimited"));
    expect(p.catch("title", "fallback")(new Error("x"))).toBe("fallback");
  } finally {
    console.error = log;
  }
  expect(p.recent().map((x) => [x.scope, x.message, x.count])).toEqual([
    ["title", "x", 1],
    ["PR sync", "gh: rate limited", 2],
    ["tunnel to hub", "ssh exited", 1],
  ]);
  p.clear();
  expect(p.recent()).toEqual([]);
});

test("a task setup running when jin stopped comes back failed, saying what that leaves; finished ones as they were", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "jin-jobs-")));
  const job = (id: string, state: string) => ({ id, workspace: "w", taskId: id, slug: "s", repos: ["a"], setup: true, state, log: ["cloning"], error: null, terminalId: null, startedAt: new Date().toISOString(), finishedAt: null });
  for (const j of [job("A-1", "running"), job("A-2", "done")]) db.query("insert into task_jobs (id, started_at, body) values (?, ?, ?)").run(j.id, j.startedAt, JSON.stringify(j));
  const jobs = new TaskJobs({ db } as never);
  const a = jobs.get("A-1");
  expect(a.state).toBe("failed");
  expect(a.error).toContain("jin restarted while this task was being set up");
  expect(a.log.at(-1)).toContain("failed: jin restarted");
  expect(jobs.get("A-2").state).toBe("done");
  // And it stays that way through the next restart.
  expect(new TaskJobs({ db } as never).get("A-1").state).toBe("failed");
});
