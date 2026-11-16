import { randomBytes } from "node:crypto";

/**
 * One-time tickets for browser websockets (live chat streams, terminals). The web app's
 * server asks for a ticket with the daemon token and hands only the ticket to the
 * browser, so the token never leaves the server. A ticket is good for one connection
 * to one path, within a minute.
 */
export class Tickets {
  private tickets = new Map<string, { path: string; expires: number }>();

  constructor(private ttlMs = 60_000) {}

  issue(path: string): { ticket: string; expiresAt: string } {
    this.sweep();
    const ticket = randomBytes(24).toString("base64url");
    const expires = Date.now() + this.ttlMs;
    this.tickets.set(ticket, { path, expires });
    return { ticket, expiresAt: new Date(expires).toISOString() };
  }

  /** True once, for the path it was issued for, before it expires. */
  redeem(ticket: string, path: string): boolean {
    const t = this.tickets.get(ticket);
    if (!t) return false;
    this.tickets.delete(ticket);
    return t.path === path && t.expires > Date.now();
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.tickets) if (v.expires <= now) this.tickets.delete(k);
  }
}
