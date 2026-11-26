import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { body, HttpError, json, type Router } from "./http";
import { defaultSpawn, PATH_LINE, type Proc, SSH_OPTS, type Spawn } from "./machines";

/**
 * Port forwards: a port on a remote machine, reached on this machine's loopback
 * (`localhost:<local>` → the machine's `localhost:<remote>`), over an ssh connection of its own
 * that reopens when it drops. Kept in $JIN_HOME/forwards.json, so they come back with jin.
 */
export interface Forward {
  id: string;
  machine: string;
  remotePort: number;
  localPort: number;
  /** What it is, when you named it ("web", "storybook"). */
  label: string | null;
  createdAt: string;
}

export interface ForwardView extends Forward {
  state: "up" | "connecting" | "down";
  /** Why it is down (the local port taken, the machine unreachable). */
  error: string | null;
}

/** A port something listens on, on the machine. */
export interface Listening {
  port: number;
  /** Only on the machine's loopback (127.0.0.1, ::1), or on every address. */
  loopback: boolean;
  process: string | null;
  /** The folder it runs in, when the machine says (Linux, your own processes). */
  folder: string | null;
}

/** Where ssh reaches a machine, and the ports jin itself uses there (never offered). */
export type MachineLine = { host: string; reserved: number[] } | null;

