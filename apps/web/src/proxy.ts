import { type NextRequest, NextResponse } from "next/server";

/**
 * /m/<machine>/<path> is <path> on that machine: rewritten to <path>, with the machine in a
 * request header the server reads (page renders and the server actions a page posts alike).
 * The header is never taken from the browser.
 */
export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.delete("x-jin-machine");
  const m = /^\/m\/([a-z0-9-]+)(\/.*)?$/.exec(req.nextUrl.pathname);
  if (!m) return NextResponse.next({ request: { headers } });
  headers.set("x-jin-machine", m[1]!);
  const url = req.nextUrl.clone();
  url.pathname = m[2] || "/";
  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = { matcher: ["/((?!_next/|healthz|icon\\.svg|favicon).*)"] };
