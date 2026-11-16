// A23: live events through Composio. A fake `composio` stands in for the CLI (its state in a
// folder; `dev listen` emits whatever the test appends to a file), so the whole path runs:
// choose a project, switch an event on (its trigger is made), the listener runs, a DM lands in
// the feed and notifies, channel chatter without a mention does not, and switching off works.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupEnv, startDaemon, until, type Daemon, type Env as TestEnv } from "./helpers";

let env: TestEnv;
let d: Daemon;
let state: string;

const FAKE_COMPOSIO = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const S = process.env.FAKE_COMPOSIO_STATE;
const triggersFile = S + "/triggers.json";
const triggers = () => (existsSync(triggersFile) ? JSON.parse(readFileSync(triggersFile, "utf8")) : []);
const save = (t) => writeFileSync(triggersFile, JSON.stringify(t));
const a = process.argv.slice(2);
const out = (o) => console.log(JSON.stringify(o));
appendFileSync(S + "/calls.log", a.join(" ") + "\\n");
const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const [c1, c2, c3, c4] = a;
if (c1 === "whoami") out({ email: "me@example.com", current_org_name: "personal" });
else if (c1 === "login" && a.includes("--no-wait")) console.log("Open this URL in your browser to log in:\\n\\n  https://dashboard.composio.dev/?cliKey=fake\\n");
else if (c1 === "login") process.exit(0);
else if (c1 === "orgs" && c2 === "list") out([{ id: "org1", name: "personal" }]);
else if (c1 === "orgs" && c2 === "switch") out({ org_id: flag("--org-id") });
else if (c1 === "dev" && c2 === "projects") out([{ id: "pr_jin", name: "jin" }]);
else if (c1 === "dev" && c2 === "connected-accounts" && c3 === "list") out(["slack", "linear", "notion", "gmail", "github"].map((t) => ({ id: "ca_" + t, toolkit_slug: t, status: "ACTIVE" })));
else if (c1 === "dev" && c2 === "connected-accounts" && c3 === "link") console.log("https://connect.composio.dev/link/lk_" + c4);
else if (c1 === "dev" && c2 === "triggers" && c3 === "status") out(triggers());
else if (c1 === "dev" && c2 === "triggers" && c3 === "create") {
  const t = triggers();
  const id = "ti_" + (t.length + 1);
  t.push({ id, trigger_name: c4, toolkit_slug: c4.split("_")[0].toLowerCase(), connected_account_id: flag("--connected-account-id"), status: "ACTIVE", disabled_at: null, trigger_data: JSON.stringify(flag("--trigger-config")) });
  save(t);
  out({ id });
} else if (c1 === "dev" && c2 === "triggers" && (c3 === "disable" || c3 === "enable")) {
  save(triggers().map((t) => (t.id === c4 ? { ...t, status: c3 === "disable" ? "DISABLED" : "ACTIVE", disabled_at: c3 === "disable" ? "now" : null } : t)));
  out({ ok: true });
} else if (c1 === "dev" && c2 === "playground-execute") {
  if (c3 === "SLACK_TEST_AUTH") out({ successful: true, data: { user_id: "U_ME" } });
  else if (c3 === "LINEAR_GET_CURRENT_USER") out({ successful: true, data: { user: { id: "lin-me", email: "me@example.com" } } });
  else if (c3 === "LINEAR_LIST_LINEAR_TEAMS") out({ successful: true, data: { teams: [{ id: "team-1", name: "Platform" }] } });
  else process.exit(1);
} else if (c1 === "dev" && c2 === "listen") {
  // Like the real one: only in a folder bound to a developer project.
  if (!existsSync(process.cwd() + "/.composio/project.json")) { console.error("No developer project configured for this directory. Run \`composio dev init\`."); process.exit(1); }
  // Emit each line appended to the events file, as the real listener streams events.
  const f = S + "/events.jsonl";
  let sent = 0;
  for (;;) {
    const lines = existsSync(f) ? readFileSync(f, "utf8").split("\\n").filter(Boolean) : [];
    for (; sent < lines.length; sent++) console.log(lines[sent]);
    await Bun.sleep(150);
  }
} else { console.error("fake composio: unsupported: " + a.join(" ")); process.exit(1); }
`;

beforeAll(async () => {
  env = setupEnv();
  state = join(env.home, "..", "composio-state");
  mkdirSync(join(state, "config"), { recursive: true });
  writeFileSync(join(env.bin, "composio"), FAKE_COMPOSIO);
  chmodSync(join(env.bin, "composio"), 0o755);
  // The fake's own config folder: switching a trigger off allows it there, never in your ~/.composio.
  d = await startDaemon(env, { FAKE_COMPOSIO_STATE: state, JIN_COMPOSIO_BIN: join(env.bin, "composio"), JIN_COMPOSIO_CONFIG_DIR: join(state, "config") });
});
afterAll(async () => {
  await d.stop();
  env.cleanup();
});

const notices = () => (existsSync(join(env.home, "notifications.log")) ? readFileSync(join(env.home, "notifications.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("A23 live events: a project, an event switched on, a DM in the feed and a notification; chatter dropped; switched off", async () => {
  const start = await d.json("/api/composio");
  expect(start).toMatchObject({ installed: true, signedIn: true, project: null });
  expect((await d.json("/api/composio/login", { method: "POST" })).url).toBe("https://dashboard.composio.dev/?cliKey=fake");

  // Choose the project; every account shows connected.
  const projects = await d.json("/api/composio/projects");
  expect(projects).toEqual([{ orgId: "org1", org: "personal", projects: [{ id: "pr_jin", name: "jin" }] }]);
  const bound = await d.json("/api/composio/project", { method: "POST", json: { orgId: "org1", projectId: "pr_jin", name: "jin", userId: "viraj" } });
  expect(bound.project).toMatchObject({ name: "jin" });
  expect(bound.accounts.every((a: { status: string }) => a.status === "ACTIVE")).toBe(true);
  expect((await d.json("/api/composio/connect/notion", { method: "POST" })).url).toBe("https://connect.composio.dev/link/lk_notion");

  // Slack DMs and mentions on: their triggers are made, and the listener runs.
  await d.json("/api/composio/events/slack_dms", { method: "POST", json: { on: true } });
  const on = await d.json("/api/composio/events/slack_mentions", { method: "POST", json: { on: true } });
  expect(on.events.find((e: { kind: string }) => e.kind === "slack_dms")).toMatchObject({ on: true, triggers: 1 });
  await until(async () => (await d.json("/api/composio")).listener.state === "running", 10_000, "listener running");

  // Events arrive: a DM (for you), channel chatter (dropped), a mention of you (for you).
  const event = (o: unknown) => appendFileSync(join(state, "events.jsonl"), `${JSON.stringify(o)}\n`);
  event({ triggerSlug: "SLACK_DIRECT_MESSAGE_RECEIVED", id: "ev1", data: { text: "can you review today?", user: "U_ALEX", channel: "D1" } });
  event({ triggerSlug: "SLACK_CHANNEL_MESSAGE_RECEIVED", id: "ev2", data: { text: "deploy is green", user: "U_BOB", channel_type: "channel" } });
  event({ triggerSlug: "SLACK_CHANNEL_MESSAGE_RECEIVED", id: "ev3", data: { text: "<@U_ME> thoughts?", user: "U_BOB", channel_type: "channel" } });
  const recent = await until(async () => {
    const r = (await d.json("/api/composio")).recent as { id: string; title: string; forYou: boolean }[];
    return r.length >= 2 ? r : null;
  }, 10_000, "events received");
  expect(recent.map((e) => e.id).sort()).toEqual(["ev1", "ev3"]);
  const feed = (await d.json("/api/feed")) as { source: string; title: string }[];
  expect(feed.filter((f) => f.source === "slack").map((f) => f.title).sort()).toEqual(["Slack DM from U_ALEX", "Slack mention by U_BOB"]);
  await until(() => notices().some((n) => n.title === "Slack DM from U_ALEX"), 5_000, "notification");
  expect(notices().find((n) => n.title === "Slack DM from U_ALEX")).toMatchObject({ body: "can you review today?", path: "/c/slack" });

  // Linear needs teams; switching DMs off disables their trigger.
  expect((await d.json("/api/composio/linear-teams")) as unknown[]).toEqual([{ id: "team-1", name: "Platform", key: null }]);
  await d.json("/api/composio/events/linear", { method: "POST", json: { on: true, linearTeams: ["team-1"] } });
  const off = await d.json("/api/composio/events/slack_dms", { method: "POST", json: { on: false } });
  expect(off.events.find((e: { kind: string }) => e.kind === "slack_dms")).toMatchObject({ on: false, triggers: 0 });
  expect(off.events.find((e: { kind: string }) => e.kind === "linear")).toMatchObject({ on: true, triggers: 3 });
}, 60_000);
