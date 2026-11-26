import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Composio } from "../src/composio";
import { Feed } from "../src/feed";
import { openDb } from "../src/db";

// A composio CLI stood in for: like the real one, `login` does nothing while someone is signed in;
// `login --poll` waits until the test says how the browser sign-in went.
const cfg = mkdtempSync(join(tmpdir(), "jin-composio-cfg-"));
const bin = join(mkdtempSync(join(tmpdir(), "jin-composio-bin-")), "composio");
writeFileSync(
  bin,
  `#!/bin/bash
U="${cfg}/user_data.json"
case "$1 $2" in
  "logout "*) echo '{}' > "$U" ;;
  "whoami "*) grep -o '"email":"[^"]*"' "$U" >/dev/null && echo "{$(grep -o '"email":"[^"]*"' "$U")}" || exit 1 ;;
  "login --no-browser") grep -q email "$U" 2>/dev/null || echo "Open https://example.test/login" ;;
  "login --poll")
    while [ ! -f "${cfg}/outcome" ]; do sleep 0.02; done
    o=$(cat "${cfg}/outcome"); rm -f "${cfg}/outcome"
    [ "$o" = 0 ] && echo '{"email":"new@example.com"}' > "$U"
    exit "$o" ;;
esac
`,
);
chmodSync(bin, 0o755);
const prevEnv = process.env.JIN_COMPOSIO_CONFIG_DIR;
process.env.JIN_COMPOSIO_CONFIG_DIR = cfg;
afterAll(() => {
  if (prevEnv === undefined) delete process.env.JIN_COMPOSIO_CONFIG_DIR;
  else process.env.JIN_COMPOSIO_CONFIG_DIR = prevEnv;
});

const OLD = '{"email":"old@example.com","api_key":"k-old"}';
const session = () => readFileSync(join(cfg, "user_data.json"), "utf8").trim();
const composio = () => {
  const home = mkdtempSync(join(tmpdir(), "jin-composio-home-"));
  return new Composio({ home } as never, { feed: new Feed(openDb(home)), workspaces: [], notify: () => {} }, undefined, bin);
};
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(10);
  expect(ok()).toBe(true);
};
type Login = { state: string; switching?: boolean };
const login = (c: Composio) => (c as unknown as { login: Login }).login;

test("switching accounts: the old sign-in is set aside, and comes back when you cancel", async () => {
  writeFileSync(join(cfg, "user_data.json"), OLD);
  const c = composio();
  // Signed in, a plain sign-in gives no link (the CLI does nothing); switching does.
  await expect(c.startLogin()).rejects.toThrow("did not give a sign-in link");
  expect(session()).toBe(OLD);
  expect(await c.startLogin({ switchAccount: true })).toBe("https://example.test/login");
  expect(session()).toBe("{}");
  expect((await c.status()).login).toMatchObject({ state: "waiting", switching: true });
  // Opening the link again keeps the account to come back to.
  await c.startLogin();
  c.cancelLogin();
  expect(session()).toBe(OLD);
  expect((await c.status()).login).toMatchObject({ state: "idle", switching: false });
});

test("switching accounts: a completed sign-in replaces the old one; one that fails puts it back", async () => {
  writeFileSync(join(cfg, "user_data.json"), OLD);
  const c = composio();
  await c.startLogin({ switchAccount: true });
  writeFileSync(join(cfg, "outcome"), "0");
  await until(() => login(c).state === "done");
  expect(session()).toContain("new@example.com");
  expect((await c.status()).login.switching).toBe(false);

  writeFileSync(join(cfg, "user_data.json"), OLD);
  await c.startLogin({ switchAccount: true });
  writeFileSync(join(cfg, "outcome"), "1");
  await until(() => login(c).state === "failed");
  expect(session()).toBe(OLD);
  expect(existsSync(join(cfg, "outcome"))).toBe(false);
});

test("shutting down mid-switch keeps the account you had", async () => {
  writeFileSync(join(cfg, "user_data.json"), OLD);
  const c = composio();
  await c.startLogin({ switchAccount: true });
  c.stopAll();
  expect(session()).toBe(OLD);
});
