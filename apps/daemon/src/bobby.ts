import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { body, HttpError, json, type Router } from "./http";

/**
 * Bobby (a focus-first PR reviewer, ~/bobby) as a companion app: jin links PRs to their review
 * in the Bobby running on this machine, starting it if needed. Bobby forbids framing by design;
 * jin starts it naming jin's own origins in BOBBY_FRAME_ANCESTORS (a Bobby that knows the setting
 * lets just those frame it), and shows a review inside a task tab only when the running Bobby
 * says it may. Otherwise reviews open in Bobby's own browser tab.
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
export async function ensureBobby(framers: string[] = []): Promise<string> {
  const running = await runningBobby();
  if (running) return running;
  const bin = bobbyBinary();
  if (!bin) throw new HttpError(404, "Bobby is not installed: curl -fsSL https://raw.githubusercontent.com/angrybayblade/bobby/main/install.sh | bash");
  const env = { ...process.env, ...(framers.length ? { BOBBY_FRAME_ANCESTORS: framers.join(" ") } : {}) };
  const proc = Bun.spawn([bin, "start"], { stdout: "ignore", stderr: "pipe", env });
  const code = await proc.exited;
  if (code !== 0) throw new HttpError(502, `bobby start failed (${code}): ${(await new Response(proc.stderr).text()).trim().slice(-400)}`);
  for (let i = 0; i < 60; i++) {
    const url = await runningBobby();
    if (url) return url;
    await Bun.sleep(250);
  }
  throw new HttpError(504, "Bobby did not come up in 15s; see `bobby logs`");
}

/** owner/repo/number of a GitHub pull request URL. */
export function parsePr(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
}

/** Whether a page's headers let `origin` frame it (CSP frame-ancestors decides; X-Frame-Options alone forbids). */
export function framesAllowed(headers: Headers, origins: string[]): boolean {
  const csp = headers.get("content-security-policy") ?? "";
  const rule = csp.split(";").map((d) => d.trim()).find((d) => d.toLowerCase().startsWith("frame-ancestors"));
  if (!rule) return !headers.get("x-frame-options");
  const allowed = rule.split(/\s+/).slice(1);
  return origins.some((o) => allowed.includes(o) || allowed.includes("*"));
}

export function bobbyRoutes(router: Router, webOrigins: string[] = []) {
  const reviewUrl = async (pr: string | undefined) => {
    const parsed = pr ? parsePr(pr) : null;
    if (!parsed) throw new HttpError(400, "pr must be a GitHub pull request URL");
    const base = await ensureBobby(webOrigins);
    // Bobby's review page: it reopens a review seen before and asks before building a new one.
    return { base, url: `${base}/r/${parsed.owner}/${parsed.repo}/${parsed.number}` };
  };
  router
    // For a task tab: the review's URL, and whether this Bobby lets jin's page frame it.
    .on("POST", "/api/bobby/embed", async (req) => {
      const { pr } = await body<{ pr?: string }>(req);
      const { base, url } = await reviewUrl(pr);
      const head = await fetch(`${base}/`, { method: "HEAD", signal: AbortSignal.timeout(2000) }).catch(() => null);
      return json({ url, embeddable: head ? framesAllowed(head.headers, webOrigins) : false });
    })
    .on("GET", "/api/bobby", async () => json({ installed: Boolean(bobbyBinary()), url: await runningBobby() }))
    .on("POST", "/api/bobby/open", async (req) => {
      const { pr } = await body<{ pr?: string }>(req);
      return json({ url: (await reviewUrl(pr)).url });
    });
}
