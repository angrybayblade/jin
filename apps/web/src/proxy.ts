import { type NextRequest, NextResponse } from "next/server";

/**
 * Every request passes here first.
 *
 * - Only requests addressed to this machine are answered. jin listens on 127.0.0.1, but a web
 *   page elsewhere can point a name of its own at 127.0.0.1 (DNS rebinding) and then read jin's
 *   pages and call its actions as if it were jin's own. Such a request still names that other
 *   host, so anything not addressed to loopback (or a name listed in JIN_WEB_HOSTS, for jin
 *   reached over Tailscale; docs/security.md 8c) is refused.
 * - Pages under /m/<machine>/ (another machine's tasks) talk to that machine: the machine goes
 *   in an `x-jin-machine` header the server reads, for the page and the server actions it posts
 *   alike. Next hands the proxy's response headers to the page it renders; acceptance A17 checks
 *   this still holds.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const extra = new Set(
  (process.env.JIN_WEB_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

/** The host a request is addressed to, without its port. */
export function hostOf(header: string | null): string {
  const h = (header ?? "").trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.replace(/:\d+$/, "");
}

export const allowedHost = (header: string | null) => {
  const host = hostOf(header);
  return LOOPBACK.has(host) || extra.has(host);
};

export function proxy(req: NextRequest) {
  if (!allowedHost(req.headers.get("host"))) {
    return new NextResponse("jin answers only requests addressed to this machine (127.0.0.1 or localhost).", { status: 421, headers: { "content-type": "text/plain" } });
  }
  const m = /^\/m\/([a-z0-9-]+)(\/.*)?$/.exec(req.nextUrl.pathname);
  const res = NextResponse.next();
  if (m) res.headers.set("x-jin-machine", m[1]!);
  return res;
}

// Everything, the app's own assets included (a rebound page must not read anything).
export const config = { matcher: ["/:path*"] };
