import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { asksJin, DocAsk, docForAgent, Docs, docTools, locate, threadPrompt } from "../src/docs";
import { parseLink } from "../src/links";

const fresh = () => new Docs(openDb(mkdtempSync(join(tmpdir(), "jin-docs-"))));

test("an anchor finds its quote exactly, without inline marks, and tells repeats apart by the text either side", () => {
  const body = "Retry with backoff.\n\nThe **rate limiter** keeps 429s rare.\n\nRetry with backoff, then give up.";
  expect(locate(body, { quote: "rate limiter" })).toEqual({ start: 27, end: 39 });
  // From the rendered doc, where **bold** reads as plain text, and a soft break as a space.
  const r = locate(body, { quote: "The rate limiter keeps" })!;
  expect(body.slice(r.start, r.end)).toBe("The **rate limiter** keeps");
  // "Retry with backoff" is there twice: the text after it names the second.
  const second = locate(body, { quote: "Retry with backoff", prefix: "keeps 429s rare.\n\n", suffix: ", then give up." })!;
  expect(second.start).toBe(body.lastIndexOf("Retry with backoff"));
  expect(locate(body, { quote: "circuit breaker" })).toBeNull();
});

test("saves need the version they were made on, and a burst of saves shares a version", () => {
  const docs = fresh();
  const d = docs.create({ title: "Rate limits RFC", body: "# Rate limits\n\nDraft.", tags: ["RFC", "apollo", "rfc"] }, "you");
  expect(d).toMatchObject({ version: 1, tags: ["rfc", "apollo"] });
  const a = docs.save(d.id, { body: "# Rate limits\n\nDraft two." }, 1, "you");
  const b = docs.save(d.id, { body: "# Rate limits\n\nDraft three." }, a.version, "you");
  expect(b.version).toBe(3);
  // Version 1 (created) stays; versions 2 and 3, moments apart by the same hand, are one.
  expect(docs.versions(d.id).map((v) => v.version)).toEqual([3, 1]);
  expect(() => docs.save(d.id, { body: "stale" }, a.version, "you")).toThrow("changed since you opened it");
  // Nothing changed: no new version.
  expect(docs.save(d.id, { body: "# Rate limits\n\nDraft three." }, 3, "you").version).toBe(3);
  const back = docs.restore(d.id, 1, 3);
  expect(back.body).toBe("# Rate limits\n\nDraft.");
});

test("comments thread on a quote or the whole doc; a quote that is gone marks the thread", () => {
  const docs = fresh();
  const d = docs.create({ title: "Spec", body: "We cache tokens for an hour." }, "you");
  const t = docs.comment(d.id, { text: "Why an hour? @jin", anchor: { quote: "for an hour" } }, "you");
  expect(t).toMatchObject({ anchor: { quote: "for an hour", prefix: "We cache tokens ", suffix: "." }, located: true, comments: [{ by: "you", text: "Why an hour? @jin" }] });
  docs.comment(d.id, { text: "Matches the token TTL.", threadId: t.id }, "jin");
  docs.comment(d.id, { text: "Overall: ship it." }, "you");
  expect(() => docs.comment(d.id, { text: "x", anchor: { quote: "not there" } }, "you")).toThrow("not in the doc");
  docs.save(d.id, { body: "We cache tokens for ten minutes." }, 1, "you");
  const full = docs.full(d.id);
  expect(full.threads.map((x) => [x.anchor?.quote ?? null, x.located, x.comments.length])).toEqual([
    ["for an hour", false, 2],
    [null, true, 1],
  ]);
  expect(docs.resolve(d.id, t.id).resolved).toBe(true);
  // A reply reopens it.
  expect(docs.comment(d.id, { text: "Reopening", threadId: t.id }, "you").resolved).toBe(false);
});

