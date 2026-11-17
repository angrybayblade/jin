// The web server is up: answers at once, without asking any daemon (the desktop app waits on this
// at start; the home page can be slow while another machine's tunnel comes back).
export const dynamic = "force-dynamic";

export function GET() {
  return new Response("ok", { headers: { "cache-control": "no-store" } });
}
