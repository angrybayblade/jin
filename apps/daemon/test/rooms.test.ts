import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import type { HarnessRun } from "../src/harness/types";
import { Journal } from "../src/journal";
import { mentionsIn, type RoomDeps, Rooms, tagsIn } from "../src/rooms";
import { Sessions } from "../src/sessions";

type Act = (r: HarnessRun, turn: number) => Promise<string[]>;

/** A room over a stand-in for Claude: each agent's turn does what `act` says, and is recorded. */
const setup = (extra: Partial<RoomDeps> | ((db: ReturnType<typeof openDb>) => Partial<RoomDeps>) = {}) => {
  const home = mkdtempSync(join(tmpdir(), "jin-room-"));
  const db = openDb(home);
  const runs: { who: string; run: HarnessRun; turn: number }[] = [];
  const act = new Map<string, Act>();
  const dirs: Record<string, string> = {};
  const tasks = { get: (id: string) => ({ id, state: "ready", workspace: "w", root: home, dirs }) };
  let rooms: Rooms | null = null;
  const sessions = new Sessions({
    db,
    config: { home, model: "claude-test" } as never,
    tasks: tasks as never,
    adapters: new Map(),
    workspaces: [],
    kindTools: (s) => rooms!.toolsFor(s),
    toolBlock: (s, tool, input) => rooms!.blocked(s, tool, input),
    chatNote: (s) => rooms!.noteFor(s),
    harness: () => ({
      id: "claude",
      adapter: "test",
      run: async (r: HarnessRun) => {
        const who = /You are @([\w-]+)/.exec(r.instructions ?? "")![1]!;
        const turn = runs.filter((x) => x.who === who).length + 1;
        runs.push({ who, run: r, turn });
        for (const text of await (act.get(who) ?? (async () => [`${who} reply ${turn}`]))(r, turn)) r.emit("message", { text });
        return { sessionId: `claude-${who}` };
      },
    }),
  });
  const made: { title: string; tags: string[] }[] = [];
  const linked: string[] = [];
  rooms = new Rooms({
    db,
    sessions,
    tasks: tasks as never,
    docTools: () => [
      { name: "jin_create_doc", description: "", input: {}, run: async (a) => (made.push(a as never), { id: "d0000000001" }) },
      { name: "jin_read_doc", description: "", input: {}, run: async () => ({ title: "Spec" }) },
      { name: "jin_comment_doc", description: "", input: {}, run: async () => ({ threadId: "t1" }) },
    ],
    linkDoc: (taskId, docId) => void linked.push(`${taskId}:${docId}`),
    ...(typeof extra === "function" ? extra(db) : extra),
  });
  const settle = async (n = 1) => {
    for (let i = 0; i < 200 && rooms!.state("T-1").messages.filter((m) => m.author !== "you").length < n; i++) await Bun.sleep(5);
    await Bun.sleep(10);
  };
  const said = () => rooms!.state("T-1").messages.map((m) => `${m.kind === "note" ? "note" : (m.authorHandle ?? "you")}: ${m.text}`);
  return { rooms, sessions, runs, act, settle, said, made, linked, home, dirs, db };
};

/** A gate a test opens when it wants a turn to go on. */
const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};

test("a room starts with a designer, an engineer (the writer) and a reviewer; a message that names nobody runs nobody", async () => {
  const { rooms, runs } = setup();
  expect(rooms.state("T-1").agents.map((a) => [a.handle, a.access, a.state])).toEqual([
    ["designer", "read-only", "new"],
    ["engineer", "writer", "new"],
    ["reviewer", "read-only", "new"],
  ]);
  rooms.post("T-1", "thinking out loud, mail me at a@designer.dev");
  await Bun.sleep(30);
  expect(runs).toEqual([]);
  expect(mentionsIn("@Reviewer then @designer, and @reviewer again; not foo@engineer.dev", rooms.agents("T-1"))).toEqual(["reviewer", "designer"]);
  expect(mentionsIn("@all look", rooms.agents("T-1"))).toEqual(["designer", "engineer", "reviewer"]);
});

