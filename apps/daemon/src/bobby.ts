import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { body, HttpError, json, type Router } from "./http";

/**
 * Bobby (a focus-first PR reviewer, ~/bobby) as a companion app: jin links PRs to their review
 * in the Bobby running on this machine, starting it if needed. Reviews open in your browser;
 * Bobby forbids framing by design, and its page asks before building a PR it has never seen.
 */
const LOCK = join(homedir(), ".bobby", "state", "app.lock");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
};

/** The running Bobby's URL, found as Bobby finds itself: its lock, a live pid, and an answer on loopback. */
export async function runningBobby(): Promise<string | null> {
  let lock: { pid: number; port: number };
  try {
    lock = JSON.parse(readFileSync(LOCK, "utf8"));
  } catch {
    return null;
  }
  if (!lock?.port || !alive(lock.pid)) return null;
  const url = `http://127.0.0.1:${lock.port}`;
  // Bobby's avatar endpoint answers 400 to an empty user: a cheap "is this Bobby" probe (as Bobby's own running.ts does).
  const ok = await fetch(`${url}/api/avatar?u=`, { signal: AbortSignal.timeout(1500) }).then(
    (r) => r.status === 400,
    () => false,
  );
  return ok ? url : null;
}

function bobbyBinary(): string | null {
  const candidates = [process.env.BOBBY_BIN, join(homedir(), ".local", "bin", "bobby")].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  const which = Bun.which("bobby");
  return which ?? null;
}

/** The running Bobby, started in the background (`bobby start`) if it is not running. */
export async function ensureBobby(): Promise<string> {
  const running = await runningBobby();
  if (running) return running;
  const bin = bobbyBinary();
  if (!bin) throw new HttpError(404, "Bobby is not installed: curl -fsSL https://raw.githubusercontent.com/angrybayblade/bobby/main/install.sh | bash");
  const proc = Bun.spawn([bin, "start"], { stdout: "ignore", stderr: "pipe", env: process.env });
  const code = await proc.exited;
  if (code !== 0) throw new HttpError(502, `bobby start failed (${code}): ${(await new Response(proc.stderr).text()).trim().slice(-400)}`);
  for (let i = 0; i < 60; i++) {
    const url = await runningBobby();
    if (url) return url;
    await Bun.sleep(250);
  }
  throw new HttpError(504, "Bobby did not come up in 15s; see `bobby logs`");
}

/** Open a URL in the default browser on this machine. */
export async function openInBrowser(url: string, run = (cmd: string[]) => Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).exited) {
  const code = await run([process.platform === "darwin" ? "open" : "xdg-open", url]);
  if (code !== 0) throw new HttpError(502, `could not open a browser for ${url}`);
}

/** owner/repo/number of a GitHub pull request URL. */
export function parsePr(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
}

export function bobbyRoutes(router: Router) {
  router
    .on("GET", "/api/bobby", async () => json({ installed: Boolean(bobbyBinary()), url: await runningBobby() }))
    .on("POST", "/api/bobby/open", async (req) => {
      const { pr, browser } = await body<{ pr?: string; browser?: boolean }>(req);
      const parsed = pr ? parsePr(pr) : null;
      if (!parsed) throw new HttpError(400, "pr must be a GitHub pull request URL");
      const base = await ensureBobby();
      // Bobby's review page: it reopens a review seen before and asks before building a new one.
      const url = `${base}/r/${parsed.owner}/${parsed.repo}/${parsed.number}`;
      // In your default browser, from here: jin's desktop window cannot open one itself.
      if (browser) await openInBrowser(url);
      return json({ url });
    });
}
