import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO, scripted, setupEnv, startDaemon, until, WEB_DIST, WEB_ORIGIN, WEB_PORT, type Daemon, type Env } from "./helpers";

const WEB = join(REPO, "apps/web");
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let env: Env;
let d: Daemon;
let web: ReturnType<typeof Bun.spawn> | undefined;
let built = false;

beforeAll(async () => {
  env = setupEnv();
  d = await startDaemon(env);
  await d.json("/api/collect/github", { method: "POST" });
  await d.json("/api/workspaces/composio/tasks", { method: "POST", json: { id: "PLEN-7", repos: ["platform"], slug: "w" } });
}, 60_000);
afterAll(async () => {
  web?.kill("SIGTERM");
  await web?.exited;
  await d?.stop();
  env?.cleanup();
});

async function startWeb() {
  web = Bun.spawn(["bun", "run", "start"], {
    cwd: WEB,
    env: { ...process.env, PORT: WEB_PORT, JIN_HOME: env.home, JIN_WEB_DIST: WEB_DIST },
    stdout: "pipe",
    stderr: "pipe",
  });
  await until(() => fetch(WEB_ORIGIN).then((r) => r.status < 500).catch(() => false), 30_000, "web server");
}

test(
  "A17 the web app builds and the command center shows the daemon's feed",
  async () => {
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: WEB, env: { ...process.env, JIN_HOME: env.home, JIN_WEB_DIST: WEB_DIST }, stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`next build failed:\n${build.stderr.toString().slice(-3000)}${build.stdout.toString().slice(-3000)}`);
    built = true;
    await startWeb();
    const html = await (await fetch(WEB_ORIGIN)).text();
    for (const title of ["Rate-limit tool router sessions", "Fix thermos webhook retries", "Dashboard shows stale connection state"]) {
      expect(html).toContain(title);
    }
  },
  300_000,
);

test(
  "A18 a pending approval shows in the UI and can be approved from it",
  async () => {
    expect(built).toBe(true);
    expect(existsSync(CHROME)).toBe(true);
    const s = await d.json("/api/tasks/PLEN-7/sessions", {
      method: "POST",
      json: { prompt: scripted([{ tool: "Bash", input: { command: "git push origin HEAD" } }, { text: "pushed" }]) },
    });
    const approval = await until(async () => (await d.json<any[]>("/api/approvals?state=pending")).find((a) => a.sessionId === s.id), 10_000, "approval");

    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      await page.goto(WEB_ORIGIN, { waitUntil: "networkidle0" });
      const row = await page.waitForSelector(`[data-approval-id="${approval.id}"]`, { timeout: 15_000 });
      expect(await row!.evaluate((el) => el.textContent)).toContain("git push origin HEAD");
      const button = await row!.waitForSelector('button[data-decision="approve"]');
      await button!.click();
      await until(async () => (await d.json<any[]>("/api/approvals")).find((a) => a.id === approval.id)?.state === "approved", 10_000, "approved");
      await until(async () => (await d.json(`/api/sessions/${s.id}`)).state === "idle", 10_000, "session idle");
    } finally {
      await browser.close();
    }
  },
  120_000,
);
