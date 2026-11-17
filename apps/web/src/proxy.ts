import { type NextRequest, NextResponse } from "next/server";

/**
 * /m/<machine>/<path> is <path> on that machine: rewritten to <path>, with the machine in an
 * `x-jin-machine` header the server reads (page renders and the server actions a page posts
 * alike). Next hands a rewrite's response headers to the page it renders (its request-header
 * override does not survive a rewrite here); acceptance A21 checks this still holds.
 */
export function proxy(req: NextRequest) {
  const m = /^\/m\/([a-z0-9-]+)(\/.*)?$/.exec(req.nextUrl.pathname);
  if (!m) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = m[2] || "/";
  const res = NextResponse.rewrite(url);
  res.headers.set("x-jin-machine", m[1]!);
  return res;
}

export const config = { matcher: ["/m/:path*"] };
