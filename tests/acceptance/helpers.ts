// Black-box helpers for the v0 acceptance suite. They start the real daemon as a
// separate process and talk to it over HTTP/websockets only; nothing here imports
// jin's code. External programs (gh, cws) are fakes on PATH, so no test reaches
// the network, GitHub or a real workspace.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "../..");
// The suite's own web server: a port and build directory of its own, so it runs next to a dev server on 3917.
export const WEB_PORT = process.env.JIN_TEST_WEB_PORT ?? "3927";
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
export const WEB_DIST = ".next-acceptance";

export interface Env {
  home: string; // JIN_HOME
  workspace: string; // fixture composio-workspace root
  bin: string; // fake binaries, first on PATH
  cleanup(): void;
}

/** A fresh JIN_HOME with one composio workspace profile pointing at a fixture workspace. */
export function setupEnv(opts: { mode?: "local" | "vm" } = {}): Env {
  const base = mkdtempSync(join(tmpdir(), "jin-acc-"));
  const home = join(base, "home");
  const workspace = join(base, "composio-workspace");
  const bin = join(base, "bin");
  for (const d of [home, join(home, "workspaces"), workspace, join(workspace, "bin"), bin]) mkdirSync(d, { recursive: true });

  writeFileSync(join(home, "config.yaml"), `mode: ${opts.mode ?? "local"}\nwebOrigin: ${WEB_ORIGIN}\n`);
  writeFileSync(
    join(home, "workspaces", "composio.yaml"),
    [
      "id: composio",
      "adapter: composio",
      `root: ${workspace}`,
      "github:",
      "  owners: [ComposioHQ]",
      "profile:",
      `  claudeConfigDir: ${join(home, "profiles", "composio", "claude")}`,
      "",
    ].join("\n"),
  );

  // Fixture workspace: the files the composio adapter reads, and a fake cws.
  writeFileSync(
    join(workspace, "workspace.yaml"),
    [
      "repos:",
      "  platform:",
      "    description: Apollo, Thermos and shared packages",
      "    mode: work",
      "  mercury:",
      "    description: Tool execution runtime",
      "    mode: work",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(workspace, ".gitmodules"),
    [
      '[submodule "repos/platform"]',
      "\tpath = repos/platform",
      "\turl = git@github.com:ComposioHQ/platform.git",
      "\tbranch = master",
      '[submodule "repos/mercury"]',
      "\tpath = repos/mercury",
      "\turl = git@github.com:ComposioHQ/mercury.git",
      "\tbranch = master",
      "",
    ].join("\n"),
  );
  script(
    join(workspace, "bin", "cws"),
    `#!/bin/sh
root=$(cd "$(dirname "$0")/.." && pwd)
printf '%s\\n' "$*" >> "$root/cws.log"
if [ "$1" = task ] && [ "$2" = new ]; then
  id=$3; repos=""; title=""
  while [ $# -gt 0 ]; do [ "$1" = --repos ] && repos=$2; [ "$1" = --slug ] && title=$2; shift; done
  for r in $(echo "$repos" | tr ',' ' '); do mkdir -p "$root/tasks/$id/$r"; done
  # As cws does: the task's record, which jin lists the workspace's tasks from.
  mkdir -p "$root/tasks/$id"
  printf '{"id":"%s","title":"%s","repos":["%s"],"created":"%s"}\n' "$id" "$title" "$(echo "$repos" | sed 's/,/","/g')" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$root/tasks/$id/task.json"
  echo "created tasks/$id"
elif [ "$1" = task ] && [ "$2" = rm ]; then
  rm -rf "$root/tasks/$3"
fi
`,
  );

  // Fake gh: canned GraphQL for the collector, and a log of every call.
  writeFileSync(join(base, "gh-graphql.json"), JSON.stringify(GH_FIXTURE));
  script(
    join(bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${base}/gh.log"
if [ "$1" = api ] && [ "$2" = graphql ]; then cat "${base}/gh-graphql.json"; exit 0; fi
# A PR whose number is listed in gh-merged reads as merged.
if [ "$1" = pr ] && [ "$2" = view ]; then n=\${3##*/}; st=OPEN; grep -qx "$n" "${base}/gh-merged" 2>/dev/null && st=MERGED; printf '{"number":%s,"title":"PR %s","state":"%s","isDraft":false,"reviewDecision":"REVIEW_REQUIRED","statusCheckRollup":[{"conclusion":"SUCCESS"}],"headRefName":"fix/x"}' "$n" "$n" "$st"; exit 0; fi
echo "fake gh: unsupported: $*" >&2; exit 1
`,
  );

  return { home, workspace, bin, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function script(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

export interface Daemon {
  url: string;
  token: string;
  host: string;
  port: number;
  api(path: string, init?: RequestInit & { json?: unknown; noAuth?: boolean; origin?: string }): Promise<Response>;
  json<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>;
  stop(): Promise<void>;
}

/** Start the daemon (scripted agent harness) and wait for daemon.json. */
export async function startDaemon(env: Env, extra: Record<string, string> = {}): Promise<Daemon> {
  const info = join(env.home, "daemon.json");
  rmSync(info, { force: true });
  const proc = Bun.spawn(["bun", join(REPO, "apps/daemon/src/main.ts")], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${env.bin}:${process.env.PATH}`,
      JIN_HOME: env.home,
      JIN_PORT: "0",
      // Notifications go to a file, never to this machine's desktop.
      JIN_NOTIFY_LOG: join(env.home, "notifications.log"),
      JIN_HARNESS: "scripted",
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 15_000;
  while (!existsSync(info)) {
    if (proc.exitCode !== null || Date.now() > deadline) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`daemon did not start (exit ${proc.exitCode}): ${err.slice(-2000)}`);
    }
    await Bun.sleep(50);
  }
  const { host, port, token } = JSON.parse(readFileSync(info, "utf8"));
  const url = `http://${host}:${port}`;
  const api: Daemon["api"] = (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (!init.noAuth) headers.set("authorization", `Bearer ${token}`);
    if (init.origin) headers.set("origin", init.origin);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    return fetch(url + path, { ...init, headers, body });
  };
  const json: Daemon["json"] = async (path, init) => {
    const res = await api(path, init);
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  return {
    url,
    token,
    host,
    port,
    api,
    json,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

/** Wait until fn returns a truthy value. */
export async function until<T>(fn: () => Promise<T> | T, ms = 10_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** A prompt the scripted harness executes step by step, asking jin's policy before each tool call. */
export const scripted = (steps: ({ tool: string; input: Record<string, unknown> } | { text: string })[]) =>
  JSON.stringify({ script: steps });

const pr = (o: Partial<Record<string, unknown>> & { number: number; repo: string; title: string; ci?: string }) => ({
  __typename: "PullRequest",
  number: o.number,
  title: o.title,
  url: `https://github.com/${o.repo}/pull/${o.number}`,
  repository: { nameWithOwner: o.repo },
  updatedAt: "2026-11-15T09:00:00Z",
  commits: { nodes: o.ci ? [{ commit: { statusCheckRollup: { state: o.ci } } }] : [] },
});

/**
 * What `gh api graphql` returns for the collector's query. The collector asks for three
 * aliased searches: reviewRequested, authored (with the latest commit's check rollup)
 * and mentions.
 */
export const GH_FIXTURE = {
  data: {
    reviewRequested: {
      nodes: [
        pr({ number: 14310, repo: "ComposioHQ/platform", title: "Rate-limit tool router sessions" }),
        pr({ number: 77, repo: "OtherOrg/secret", title: "Not this organisation" }),
      ],
    },
    authored: {
      nodes: [
        pr({ number: 14298, repo: "ComposioHQ/platform", title: "Fix thermos webhook retries", ci: "FAILURE" }),
        pr({ number: 920, repo: "ComposioHQ/mercury", title: "Green PR", ci: "SUCCESS" }),
      ],
    },
    mentions: {
      nodes: [
        {
          __typename: "Issue",
          number: 3311,
          title: "Dashboard shows stale connection state",
          url: "https://github.com/ComposioHQ/dashboard/issues/3311",
          repository: { nameWithOwner: "ComposioHQ/dashboard" },
          updatedAt: "2026-11-15T08:00:00Z",
        },
      ],
    },
  },
};

/** Collector item titles that must (and must not) appear. */
export const EXPECTED_FEED = {
  present: ["Rate-limit tool router sessions", "Fix thermos webhook retries", "Dashboard shows stale connection state"],
  absent: ["Not this organisation", "Green PR"],
};

export function readLog(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

/**
 * A stand-in for ssh: options are skipped, -L and -R are forwarded here (both ends are this
 * computer), and the command runs with FAKE_SSH_HOME as HOME and none of jin's own variables.
 */
export const FAKE_SSH = `#!/usr/bin/env bun
// Stand-in ssh: options are skipped, -L is forwarded here, the command runs with the "remote" HOME.
const args = process.argv.slice(2);
let forward = null;
let reverse = null;
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-o") { i++; continue; }
  if (a === "-L") { forward = args[++i]; continue; }
  if (a === "-R") { reverse = args[++i]; continue; }
  if (a === "-tt" || a === "-N") continue;
  rest.push(a);
}
const [host, ...command] = rest;
// A real ssh starts a fresh login: none of this jin's own variables reach the far side.
// (except the test harness switches, so a daemon started there is scripted like this one)
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("JIN_") || k === "JIN_HARNESS" || k.startsWith("JIN_SCRIPTED")));
Object.assign(env, { HOME: process.env.FAKE_SSH_HOME, BUN_INSTALL_CACHE_DIR: process.env.REAL_BUN_CACHE });
const proxy = (listenPort, targetPort) => Bun.listen({
    hostname: "127.0.0.1",
    port: Number(listenPort),
    socket: {
      async open(client) {
        client.data = { queue: [] };
        client.data.upstream = await Bun.connect({ hostname: "127.0.0.1", port: Number(targetPort), socket: {
          data(_s, chunk) { client.write(chunk); },
          close() { client.end(); },
          error() { client.end(); },
        } }).catch(() => (client.end(), null));
        for (const c of client.data.queue) client.data.upstream?.write(c);
      },
      data(client, chunk) { client.data.upstream ? client.data.upstream.write(chunk) : client.data.queue.push(chunk); },
      close(client) { client.data.upstream?.end(); },
    },
  });
if (forward || reverse) {
  if (forward) { const [, l, , r] = forward.split(":"); proxy(l, r); }
  if (reverse) { const [, l, , r] = reverse.split(":"); proxy(l, r); }
  await new Promise(() => {});
}
if (!host) process.exit(255);
const proc = Bun.spawn(["bash", "-c", command.join(" ")], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await proc.exited);
`;
