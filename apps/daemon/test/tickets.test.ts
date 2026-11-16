import { expect, test } from "bun:test";
import { Tickets } from "../src/tickets";

test("a ticket works once, for its own path", () => {
  const t = new Tickets();
  const { ticket } = t.issue("/api/terminal");
  expect(t.redeem(ticket, "/api/sessions/x/stream")).toBe(false); // wrong path also burns it
  expect(t.redeem(ticket, "/api/terminal")).toBe(false);
  const second = t.issue("/api/terminal").ticket;
  expect(t.redeem(second, "/api/terminal")).toBe(true);
  expect(t.redeem(second, "/api/terminal")).toBe(false);
});

test("an expired ticket is refused", async () => {
  const t = new Tickets(10);
  const { ticket } = t.issue("/api/terminal");
  await Bun.sleep(20);
  expect(t.redeem(ticket, "/api/terminal")).toBe(false);
});