interface Live {
  proc: Proc | null;
  state: ForwardView["state"];
  error: string | null;
  stopped: boolean;
  backoff: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const validPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536;

/** What `ss -ltnpH` (or `lsof` on a Mac) says listens on the machine; ports below 1024 and jin's own are left out. */
export function readListening(out: string, reserved: number[] = []): Listening[] {
  const cwd = new Map<string, string>();
  for (const l of out.split("\n")) {
    const m = l.match(/^JIN-CWD (\d+) (.+)$/);
    if (m) cwd.set(m[1]!, m[2]!.trim());
  }
  const byPort = new Map<number, Listening>();
  for (const raw of out.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("JIN-CWD")) continue;
    let addr: string | undefined;
    let proc: string | null = null;
    let pid: string | null = null;
    const ss = l.match(/^LISTEN\s+\d+\s+\d+\s+(\S+)\s+\S+(?:\s+(.*))?$/);
    if (ss) {
      addr = ss[1];
      proc = ss[2]?.match(/\("([^"]+)",pid=(\d+)/)?.[1] ?? null;
      pid = ss[2]?.match(/pid=(\d+)/)?.[1] ?? null;
    } else {
      // lsof: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (LISTEN)
      const ls = l.match(/^(\S+)\s+(\d+)\s+.*\sTCP\s+(\S+)\s+\(LISTEN\)$/);
      if (!ls) continue;
      proc = ls[1]!.replace(/\\x20/g, " ");
      pid = ls[2]!;
      addr = ls[3];
    }
    const at = addr?.lastIndexOf(":") ?? -1;
    if (!addr || at < 0) continue;
    const port = Number(addr.slice(at + 1));
    const host = addr.slice(0, at).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    if (!validPort(port) || port < 1024 || reserved.includes(port)) continue;
    const loopback = /^(127\.|::1$|::ffff:127\.|localhost$)/.test(host);
    const folder = pid ? (cwd.get(pid) ?? null) : null;
    const prev = byPort.get(port);
    byPort.set(port, {
      port,
      loopback: prev ? prev.loopback && loopback : loopback,
      process: prev?.process ?? proc,
      folder: prev?.folder ?? folder,
    });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** Lists listening TCP ports, and each listener's folder (Linux /proc) so a dev server shows which repo it serves. */
export const LISTENING_SCRIPT = `${PATH_LINE}
if command -v ss >/dev/null 2>&1; then
  L=$(ss -ltnpH 2>/dev/null); echo "$L"
  for p in $(echo "$L" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do echo "JIN-CWD $p $(readlink /proc/$p/cwd 2>/dev/null)"; done
else
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | tail -n +2
fi
`;

export class Forwards {
  private file: string;
  private live = new Map<string, Live>();

  constructor(
    home: string,
    /** The machine's ssh host, or null when this jin cannot reach it over ssh (not set up, or attached to us). */
    private line: (machine: string) => MachineLine,
    private spawn: Spawn = defaultSpawn,
    /** Whether a port is free on this machine's loopback. */
    private isFree: (port: number) => Promise<boolean> = portFree,
  ) {
    this.file = join(home, "forwards.json");
  }

  private load(): Forward[] {
    try {
      return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Forward[]) : [];
    } catch {
      return [];
    }
  }

  private save(all: Forward[]) {
    writeFileSync(this.file, JSON.stringify(all, null, 2));
  }

  list(machine?: string): ForwardView[] {
    return this.load()
      .filter((f) => !machine || f.machine === machine)
      .sort((a, b) => a.remotePort - b.remotePort)
      .map((f) => {
        const l = this.live.get(f.id);
        return { ...f, state: l?.state ?? "down", error: l?.error ?? null };
      });
  }

  /** Forward a port of the machine: to the same port here when it is free, else to `localPort` or any free one. */
  async add(machine: string, o: { remotePort: number; localPort?: number | null; label?: string | null }): Promise<ForwardView> {
    const line = this.line(machine);
    if (!line) throw new HttpError(409, "jin reaches this machine without ssh of its own, so it cannot forward its ports");
    if (!validPort(o.remotePort)) throw new HttpError(400, "the machine's port is a number from 1 to 65535");
    if (line.reserved.includes(o.remotePort)) throw new HttpError(400, `port ${o.remotePort} is jin's own there; it is already reached through jin's tunnel`);
    const all = this.load();
    if (all.some((f) => f.machine === machine && f.remotePort === o.remotePort)) throw new HttpError(409, `port ${o.remotePort} is already forwarded`);
    const taken = async (p: number) => all.some((f) => f.localPort === p) || !(await this.isFree(p));
    let localPort: number;
    if (o.localPort != null) {
      if (!validPort(o.localPort) || o.localPort < 1024) throw new HttpError(400, "the port here is a number from 1024 to 65535");
      if (await taken(o.localPort)) throw new HttpError(409, `port ${o.localPort} is taken on this machine; pick another, or leave it empty for any free one`);
      localPort = o.localPort;
    } else if (o.remotePort >= 1024 && !(await taken(o.remotePort))) localPort = o.remotePort;
    else {
      localPort = 0;
      for (let p = Math.max(o.remotePort, 1024) + 1; p < 65536 && !localPort; p++) if (!(await taken(p))) localPort = p;
      if (!localPort) throw new HttpError(409, "no free port on this machine");
    }
    const label = o.label?.trim().slice(0, 60) || null;
    const f: Forward = { id: `${machine}-${o.remotePort}`, machine, remotePort: o.remotePort, localPort, label, createdAt: new Date().toISOString() };
    this.save([...all, f]);
    this.open(f);
    return this.list(machine).find((x) => x.id === f.id)!;
  }

  remove(id: string) {
    const all = this.load();
    if (!all.some((f) => f.id === id)) throw new HttpError(404, `no forward ${id}`);
    this.close(id);
    this.save(all.filter((f) => f.id !== id));
  }

  /** A machine forgotten: its forwards go with it. */
  forget(machine: string) {
    const all = this.load();
    for (const f of all) if (f.machine === machine) this.close(f.id);
    this.save(all.filter((f) => f.machine !== machine));
  }

  /** Reopen every forward (at start). One whose machine cannot be reached yet keeps trying. */
  resume() {
    for (const f of this.load()) this.open(f);
  }

  stopAll() {
    for (const id of [...this.live.keys()]) this.close(id);
  }

  /** What listens on the machine, minus jin's own ports. */
  async listening(machine: string): Promise<Listening[]> {
    const line = this.line(machine);
    if (!line) throw new HttpError(409, "jin reaches this machine without ssh of its own");
    const proc = this.spawn(["ssh", ...SSH_OPTS, line.host, "bash -s"], { stdin: new Blob([LISTENING_SCRIPT]) });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0 && !out.trim()) throw new HttpError(502, "could not ask the machine what listens on it");
    return readListening(out, line.reserved);
  }

