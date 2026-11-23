// Smoke checks in WebKit (the engine of jin's desktop window): the pages load and the main
// flows work, with no page error and nothing wider than the window. Run by the acceptance
// suite (tests/acceptance/web.test.ts) against a built app and a daemon with a stand-in for Claude.
//   ORIGIN=http://127.0.0.1:3927 TASK=PLEN-7 DOC=<doc id> node tests/smoke/webkit.mjs
import { webkit } from "playwright-core";

const { ORIGIN, TASK, DOC } = process.env;
if (!ORIGIN || !TASK || !DOC) throw new Error("ORIGIN, TASK and DOC are required");

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const failures = [];
const browser = await webkit.launch();

/** One page in a fresh window: it loads without an error, fits its window, and passes its own check. */
async function visit(name, path, { viewport = DESKTOP, layout, check, allowError = false } = {}) {
  const context = await browser.newContext({ viewport });
  if (layout) await context.addInitScript((l) => localStorage.setItem("jin-layout", JSON.stringify(l)), layout);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  const fail = (why) => failures.push(`${name}: ${why}`);
  try {
    await page.goto(ORIGIN + path, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(1200);
    const text = await page.evaluate(() => document.body.innerText);
    if (!allowError && /couldn.t load|Application error|React error/i.test(text)) fail("the error page is showing");
    await check?.(page, fail);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 1) fail(`the page is ${wide}px wider than the window`);
    for (const e of errors) fail(`page error: ${e}`);
  } catch (err) {
    fail(String(err).split("\n")[0].slice(0, 300));
  } finally {
    await context.close();
  }
  console.log(`${failures.some((f) => f.startsWith(`${name}:`)) ? "FAIL" : "ok  "} ${name}`);
}

const count = (page, selector) => page.locator(selector).count();

await visit("home", "/", {
  check: async (page, fail) => {
    if (!(await page.locator(".sidebar a.nav-item.task", { hasText: TASK }).count())) fail(`the sidebar does not list ${TASK}`);
  },
});

await visit("task page: every side panel", `/t/${TASK}`, {
  check: async (page, fail) => {
    await page.locator(".task-tabs").waitFor({ timeout: 20_000 });
    for (const panel of ["Journal", "Activity", "Files"]) {
      await page.locator(`.side-switch [aria-label="${panel}"]`).click();
      await page.waitForTimeout(600);
      if (!(await count(page, ".task-side"))) fail(`the ${panel} panel did not show`);
      if (/couldn.t load/i.test(await page.evaluate(() => document.body.innerText))) fail(`the ${panel} panel broke the page`);
    }
  },
});

await visit("task page: the agent room", `/t/${TASK}`, {
  check: async (page, fail) => {
    await page.locator(".task-tabs .term-tab", { hasText: "Room" }).click();
    await page.locator(".room-agent").first().waitFor({ timeout: 20_000 });
    if ((await count(page, ".room-agent")) !== 3) fail("the room does not start with three agents");
    if (!(await page.locator(".room-msg", { hasText: "smoke reply" }).count())) fail("the agent's reply is not in the room");
    await page.locator(".room-composer textarea").fill("@");
    await page.locator(".room-composer textarea").dispatchEvent("input");
    await page.locator(".room-pick button").first().waitFor({ timeout: 5_000 }).catch(() => fail("typing @ offers no agents"));
  },
});

await visit("collapsed sidebar", `/t/${TASK}`, {
  layout: { sidebarCollapsed: true },
  check: async (page, fail) => {
    const width = await page.locator(".sidebar").evaluate((el) => el.getBoundingClientRect().width);
    if (width > 80) fail(`the collapsed sidebar is ${Math.round(width)}px wide`);
    const centers = await page.locator(".sidebar .nav-item, .sidebar-bottom button").evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width).map((e) => Math.round(e.getBoundingClientRect().left + e.getBoundingClientRect().width / 2)));
    if (new Set(centers).size > 1) fail(`its items are not in one column: ${[...new Set(centers)].join(", ")}`);
    await page.locator(".sidebar .nav-item.task").first().hover();
    await page.locator(".rail-tip").waitFor({ timeout: 5_000 }).catch(() => fail("hovering an item shows no name"));
  },
});

await visit("new task form", "/", {
  check: async (page, fail) => {
    await page.locator('.nav-section button[aria-label="New task"]').click();
    await page.locator("dialog[open]").waitFor({ timeout: 10_000 });
    if (!(await count(page, 'dialog [aria-label="Start with"] button'))) fail("no choice of where the task starts");
    // The repos load after the form opens.
    await page.locator("dialog .repo-option").first().waitFor({ timeout: 10_000 }).catch(() => fail("no repos to pick"));
  },
});

await visit("docs library", "/docs", {
  check: async (page, fail) => {
    if (!(await page.locator(".docs-row", { hasText: "Smoke spec" }).count())) fail("the doc is not listed");
  },
});
await visit("a doc", `/docs/${DOC}`, {
  check: async (page, fail) => {
    await page.locator(".ProseMirror").waitFor({ timeout: 20_000 }).catch(() => fail("the editor did not load"));
  },
});

for (const path of ["/desk", "/machines", "/machines?m=local", "/hooks", "/skills", "/notifications", "/problems", "/setup"]) await visit(path, path);

// A task that is not there: the page says so inside the app (the sidebar stays), not a blank error.
await visit("a task that is not there", "/t/NOPE-404", {
  allowError: true,
  check: async (page, fail) => {
    if (!(await count(page, ".sidebar"))) fail("the sidebar is gone");
    if (!(await count(page, ".page-error, .error-view"))) fail("no error view");
  },
});

await visit("phone: home", "/", { viewport: PHONE });
await visit("phone: task", `/t/${TASK}`, { viewport: PHONE });

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nsmoke: all pages pass in WebKit");
