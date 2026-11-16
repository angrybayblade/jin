import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import type { Config, WorkspaceConfig } from "./config";
import { body, HttpError, json, Router } from "./http";
import type { Tickets } from "./tickets";

/** Everything a route needs. */
export interface App {
  config: Config;
  db: Database;
  token: string;
  workspaces: WorkspaceConfig[];
  router: Router;
  tickets: Tickets;
  /** This jin's commit (a checkout's HEAD, or the VERSION a machine was given). */
  version?: () => string | null;
  /** Timers registered by the scheduler; always 0 in local mode. */
  jobs(): number;
}

const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The bearer token from the header, or from ?token= for websocket upgrades (browsers cannot set headers there). */
function presentedToken(req: Request, url: URL): string | undefined {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return url.searchParams.get("token") ?? undefined;
  return undefined;
}

/**
 * Checks every request: loopback is where the daemon listens, the token proves the
 * caller can read $JIN_HOME, and a browser origin other than the web app is refused.
 */
export function guard(app: App, req: Request, url: URL): Response | undefined {
  if (url.pathname === "/health") return undefined;
  const origin = req.headers.get("origin");
  if (origin && !app.config.webOrigins.includes(origin)) return json({ error: "origin not allowed" }, 403);
  // A browser websocket may present a one-time ticket instead of the token.
  const ticket = url.searchParams.get("ticket");
  if (ticket && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return app.tickets.redeem(ticket, url.pathname) ? undefined : json({ error: "invalid or expired ticket" }, 401);
  }
  const token = presentedToken(req, url);
  if (!token || !sameToken(token, app.token)) return json({ error: "missing or invalid token" }, 401);
  return undefined;
}

export async function handle(app: App, req: Request, url: URL): Promise<Response> {
  const denied = guard(app, req, url);
  if (denied) return denied;
  if (url.pathname === "/health") return json({ ok: true });
  const m = app.router.match(req.method, url.pathname);
  if (!m) return json({ error: "not found" }, 404);
  try {
    return await m.handler(req, m.params, url);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

export function coreRoutes(app: App) {
  app.router
    .on("GET", "/api/status", () =>
      json({ mode: app.config.mode, jobs: app.jobs(), workspaces: app.workspaces.map((w) => w.id), version: app.version?.() ?? null }),
    )
    .on("POST", "/api/tickets", async (req) => {
      const { path } = await body<{ path?: string }>(req);
      if (!path || !/^\/api\/(sessions\/[^/]+\/stream|terminals\/[^/]+\/attach)$/.test(path)) throw new HttpError(400, "tickets are for /api/sessions/:id/stream and /api/terminals/:id/attach");
      return json(app.tickets.issue(path), 201);
    })
    .on("POST", "/api/schedules", () => {
      // Scheduled work needs a machine that stays on. Local mode never registers timers.
      if (app.config.mode !== "vm") throw new HttpError(409, "schedules need the VM (mode: vm); this jin runs in local mode");
      throw new HttpError(501, "schedules are not implemented yet");
    });
}
