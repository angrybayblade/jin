import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { Docs } from "../src/docs";
import { HttpError } from "../src/http";
import { createdPage, NotionSync, type NotionRunner, pageTitle } from "../src/notion-sync";

const PARENT = "59833787-2cf9-4fdf-8782-e53db20768a5";
const PAGE = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

function setup(fail: (slug: string) => string | null = () => null) {
  const db = openDb(mkdtempSync(join(tmpdir(), "jin-notion-")));
  const docs = new Docs(db);
  const calls: { slug: string; input: Record<string, unknown>; account?: string }[] = [];
  const run: NotionRunner = {
    accounts: async () => [
      { id: "ca_work", status: "ACTIVE", alias: null, word_id: "notion_amende-dingo" },
      { id: "ca_old", status: "EXPIRED", alias: "old", word_id: null },
    ],
    tool: async (slug, input, opts) => {
      calls.push({ slug, input, account: opts.account });
      const why = fail(slug);
      if (why) {
        if (opts.strict) throw new HttpError(502, why);
        return null;
      }
      if (slug === "NOTION_WHO_AM_I") return { data: { workspace_name: "Composio", owner_email: "me@example.com" }, display_name: "jin" };
      if (slug === "NOTION_CREATE_NOTION_PAGE") return { data: { object: "page", id: PAGE, url: `https://www.notion.so/${PAGE.replace(/-/g, "")}` } };
      if (slug === "NOTION_SEARCH_NOTION_PAGE")
        return {
          results: [
            { object: "page", id: PARENT, url: "https://www.notion.so/x", icon: { type: "emoji", emoji: "📚" }, properties: { Name: { type: "title", title: [{ plain_text: "Eng " }, { plain_text: "docs" }] } } },
            { object: "page", id: PAGE, archived: true, properties: {} },
            { object: "database", id: PARENT, title: [] },
          ],
        };
      return { ok: true };
    },
  };
  return { db, docs, calls, sync: new NotionSync(db, docs, run) };
}

test("names each Notion connection by its workspace, and finds pages to put a doc under", async () => {
  const { sync, calls } = setup();
  expect(await sync.connections()).toEqual([
    { id: "ca_work", workspace: "Composio", email: "me@example.com", label: "notion_amende-dingo", active: true },
    { id: "ca_old", workspace: null, email: null, label: "old", active: false },
  ]);
  await sync.connections();
  expect(calls.filter((c) => c.slug === "NOTION_WHO_AM_I").length).toBe(1); // kept a while; an expired one is not asked
  expect(await sync.pages("ca_work", "eng")).toEqual([{ id: PARENT, title: "Eng docs", icon: "📚", url: "https://www.notion.so/x" }]);
  expect(calls.at(-1)).toMatchObject({ slug: "NOTION_SEARCH_NOTION_PAGE", account: "ca_work", input: { query: "eng", filter_value: "page" } });
});

test("the first sync makes a page under the one picked; later ones replace its title and content", async () => {
  const { docs, sync, calls } = setup();
  const d = docs.create({ title: "Rate limits RFC", body: "# Why\n\nDraft." }, "you");
  expect(sync.link(d.id)).toBeNull();
  await expect(sync.sync(d.id)).rejects.toThrow("pick a Notion connection");
  await expect(sync.sync(d.id, { account: "ca_work" })).rejects.toThrow("pick the Notion page");
  const l = await sync.sync(d.id, { account: "ca_work", parentId: PARENT });
  expect(l).toMatchObject({ docId: d.id, account: "ca_work", pageId: PAGE, parentId: PARENT, syncedVersion: 1 });
  expect(calls.at(-1)).toEqual({ slug: "NOTION_CREATE_NOTION_PAGE", account: "ca_work", input: { parent_id: PARENT, title: "Rate limits RFC", markdown: "# Why\n\nDraft." } });

  const v2 = docs.save(d.id, { title: "Rate limits", body: "# Why\n\nDone." }, 1, "you");
  const again = await sync.sync(d.id, { account: "ca_other", parentId: PARENT }); // already linked: same page, same connection
  expect(again).toMatchObject({ pageId: PAGE, account: "ca_work", syncedVersion: v2.version });
  expect(calls.slice(-2)).toEqual([
    { slug: "NOTION_UPDATE_PAGE_MARKDOWN", account: "ca_work", input: { page_id: PAGE, type: "replace_content", replace_content: { new_str: "# Why\n\nDone.", allow_deleting_content: true } } },
    { slug: "NOTION_UPDATE_PAGE", account: "ca_work", input: { page_id: PAGE, properties: { title: { title: [{ type: "text", text: { content: "Rate limits" } }] } } } },
  ]);

  sync.unlink(d.id);
  expect(sync.link(d.id)).toBeNull();
  // Deleting the doc drops its link with it.
  await sync.sync(d.id, { account: "ca_work", parentId: PARENT });
  docs.remove(d.id);
  expect(() => sync.link(d.id)).toThrow();
});

test("a page gone from Notion says to unlink it", async () => {
  const { docs, sync } = setup((slug) => (slug === "NOTION_UPDATE_PAGE_MARKDOWN" ? "Could not find block with ID" : null));
  const d = docs.create({ title: "T", body: "x" }, "you");
  await sync.sync(d.id, { account: "ca_work", parentId: PARENT });
  await expect(sync.sync(d.id)).rejects.toThrow("unlink it");
});

test("reads a page's title and where a created page landed", () => {
  expect(pageTitle({ properties: { title: { type: "title", title: [{ plain_text: "Hi" }] } } })).toBe("Hi");
  expect(createdPage({ response_data: { object: "page", id: PAGE, url: "u" } })).toEqual({ id: PAGE, url: "u" });
  expect(createdPage({ data: { id: "not-a-page" } })).toBeNull();
});

test("a create answer that does not name the page: found by its title under the parent", async () => {
  const { docs, calls, sync } = setup();
  const d = docs.create({ title: "Plan", body: "x" }, "you");
  const run = (sync as unknown as { run: NotionRunner }).run;
  const tool = run.tool;
  run.tool = async (slug, input, opts) => {
    if (slug === "NOTION_CREATE_NOTION_PAGE") return (calls.push({ slug, input, account: opts.account }), { ok: true });
    if (slug === "NOTION_SEARCH_NOTION_PAGE")
      return { results: [{ object: "page", id: "aaaaaaaa-0000-4000-8000-000000000000", parent: { page_id: "elsewhere" }, properties: { t: { type: "title", title: [{ plain_text: "Plan" }] } } }, { object: "page", id: PAGE, url: "u", parent: { page_id: PARENT.replace(/-/g, "") }, properties: { t: { type: "title", title: [{ plain_text: "Plan" }] } } }] };
    return tool(slug, input, opts);
  };
  expect(await sync.sync(d.id, { account: "ca_work", parentId: PARENT })).toMatchObject({ pageId: PAGE, url: "u" });
});
