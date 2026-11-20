import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  "A17 the web app builds and the desk shows the daemon's feed",
  async () => {
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: WEB, env: { ...process.env, JIN_HOME: env.home, JIN_WEB_DIST: WEB_DIST }, stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`next build failed:\n${build.stderr.toString().slice(-3000)}${build.stdout.toString().slice(-3000)}`);
    built = true;
    await startWeb();
    const html = await (await fetch(`${WEB_ORIGIN}/desk`)).text();
    for (const title of ["Rate-limit tool router sessions", "Fix thermos webhook retries", "Dashboard shows stale connection state"]) {
      expect(html).toContain(title);
    }

    // A page under /m/<machine>/ talks to that machine; a plain one to this machine. The
    // stand-in "machine" is a pass-through to the same daemon on a port of its own.
    const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => fetch(d.url + new URL(req.url).pathname + new URL(req.url).search, { method: req.method, headers: req.headers, body: req.body }) });
    try {
      mkdirSync(join(env.home, "machines"), { recursive: true });
      writeFileSync(join(env.home, "machines", "standin.json"), JSON.stringify({ id: "standin", host: "standin.invalid", label: "standin", remotePort: 7317, localPort: relay.port, token: d.token, createdAt: new Date().toISOString() }));
      const there = await (await fetch(`${WEB_ORIGIN}/m/standin/t/PLEN-7`)).text();
      const here = await (await fetch(`${WEB_ORIGIN}/t/PLEN-7`)).text();
      expect(there).toContain(`ws://127.0.0.1:${relay.port}`);
      expect(here).not.toContain(`ws://127.0.0.1:${relay.port}`);
    } finally {
      relay.stop(true);
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

test(
  "A17 the same task id on two machines: opening one after the other shows each machine's own tabs",
  async () => {
    expect(built).toBe(true);
    // A second machine with a task of the same id (its own daemon, reached directly).
    const env2 = setupEnv();
    const d2 = await startDaemon(env2);
    try {
      await d2.json("/api/workspaces/composio/tasks", { method: "POST", json: { id: "PLEN-7", repos: ["platform"], slug: "w" } });
      const here = await d.json<any>("/api/terminals", { method: "POST", json: { taskId: "PLEN-7", kind: "shell" } });
      const there = await d2.json<any>("/api/terminals", { method: "POST", json: { taskId: "PLEN-7", kind: "shell" } });
      await d.json(`/api/terminals/${here.id}`, { method: "PATCH", json: { title: "mac-tab" } });
      await d2.json(`/api/terminals/${there.id}`, { method: "PATCH", json: { title: "remote-tab" } });
      mkdirSync(join(env.home, "machines"), { recursive: true });
      writeFileSync(join(env.home, "machines", "second.json"), JSON.stringify({ id: "second", host: "second.invalid", label: "second", remotePort: 7317, localPort: d2.port, token: d2.token, createdAt: new Date().toISOString() }));

      const puppeteer = await import("puppeteer-core");
      const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
      try {
        const page = await browser.newPage();
        const failed: string[] = [];
        page.on("pageerror", (e) => failed.push(String(e)));
        await page.goto(`${WEB_ORIGIN}/t/PLEN-7`, { waitUntil: "networkidle0" });
        await page.waitForFunction(() => document.body.innerText.includes("mac-tab"), { timeout: 15_000 });
        // In the app, as a sidebar click would: a client-side navigation to the other machine's task.
        await page.evaluate(() => (window as any).next.router.push("/m/second/t/PLEN-7"));
        await page
          .waitForFunction(() => location.pathname === "/m/second/t/PLEN-7" && document.body.innerText.includes("remote-tab"), { timeout: 15_000 })
          .catch(async (e) => {
            const at = await page.evaluate(() => ({ path: location.pathname, here: document.body.innerText.includes("mac-tab"), there: document.body.innerText.includes("remote-tab"), text: document.body.innerText.slice(0, 300) }));
            throw new Error(`after navigating: ${JSON.stringify(at)}; errors ${JSON.stringify(failed)}; ${e}`);
          });
        await Bun.sleep(1500);
        const text = await page.evaluate(() => document.body.innerText);
        expect(text).toContain("remote-tab");
        expect(text).not.toContain("mac-tab");
        expect(text).not.toContain("React error");
        expect(failed).toEqual([]);
      } finally {
        await browser.close();
      }
    } finally {
      await d2.stop();
      env2.cleanup();
    }
  },
  120_000,
);

test(
  "A17 @mentions in a chat: the picker offers a task while typing, and a sent mention shows as a chip that opens it",
  async () => {
    expect(built).toBe(true);
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      await page.goto(`${WEB_ORIGIN}/?chat=new`, { waitUntil: "networkidle0" });
      await page.click("textarea[aria-label=Message]");
      await page.keyboard.type("look at @PLEN", { delay: 30 });
      const option = await page.waitForSelector(".mention-option", { timeout: 15_000 });
      expect(await option!.evaluate((el) => el.textContent)).toContain("PLEN-7");
      await page.keyboard.press("Enter"); // takes the option, does not send
      expect(await page.$eval("textarea[aria-label=Message]", (el) => (el as HTMLTextAreaElement).value)).toBe("look at @PLEN-7 ");

      // Sent (here through the API): the mention resolves to the task and shows as a chip.
      const chat = await d.json<any>("/api/chats", { method: "POST", json: { kind: "jin", prompt: "what is left in @PLEN-7?" } });
      await page.goto(`${WEB_ORIGIN}/?chat=${chat.id}`, { waitUntil: "networkidle0" });
      const chip = await page.waitForSelector(".message.user .mention-chip a", { timeout: 15_000 });
      expect(await chip!.evaluate((el) => [el.textContent, el.getAttribute("href")])).toEqual(["PLEN-7", "/t/PLEN-7"]);
    } finally {
      await browser.close();
    }
  },
  120_000,
);
