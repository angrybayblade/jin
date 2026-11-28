import type { Database } from "bun:sqlite";
import type { Docs } from "./docs";
import { body, HttpError, json, type Router } from "./http";

/**
 * Syncing a jin doc to Notion, only when you ask: the first sync makes a page under a page you
 * pick, through one of your Notion connections (Composio); each sync after replaces that page's
 * title and content with the doc's. Nothing flows back, and nothing syncs on its own.
 */

/** A Notion connection to sync through, named by its workspace and owner. */
export interface NotionConnection {
  id: string;
  workspace: string | null;
  email: string | null;
  /** Composio's own name for it, when the workspace could not be read. */
  label: string;
  active: boolean;
}

/** A Notion page to put a doc under. */
export interface NotionTarget {
  id: string;
  title: string;
  icon: string | null;
  url: string | null;
}

export interface NotionLink {
  docId: string;
  account: string;
  pageId: string;
  url: string | null;
  parentId: string | null;
  syncedAt: string;
  syncedVersion: number;
}

/** How jin reaches Composio: a tool run through a given connection, and the Notion connections. */
export interface NotionRunner {
  tool(slug: string, input: Record<string, unknown>, opts: { account?: string; strict?: boolean }): Promise<Record<string, unknown> | null>;
  accounts(toolkit: "notion"): Promise<{ id: string; status: string; alias: string | null; word_id: string | null }[]>;
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const ACCOUNT = /^[\w-]{3,64}$/;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);

/** A page's title: the text of its property of type `title`. */
export function pageTitle(p: Obj): string {
  for (const prop of Object.values(obj(p.properties) ?? {})) {
    const o = obj(prop);
    if (o?.type === "title" && Array.isArray(o.title)) return o.title.map((t) => String(obj(t)?.plain_text ?? "")).join("").trim();
  }
  if (Array.isArray(p.title)) return p.title.map((t) => String(obj(t)?.plain_text ?? "")).join("").trim();
  return "";
}