test("the agent you mention takes a turn; only its final message reaches the room", async () => {
  const { rooms, runs, act, settle, said } = setup();
  act.set("designer", async () => ["let me read the code first", "Drafted the spec: doc d123."]);
  rooms.post("T-1", "@designer draft the spec");
  await settle();
  expect(said()).toEqual(["you: @designer draft the spec", "designer: Drafted the spec: doc d123."]);
  expect(runs[0]!.run.prompt).toContain("user: @designer draft the spec");
  expect(runs[0]!.run.instructions).toContain("You are @designer (Designer)");
  expect(runs[0]!.run.instructions).toContain("read-only here");
  expect(runs[0]!.run.cwd).toContain("jin-room-");
  expect(rooms.state("T-1").agents[0]).toMatchObject({ handle: "designer", state: "idle" });
});

test("a turn is given the room since the agent's last turn: the others' final messages, not its own, nothing twice", async () => {
  const { rooms, runs, settle } = setup();
  rooms.post("T-1", "@designer draft");
  await settle(1);
  rooms.post("T-1", "a note to everyone");
  rooms.post("T-1", "@reviewer check the draft");
  await settle(2);
  rooms.post("T-1", "@designer address that");
  await settle(3);
  const second = runs.filter((r) => r.who === "designer")[1]!.run;
  expect(second.prompt).toContain("user: a note to everyone");
  expect(second.prompt).toContain("@reviewer: reviewer reply 1");
  expect(second.prompt).toContain("user: @designer address that");
  expect(second.prompt).not.toContain("designer reply 1");
  expect(second.prompt).not.toContain("@designer draft\n");
  expect(second.resume).toBe("claude-designer");
  // The reviewer's first turn starts from the room so far.
  expect(runs.find((r) => r.who === "reviewer")!.run.prompt).toContain("@designer: designer reply 1");
});

test("readers named together answer at the same time, each on its own", async () => {
  const { rooms, runs, act, settle } = setup();
  const g = gate();
  act.set("designer", async () => (await g.wait, ["designer done"]));
  act.set("reviewer", async () => (await g.wait, ["reviewer done"]));
  rooms.post("T-1", "@designer @reviewer thoughts?");
  await Bun.sleep(40);
  expect(runs.map((r) => r.who).sort()).toEqual(["designer", "reviewer"]);
  expect(rooms.state("T-1").agents.filter((a) => a.state === "running").length).toBe(2);
  g.open();
  await settle(2);
  expect(runs.find((r) => r.who === "reviewer")!.run.prompt).not.toContain("designer done");
});

test("once a writer is named they go in order: the next sees the writer's reply, and a failed turn holds the rest", async () => {
  const { rooms, runs, act, settle, said } = setup();
  const g = gate();
  act.set("engineer", async () => (await g.wait, ["Implemented in api/limit.ts; tests pass."]));
  rooms.post("T-1", "@engineer build it, then @reviewer review");
  await Bun.sleep(40);
  expect(runs.map((r) => r.who)).toEqual(["engineer"]);
  expect(rooms.state("T-1").agents.find((a) => a.handle === "reviewer")!.state).toBe("new");
  g.open();
  await settle(2);
  expect(runs.map((r) => r.who)).toEqual(["engineer", "reviewer"]);
  expect(runs[1]!.run.prompt).toContain("@engineer: Implemented in api/limit.ts; tests pass.");

  act.set("engineer", async () => {
    throw new Error("Not logged in");
  });
  rooms.post("T-1", "@engineer again, @reviewer after");
  await settle(4);
  expect(runs.filter((r) => r.who === "reviewer").length).toBe(1);
  expect(said().slice(-2)).toEqual(["note: @engineer failed: Not logged in", "note: @reviewer did not run: @engineer's turn did not finish."]);
});

test("a read-only agent's file edits are refused; the writer's are not", async () => {
  const { rooms, act, settle } = setup();
  const verdicts: Record<string, { allow: boolean; reason?: string }> = {};
  for (const who of ["reviewer", "engineer"]) act.set(who, async (r) => ((verdicts[who] = await r.gate("Edit", { file_path: "/x/a.ts" }, r.signal)), ["done"]));
  rooms.post("T-1", "@reviewer fix it");
  await settle(1);
  rooms.post("T-1", "@engineer fix it");
  await settle(2);
  expect(verdicts.reviewer).toMatchObject({ allow: false });
  expect(verdicts.reviewer!.reason).toContain("read-only in this room");
  expect(verdicts.engineer).toEqual({ allow: true });
  // In the shell too, for what plainly changes the worktree; reading and running checks stay open.
  const reviewer = { id: rooms.state("T-1").agents[2]!.sessionId!, kind: "room" } as never;
  for (const c of ["git commit -am x", "cd keyring && git checkout -- .", "sed -i '' s/a/b/ x.ts", "git -C keyring push"]) expect(rooms.blocked(reviewer, "Bash", { command: c })).toContain("read-only");
  for (const c of ["git diff", "git log --oneline -5", "bun test", "git status && git show HEAD"]) expect(rooms.blocked(reviewer, "Bash", { command: c })).toBeNull();
});

