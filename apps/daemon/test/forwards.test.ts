import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Forwards, readListening } from "../src/forwards";
import type { Proc, Spawn } from "../src/machines";

test("reads what listens on a Linux machine, with each listener's folder", () => {
  const out = [
    'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("next-server",pid=4242,fd=21))',
    'LISTEN 0 511 [::1]:3000 [::]:* users:(("next-server",pid=4242,fd=22))',
    'LISTEN 0 128 0.0.0.0:5432 0.0.0.0:*',
    'LISTEN 0 128 [::]:22 [::]:*',
    'LISTEN 0 511 127.0.0.1:7317 0.0.0.0:* users:(("bun",pid=99,fd=9))',
    'LISTEN 0 511 *:8080 *:* users:(("python3",pid=77,fd=3))',
    "JIN-CWD 4242 /home/me/repos/apollo",
    "JIN-CWD 99 /home/me/.jin/app",
    "JIN-CWD 77 ",
  ].join("\n");
  expect(readListening(out, [7317])).toEqual([
    { port: 3000, loopback: true, process: "next-server", folder: "/home/me/repos/apollo" },
    { port: 5432, loopback: false, process: null, folder: null },
    { port: 8080, loopback: false, process: "python3", folder: null },
  ]);
});

test("reads what listens on a Mac (lsof)", () => {
  const out = ["node      812 me   23u  IPv6 0xabc      0t0  TCP [::1]:5173 (LISTEN)", "Google\\x20 900 me   40u  IPv4 0xdef      0t0  TCP *:9222 (LISTEN)"].join("\n");
  expect(readListening(out)).toEqual([
    { port: 5173, loopback: true, process: "node", folder: null },
    { port: 9222, loopback: false, process: "Google ", folder: null },
  ]);
});

function fakeSsh() {
  const calls: { cmd: string[]; proc: Proc & { exit(code: number, err?: string): void } }[] = [];
  const spawn: Spawn = (cmd) => {
    let exit!: (c: number) => void;
    let errCtl!: ReadableStreamDefaultController<Uint8Array>;
    const exited = new Promise<number>((r) => (exit = r));
    const proc = {
      stdin: null,
      stdout: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      stderr: new ReadableStream<Uint8Array>({ start: (c) => (errCtl = c) }),
      exited,
      kill: () => (errCtl.close(), exit(143)),
      exit: (code: number, err = "") => {
        if (err) errCtl.enqueue(new TextEncoder().encode(err));
        errCtl.close();
        exit(code);
      },
    };
    calls.push({ cmd, proc });
    return proc;
  };
  return { calls, spawn };
}

const machine = { host: "me@dev-box", reserved: [7317] };

test("forwards a port to the same one here when free, else the next free one; refuses jin's own and twice", async () => {
  const home = mkdtempSync(join(tmpdir(), "jin-fwd-"));
  const busy = new Set([5432]);
  const { calls, spawn } = fakeSsh();
  const f = new Forwards(home, (id) => (id === "dev-box" ? machine : null), spawn, async (p) => !busy.has(p));
  const web = await f.add("dev-box", { remotePort: 3000, label: " web " });
  expect(web).toMatchObject({ id: "dev-box-3000", localPort: 3000, label: "web", state: "connecting" });
  expect(calls[0]!.cmd).toContain("localhost:3000:localhost:3000");
  expect(calls[0]!.cmd.at(-1)).toBe("me@dev-box");
  expect((await f.add("dev-box", { remotePort: 5432 })).localPort).toBe(5433);
  await expect(f.add("dev-box", { remotePort: 9000, localPort: 5432 })).rejects.toThrow("taken on this machine");
  expect((await f.add("dev-box", { remotePort: 80 })).localPort).toBe(1025); // below 1024 here needs root
  await expect(f.add("dev-box", { remotePort: 3000 })).rejects.toThrow("already forwarded");
  await expect(f.add("dev-box", { remotePort: 7317 })).rejects.toThrow("jin's own");
  await expect(f.add("attached-mac", { remotePort: 3000 })).rejects.toThrow("without ssh");
  // Kept across restarts.
  expect((JSON.parse(readFileSync(join(home, "forwards.json"), "utf8")) as { id: string }[]).map((x) => x.id)).toEqual(["dev-box-3000", "dev-box-5432", "dev-box-80"]);
  f.remove("dev-box-3000");
  expect(f.list("dev-box").map((x) => x.remotePort)).toEqual([80, 5432]);
  f.forget("dev-box");
  expect(f.list()).toEqual([]);
  f.stopAll();
});

test("a forward that drops says why and reopens; one whose port here is taken waits", async () => {
  const home = mkdtempSync(join(tmpdir(), "jin-fwd-"));
  const { calls, spawn } = fakeSsh();
  const f = new Forwards(home, () => machine, spawn, async () => true);
  await f.add("dev-box", { remotePort: 3000 });
  calls[0]!.proc.exit(255, "Connection to dev-box closed by remote host.\n");
  await Bun.sleep(20);
  expect(f.list()[0]).toMatchObject({ state: "down", error: "Connection to dev-box closed by remote host." });
  await Bun.sleep(1100);
  expect(calls.length).toBe(2); // reopened after a second
  calls[1]!.proc.exit(255, "bind [127.0.0.1]:3000: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 3000\n");
  await Bun.sleep(20);
  expect(f.list()[0]!.error).toContain("port 3000 is taken on this machine");
  f.stopAll();
});