test("jin suggests changes by quote; accepting applies them as a new version, an outdated one cannot be", async () => {
  const docs = fresh();
  const d = docs.create({ title: "Plan", body: "Step one: ship.\nStep two: ship.\nDone." }, "you");
  const [tools] = [Object.fromEntries(docTools(docs).map((t) => [t.name, t]))];
  // "ship." appears twice: jin has to say which.
  await expect(tools.jin_suggest_doc_edit!.run({ docId: d.id, quote: "ship.", replacement: "test." })).rejects.toThrow("appears 2 times");
  const s = docs.suggest(d.id, { quote: "Step two: ship.", replacement: "Step two: roll out behind a flag.", why: "safer" }, "jin");
  const gone = docs.suggest(d.id, { quote: "Done.", replacement: "Done, and announced." }, "jin");
  expect(docForAgent(docs.full(d.id)).openSuggestions.map((x) => x.suggestionId)).toEqual([s.id, gone.id]);
  const { doc } = docs.decide(d.id, s.id, true);
  expect(doc.body).toBe("Step one: ship.\nStep two: roll out behind a flag.\nDone.");
  expect(docs.versions(d.id)[0]).toMatchObject({ version: doc.version, by: "jin" });
  docs.save(d.id, { body: "Step one: ship.\nStep two: roll out behind a flag.\nFinished." }, doc.version, "you");
  expect(docs.full(d.id).suggestions.find((x) => x.id === gone.id)?.located).toBe(false);
  expect(() => docs.decide(d.id, gone.id, true)).toThrow("no longer in the doc");
  expect(docs.decide(d.id, gone.id, false).suggestion.status).toBe("rejected");
  expect(() => docs.decide(d.id, s.id, false)).toThrow("already accepted");
  expect(docs.list()[0]).toMatchObject({ id: d.id, openSuggestions: 0, openThreads: 0 });
});

test("a comment asks jin when it names @jin or answers jin; the doc's chat starts once, and waits its turn when busy", () => {
  const docs = fresh();
  const d = docs.create({ title: "RFC", body: "Use Redis." }, "you");
  expect(asksJin("what do you think @jin?", null)).toBe(true);
  expect(asksJin("noted", { by: "jin" })).toBe(true);
  expect(asksJin("noted", { by: "you" })).toBe(false);
  expect(asksJin("email me@jin.dev", null)).toBe(false);
  const t = docs.comment(d.id, { text: "@jin why Redis?", anchor: { quote: "Redis" } }, "you");
  expect(threadPrompt(t, "@jin why Redis?")).toBe(`[Comment thread ${t.id} on "Redis"] why Redis?`);

  const sent: string[] = [];
  let busy = false;
  const ask = new DocAsk(docs, {
    start: (doc, prompt) => (sent.push(`start ${doc.id}: ${prompt}`), "chat-1"),
    send: (chatId, prompt) => (sent.push(`${chatId}: ${prompt}`), true),
    busy: () => busy,
  });
  expect(ask.ask(d.id, "first")).toEqual({ chatId: "chat-1", queued: false });
  expect(docs.get(d.id).chatId).toBe("chat-1");
  expect(ask.ask(d.id, "second")).toEqual({ chatId: "chat-1", queued: false });
  busy = true;
  expect(ask.ask(d.id, "third")).toEqual({ chatId: "chat-1", queued: true });
  expect(sent).toEqual([`start ${d.id}: first`, "chat-1: second"]);
  expect(docs.byChat("chat-1")?.id).toBe(d.id);
});

test("a jin doc links to a task by doc:<id> or its page in jin", () => {
  expect(parseLink("doc:d0123456789")).toMatchObject({ key: "doc:d0123456789", kind: "doc", url: "/docs/d0123456789" });
  expect(parseLink("http://127.0.0.1:3937/docs/d0123456789?x=1")?.key).toBe("doc:d0123456789");
  expect(parseLink("/docs/d0123456789")?.key).toBe("doc:d0123456789");
  expect(parseLink("https://example.com/docs/readme")).toBeNull();
});

test("a doc renames without a new version, duplicates without its discussion, and deletes with everything on it", () => {
  const docs = fresh();
  const d = docs.create({ title: "Plan", body: "Ship it.", tags: ["plen-1"] }, "you");
  docs.comment(d.id, { text: "When?", anchor: { quote: "Ship" } }, "you");
  docs.suggest(d.id, { quote: "Ship it.", replacement: "Ship it on Monday." }, "jin");
  expect(docs.rename(d.id, "  Rollout plan ")).toMatchObject({ title: "Rollout plan", version: 1 });
  // An editor open on version 1 still saves.
  expect(docs.save(d.id, { body: "Ship it soon." }, 1, "you").version).toBe(2);
  const copy = docs.duplicate(d.id, "you");
  expect(docs.full(copy.id)).toMatchObject({ title: "Rollout plan (copy)", body: "Ship it soon.", tags: ["plen-1"], threads: [], suggestions: [], chatId: null });
  docs.setChat(d.id, "chat-9");
  expect(docs.remove(d.id)).toEqual({ chatId: "chat-9" });
  expect(() => docs.get(d.id)).toThrow("no doc");
  expect(docs.list().map((x) => x.id)).toEqual([copy.id]);
});