  private open(f: Forward) {
    const l: Live = this.live.get(f.id) ?? { proc: null, state: "connecting", error: null, stopped: false, backoff: 1000, timer: null };
    this.live.set(f.id, l);
    if (l.proc || l.stopped) return;
    const line = this.line(f.machine);
    if (!line) {
      l.state = "down";
      l.error = "the machine is not reachable over ssh from here yet";
      l.timer = setTimeout(() => (l.timer = null, this.open(f)), 30_000);
      return;
    }
    l.state = "connecting";
    // `localhost` on both ends: loopback only (both 127.0.0.1 and ::1, as a browser may try either),
    // and a dev server there listening only on ::1 is reached as well as one on 127.0.0.1.
    const proc = this.spawn(["ssh", ...SSH_OPTS, "-N", "-o", "ExitOnForwardFailure=yes", "-L", `localhost:${f.localPort}:localhost:${f.remotePort}`, line.host]);
    l.proc = proc;
    const err = new Response(proc.stderr).text().catch(() => "");
    // Still running after a moment: the local end is bound and the line is up.
    const settled = setTimeout(() => {
      if (l.proc !== proc) return;
      l.state = "up";
      l.error = null;
      l.backoff = 1000;
    }, 2500);
    void proc.exited.then(async (code) => {
      clearTimeout(settled);
      if (l.proc !== proc) return;
      l.proc = null;
      l.state = "down";
      if (l.stopped) return;
      const why = (await err).trim();
      if (/address already in use|cannot listen to port|bind/i.test(why)) {
        // Something else took the port here: retrying will not help until it is freed.
        l.error = `port ${f.localPort} is taken on this machine; stop what uses it, or forward to another port`;
        l.timer = setTimeout(() => (l.timer = null, this.open(f)), 30_000);
        return;
      }
      l.error = why.split("\n").filter(Boolean).pop()?.slice(0, 200) || `ssh exited (${code})`;
      l.timer = setTimeout(() => (l.timer = null, this.open(f)), l.backoff);
      l.backoff = Math.min(l.backoff * 2, 30_000);
    });
  }

  private close(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    l.stopped = true;
    if (l.timer) clearTimeout(l.timer);
    l.proc?.kill();
    this.live.delete(id);
  }
}

/** Whether something answers on `host:port` (within half a second). */
function answers(hostname: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const t = setTimeout(() => done(false), 500);
    Bun.connect({ hostname, port, socket: { open: (s) => (clearTimeout(t), s.end(), done(true)), data: () => {}, error: () => (clearTimeout(t), done(false)), connectError: () => (clearTimeout(t), done(false)) } }).catch(() => (clearTimeout(t), done(false)));
  });
}

/** Whether nothing listens on `port` on this machine's loopback (either family, or on every address). */
export async function portFree(port: number): Promise<boolean> {
  if ((await answers("127.0.0.1", port)) || (await answers("::1", port))) return false;
  try {
    const s = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

export function forwardRoutes(router: Router, forwards: Forwards) {
  router
    .on("GET", "/api/machines/:id/forwards", (_req, p) => json(forwards.list(p.id!)))
    .on("POST", "/api/machines/:id/forwards", async (req, p) => {
      const b = await body<{ remotePort?: number; localPort?: number | null; label?: string | null }>(req);
      return json(await forwards.add(p.id!, { remotePort: Number(b.remotePort), localPort: b.localPort == null || (b.localPort as unknown) === "" ? null : Number(b.localPort), label: b.label }), 201);
    })
    .on("DELETE", "/api/machines/:id/forwards/:port", (_req, p) => {
      forwards.remove(`${p.id}-${p.port}`);
      return json(forwards.list(p.id!));
    })
    .on("GET", "/api/machines/:id/listening", async (_req, p) => json(await forwards.listening(p.id!)));
}