test("the tab's status, and clearing the room: messages go, agents stay and start over", async () => {
  const { rooms, settle } = setup();
  expect(rooms.status("T-9")).toEqual({ working: 0, waiting: 0, lastSeq: 0, name: null });
  rooms.post("T-1", "@designer draft");
  await settle(1);
  expect(rooms.status("T-1")).toMatchObject({ working: 0, lastSeq: 2 });
  rooms.clear("T-1");
  expect(rooms.state("T-1")).toMatchObject({ messages: [], agents: [{ handle: "designer", state: "new", sessionId: null }, {}, {}] });
});

test("a room takes a name for its tab, and an empty one goes back to none", () => {
  const { rooms } = setup();
  expect(rooms.rename("T-1", "  Keyring review  ")).toMatchObject({ name: "Keyring review" });
  expect(rooms.status("T-1").name).toBe("Keyring review");
  expect(rooms.rename("T-1", " ").name).toBeNull();
});

test("room_history reads earlier final messages and says so; a doc an agent makes is the task's; an agent naming another runs nobody", async () => {
  const { rooms, runs, act, settle, said, made, linked } = setup();
  rooms.post("T-1", "@designer draft");
  await settle(1);
  let history: unknown;
  act.set("reviewer", async (r) => {
    const tools = r.tools!;
    history = await tools.find((t) => t.name === "room_history")!.run({ from: "designer" });
    await tools.find((t) => t.name === "jin_create_doc")!.run({ title: "Review", markdown: "x" });
    await tools.find((t) => t.name === "jin_comment_doc")!.run({ docId: "d0000000002", text: "why?" });
    return ["Looks wrong. @engineer should redo it."];
  });
  rooms.post("T-1", "@reviewer look back");
  await settle(3);
  expect(history).toMatchObject({ messages: [{ from: "@designer", text: "designer reply 1" }], earlier: 0 });
  expect(said()).toContain("note: @reviewer read the room's history.");
  expect(made[0]).toMatchObject({ title: "Review", tags: ["t-1"] });
  expect(linked).toEqual(["T-1:d0000000001"]);
  await Bun.sleep(30);
  expect(runs.some((r) => r.who === "engineer")).toBe(false);
  expect(rooms.state("T-1").messages.at(-1)).toMatchObject({
    authorHandle: "reviewer",
    mentions: ["engineer"],
    refs: [
      { kind: "doc", id: "d0000000001", title: "Review", did: ["created"] },
      { kind: "doc", id: "d0000000002", title: "Spec", did: ["commented"] },
    ],
  });
});

test("a mention while the agent works waits its turn; a fresh start gives it a new session and the room again", async () => {
  const { rooms, sessions, runs, act, settle } = setup();
  const g = gate();
  act.set("designer", async (_r, turn) => (turn === 1 ? (await g.wait, ["first"]) : [`turn ${turn}`]));
  rooms.post("T-1", "@designer one");
  await Bun.sleep(30);
  rooms.post("T-1", "@designer two");
  await Bun.sleep(30);
  expect(rooms.state("T-1").agents[0]).toMatchObject({ state: "running", queued: 1 });
  g.open();
  await settle(2);
  expect(runs.length).toBe(2);
  expect(runs[1]!.run.prompt).toContain("user: @designer two");

  const before = rooms.state("T-1").agents[0]!.sessionId!;
  rooms.fresh("T-1", rooms.state("T-1").agents[0]!.id);
  rooms.post("T-1", "@designer three");
  await settle(4);
  const after = rooms.state("T-1").agents[0]!.sessionId!;
  expect(after).not.toBe(before);
  expect(sessions.list({ kind: "room", archived: true }).map((s) => s.id)).toEqual([before]);
  expect(runs[2]!.run.resume).toBeUndefined();
  expect(runs[2]!.run.prompt).toContain("you (earlier): first");
});