/** Where a created page landed: its id and link, wherever the tool's answer puts them. */
export function createdPage(data: Obj | null): { id: string; url: string | null } | null {
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number): { id: string; url: string | null } | null => {
    const o = obj(v);
    if (!o || depth > 4 || seen.has(o)) return null;
    seen.add(o);
    if (typeof o.id === "string" && UUID.test(o.id) && (o.object === "page" || typeof o.url === "string")) return { id: o.id, url: typeof o.url === "string" ? o.url : null };
    for (const k of ["data", "response_data", "page", "result"]) {
      const hit = visit(o[k], depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return visit(data, 0);
}

/** A Notion error that means the page is no longer there for this connection. */
const gone = (msg: string) => /archived|in_trash|could not find|object_not_found|not found|404/i.test(msg);

export class NotionSync {
  private names = new Map<string, { at: number; workspace: string | null; email: string | null }>();

  constructor(
    private db: Database,
    private docs: Docs,
    private run: NotionRunner,
  ) {}

  /** Your Notion connections, each named by its workspace (read once in a while). */
  async connections(): Promise<NotionConnection[]> {
    const list = await this.run.accounts("notion");
    return Promise.all(
      list.map(async (a) => {
        let n = this.names.get(a.id);
        if ((!n || Date.now() - n.at > 600_000) && a.status === "ACTIVE") {
          const who = await this.run.tool("NOTION_WHO_AM_I", {}, { account: a.id }).catch(() => null);
          const d = obj(who?.data) ?? who;
          n = { at: Date.now(), workspace: typeof d?.workspace_name === "string" ? d.workspace_name : null, email: typeof d?.owner_email === "string" ? d.owner_email : null };
          this.names.set(a.id, n);
        }
        return { id: a.id, workspace: n?.workspace ?? null, email: n?.email ?? null, label: a.alias || a.word_id || a.id, active: a.status === "ACTIVE" };
      }),
    );
  }

  /** Pages a doc can go under, found by title (recently edited first when there is no query). */
  async pages(account: string, query: string): Promise<NotionTarget[]> {
    if (!ACCOUNT.test(account)) throw new HttpError(400, "pick a Notion connection");
    const q = query.trim().slice(0, 100);
    const r = await this.run.tool("NOTION_SEARCH_NOTION_PAGE", { query: q, filter_value: "page", page_size: 20, ...(q ? {} : { timestamp: "last_edited_time", direction: "descending" }) }, { account, strict: true });
    const results = Array.isArray(r?.results) ? r.results : Array.isArray(obj(r?.response_data)?.results) ? (obj(r?.response_data)!.results as unknown[]) : [];
    return results
      .map((x) => obj(x))
      .filter((p): p is Obj => Boolean(p && p.object === "page" && typeof p.id === "string" && !p.archived && !p.in_trash))
      .map((p) => {
        const icon = obj(p.icon);
        return { id: String(p.id), title: pageTitle(p) || "Untitled", icon: icon?.type === "emoji" && typeof icon.emoji === "string" ? icon.emoji : null, url: typeof p.url === "string" ? p.url : null };
      });
  }

  link(docId: string): NotionLink | null {
    this.docs.get(docId);
    const r = this.db.query("select * from doc_notion where doc_id = ?").get(docId) as { doc_id: string; account: string; page_id: string; url: string | null; parent_id: string | null; synced_at: string; synced_version: number } | null;
    return r ? { docId: r.doc_id, account: r.account, pageId: r.page_id, url: r.url, parentId: r.parent_id, syncedAt: r.synced_at, syncedVersion: r.synced_version } : null;
  }

  /**
   * Sync a doc: to its page when it has one (its title and content replaced), else to a new page
   * under `parentId` through `account`.
   */
  async sync(docId: string, o: { account?: string; parentId?: string } = {}): Promise<NotionLink> {
    const doc = this.docs.get(docId);
    const title = doc.title.trim() || "Untitled";
    const markdown = doc.body.trim() || " ";
    const at = new Date().toISOString();
    const linked = this.link(docId);
    if (linked) {
      try {
        await this.run.tool("NOTION_UPDATE_PAGE_MARKDOWN", { page_id: linked.pageId, type: "replace_content", replace_content: { new_str: markdown, allow_deleting_content: true } }, { account: linked.account, strict: true });
        await this.run.tool("NOTION_UPDATE_PAGE", { page_id: linked.pageId, properties: { title: { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] } } }, { account: linked.account, strict: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (gone(msg)) throw new HttpError(410, "the Notion page is gone (deleted, or no longer shared with the connection); unlink it to sync to a new page");
        throw err;
      }
      this.db.query("update doc_notion set synced_at = ?, synced_version = ? where doc_id = ?").run(at, doc.version, docId);
      return this.link(docId)!;
    }
    if (!o.account || !ACCOUNT.test(o.account)) throw new HttpError(400, "pick a Notion connection");
    if (!o.parentId || !UUID.test(o.parentId)) throw new HttpError(400, "pick the Notion page to put it under");
    const made = createdPage(await this.run.tool("NOTION_CREATE_NOTION_PAGE", { parent_id: o.parentId, title, markdown }, { account: o.account, strict: true })) ?? (await this.findCreated(o.account, o.parentId, title));
    if (!made) throw new HttpError(502, "Notion made the page but did not say where; look under the page you picked");
    this.db.query("insert into doc_notion (doc_id, account, page_id, url, parent_id, synced_at, synced_version) values (?, ?, ?, ?, ?, ?, ?)").run(docId, o.account, made.id, made.url, o.parentId, at, doc.version);
    return this.link(docId)!;
  }

  /** The page just made, when the create answer did not name it: the newest by that title under the parent. */
  private async findCreated(account: string, parentId: string, title: string): Promise<{ id: string; url: string | null } | null> {
    const flat = (id: string) => id.replace(/-/g, "").toLowerCase();
    const r = await this.run.tool("NOTION_SEARCH_NOTION_PAGE", { query: title.slice(0, 100), filter_value: "page", page_size: 20, timestamp: "last_edited_time", direction: "descending" }, { account }).catch(() => null);
    const results = (Array.isArray(r?.results) ? r.results : []).map((x) => obj(x)).filter((p): p is Obj => Boolean(p));
    const hit = results.find((p) => typeof p.id === "string" && flat(String(obj(p.parent)?.page_id ?? "")) === flat(parentId) && pageTitle(p) === title);
    return hit ? { id: String(hit.id), url: typeof hit.url === "string" ? hit.url : null } : null;
  }

  /** Forget the doc's page (the page stays in Notion); the next sync makes a new one. */
  unlink(docId: string) {
    this.docs.get(docId);
    this.db.query("delete from doc_notion where doc_id = ?").run(docId);
  }
}

export function notionSyncRoutes(router: Router, sync: NotionSync) {
  router
    .on("GET", "/api/composio/notion/connections", async () => json(await sync.connections()))
    .on("GET", "/api/composio/notion/pages", async (_req, _p, url) => json(await sync.pages(url.searchParams.get("account") ?? "", url.searchParams.get("q") ?? "")))
    .on("GET", "/api/docs/:id/notion", (_req, p) => json(sync.link(p.id!)))
    .on("POST", "/api/docs/:id/notion", async (req, p) => {
      const b = await body<{ account?: string; parentId?: string }>(req);
      return json(await sync.sync(p.id!, b));
    })
    .on("DELETE", "/api/docs/:id/notion", (_req, p) => {
      sync.unlink(p.id!);
      return json(null);
    });
}
