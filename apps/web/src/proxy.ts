import { type NextRequest, NextResponse } from "next/server";

/**
 * Pages under /m/<machine>/ (another machine's tasks) talk to that machine: the proxy puts it
 * in an `x-jin-machine` header the server reads, for the page and the server actions it posts
 * alike. Next hands the proxy's response headers to the page it renders; acceptance A17 checks
 * this still holds.
 */
export function proxy(req: NextRequest) {
  const m = /^\/m\/([a-z0-9-]+)(\/.*)?$/.exec(req.nextUrl.pathname);
  const res = NextResponse.next();
  if (m) res.headers.set("x-jin-machine", m[1]!);
  return res;
}

export const config = { matcher: ["/m/:path*"] };