test("profiles: add one, edit it, and not while it works; handles are unique", async () => {
  const { rooms } = setup();
  const a = rooms.addAgent("T-1", { handle: "@Security", brief: "Find the holes.", model: "claude-haiku-5-5" });
  expect(a).toMatchObject({ handle: "security", name: "security", access: "read-only", model: "claude-haiku-5-5", color: "green" });
  expect(() => rooms.addAgent("T-1", { handle: "reviewer", brief: "x" })).toThrow("already in this room");
  expect(() => rooms.addAgent("T-1", { handle: "all", brief: "x" })).toThrow("handle");
  expect(rooms.updateAgent("T-1", a.id, { name: "Security", access: "writer", model: "" })).toMatchObject({ name: "Security", access: "writer", model: null });
  rooms.removeAgent("T-1", a.id);
  expect(rooms.agents("T-1").length).toBe(3);
});

test("while an agent works you see what it is writing; a writer's reply says which files its turn changed", async () => {
  const { rooms, act, settle, home, dirs } = setup();
  const repo = join(home, "api");
  mkdirSync(repo);
  const git = (...a: string[]) => spawnSync("git", a, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  writeFileSync(join(repo, "a.ts"), "1\n");
  writeFileSync(join(repo, "dirty.ts"), "already changed before the turn\n");
  git("add", "a.ts");
  git("commit", "-qm", "one");
  dirs.api = repo;

  const g = gate();
  act.set("engineer", async (r) => {
    r.stream?.("message.delta", { text: "Adding the " });
    r.stream?.("message.delta", { text: "limiter…" });
    await g.wait;
    writeFileSync(join(repo, "a.ts"), "2\n");
    writeFileSync(join(repo, "limit.ts"), "new\n");
    return ["Done."];
  });
  rooms.post("T-1", "@engineer build");
  await Bun.sleep(40);
  expect(rooms.state("T-1").agents[1]).toMatchObject({ handle: "engineer", state: "running", draft: "Adding the limiter…" });
  g.open();
  await settle(1);
  expect(rooms.state("T-1").agents[1]!.draft).toBeNull();
  // What was dirty before the turn and untouched by it is not the turn's.
  expect(rooms.state("T-1").messages.at(-1)).toMatchObject({ text: "Done.", refs: [{ kind: "files", repo: "api", count: 2, files: ["a.ts", "limit.ts"] }] });
});

test("after a restart, a turn that was cut off says so in its room, once; one you stopped does not", async () => {
  const { rooms, sessions, act, settle } = setup();
  const g = gate();
  act.set("designer", async (r) => (await new Promise((_, no) => r.signal.addEventListener("abort", () => no(new Error("aborted")))), []));
  act.set("reviewer", async () => (await g.wait, ["never"]));
  rooms.post("T-1", "@designer one");
  rooms.post("T-1", "@reviewer two");
  await Bun.sleep(40);
  // You stop the designer; the reviewer is still running when jin "restarts".
  rooms.stop("T-1", rooms.state("T-1").agents[0]!.id);
  await settle(1);
  const db = (sessions as unknown as { db: import("bun:sqlite").Database }).db;
  db.query("update sessions set state = 'interrupted' where state = 'running'").run();
  const again = () => new Rooms({ db, sessions, tasks: { get: (id: string) => ({ id, state: "ready", dirs: {} }) } as never, docTools: () => [] });
  again();
  again();
  const notes = rooms.state("T-1").messages.filter((m) => m.kind === "note").map((m) => m.text);
  expect(notes.filter((t) => t.includes("cut off when jin restarted"))).toEqual([expect.stringContaining("@reviewer was cut off")]);
  expect(notes.some((t) => t.startsWith("@designer was cut off"))).toBe(false);
  g.open();
});

test("a message's tags: docs and files, without the punctuation after them", () => {
  expect(tagsIn("see @file:keyring/src/a.ts, and @doc:d0123456789. Also @file:x.md")).toEqual({ docs: ["d0123456789"], files: ["keyring/src/a.ts", "x.md"] });
  expect(tagsIn("an email@doc:x is not a tag")).toEqual({ docs: [], files: [] });
});

test("tagged docs, files and PRs: chips on the message, and the docs' text and files' paths for the agent", async () => {
  const { rooms, runs, settle } = setup({
    docInfo: async (id) => (id === "d0123456789" ? { title: "Keyring plan", body: "Rotate keys monthly." } : null),
    mentions: async () => [{ label: "platform#12", kind: "pr", key: "github:composiohq/platform#12", title: "Fix the limiter", url: "https://github.com/ComposioHQ/platform/pull/12", state: "open", detail: null }],
  });
  const root = (rooms as unknown as { deps: { tasks: { get: (id: string) => { root: string } } } }).deps.tasks.get("T-1").root;
  mkdirSync(join(root, "keyring"), { recursive: true });
  writeFileSync(join(root, "keyring", "README.md"), "keyring");
  rooms.post("T-1", "@designer read @file:keyring/README.md and @doc:d0123456789 (and @file:nope.md, @doc:d9999999999) about @platform#12");
  await settle(1);
  await Bun.sleep(20);
  const mine = rooms.state("T-1").messages.find((m) => m.author === "you")!;
  expect(mine.refs).toEqual(
    expect.arrayContaining([
      { kind: "doc", id: "d0123456789", title: "Keyring plan", did: ["tagged"] },
      { kind: "file", path: "keyring/README.md" },
      { kind: "mention", what: "pr", label: "platform#12", title: "Fix the limiter", url: "https://github.com/ComposioHQ/platform/pull/12", state: "open" },
    ]),
  );
  expect(mine.refs).toHaveLength(3);
  const prompt = runs[0]!.run.prompt;
  expect(prompt).toContain("[The user tagged:]");
  expect(prompt).toContain("- file keyring/README.md");
  expect(prompt).toContain('jin doc "Keyring plan" (id d0123456789)');
  expect(prompt).toContain("Rotate keys monthly.");
  expect(prompt).not.toContain("nope.md (in this");
});

/** A room whose agents share the task's memory with its terminal tabs (one Claude Code tab: t1). */
const withMemory = () => {
  let journal!: Journal;
  const room = setup((db) => {
    journal = new Journal(db, (id) => (id === "t1" ? { taskId: "T-1", title: "Claude 1" } : null), { workspaceOf: () => "w" });
    return { journal };
  });
  return { ...room, journal: () => journal };
};

test("memory: a room agent writes the task's rows with its journal tool, named by its handle", async () => {
  const { rooms, act, settle, journal } = withMemory();
  act.set("designer", async (r) => {
    const tool = r.tools!.find((t) => t.name === "journal")!;
    expect(await tool.run({ concern: "onboarding", kind: "decision", text: "Two steps, not three", why: "drop-off at step 3" })).toBe("ok");
    return ["Decided: two steps."];
  });
  rooms.post("T-1", "@designer how many onboarding steps?");
  await settle(1);
  const entry = journal().view("T-1").concerns[0]!.entries[0]!;
  expect(entry).toMatchObject({ taskId: "T-1", session: "@designer", terminalId: null, concern: "onboarding", kind: "decision", text: "Two steps, not three", why: "drop-off at step 3", level: "task", workspace: "w" });
});

test("memory: every agent in the task reads all its rows: a tab's context has the room's, the room's agents read the tab's", async () => {
  const { rooms, act, settle, journal } = withMemory();
  journal().add("t1", { concern: "limiter", kind: "decision", text: "Retry in the proxy", why: "fewer 429s" });
  let read = "";
  act.set("reviewer", async (r) => {
    read = String(await r.tools!.find((t) => t.name === "task_journal")!.run({}));
    await r.tools!.find((t) => t.name === "journal")!.run({ concern: "limiter", kind: "found", text: "The proxy already backs off" });
    return ["Read it."];
  });
  rooms.post("T-1", "@reviewer check the limiter work");
  await settle(1);
  expect(read).toContain("Retry in the proxy");
  expect(read).toContain("Claude 1");
  const tab = journal().contextText("T-1");
  expect(tab).toContain("Retry in the proxy");
  expect(tab).toContain("The proxy already backs off");
  expect(tab).toContain("@reviewer");
});
