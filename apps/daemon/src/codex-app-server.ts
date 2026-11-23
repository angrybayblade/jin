/**
 * A connection to `codex app-server` (JSON-RPC over stdio, one message per line), started
 * through the login shell so its PATH is the user's. jin uses it to trust its hooks and to run
 * Codex for chats and room agents: requests out, Codex's own requests in (approvals, which
 * jin answers), and notifications (what Codex is doing).
 */
export class CodexAppServer {
  private proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">>;
  private next = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private notified: ((method: string, params: any) => void)[] = [];
  private asked: ((method: string, params: any) => Promise<unknown>) | null = null;
  readonly closed: Promise<void>;

  constructor(flags: string[], env: Record<string, string> = {}) {
    const shell = process.env.SHELL || "/bin/bash";
    this.proc = Bun.spawn([shell, "-l", "-c", 'exec "$@"', "jin", "codex", "app-server", ...flags], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, ...env } });
    this.closed = this.read();
  }

  private async read() {
    let buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.handle(line);
      }
    }
    for (const w of this.waiting.values()) w.reject(new Error("Codex's app-server stopped"));
    this.waiting.clear();
  }

  private handle(line: string) {
    let msg: { id?: number; method?: string; params?: any; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && msg.method == null) {
      const w = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      if (msg.error) w?.reject(new Error(msg.error.message ?? "app-server error"));
      else w?.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id != null) {
      // Codex asks the client (an approval): answer it, or refuse what jin does not handle.
      const id = msg.id;
      const answer = this.asked ? this.asked(msg.method, msg.params) : Promise.reject(new Error(`jin does not handle ${msg.method}`));
      void answer.then(
        (result) => this.write({ id, result }),
        (err) => this.write({ id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } }),
      );
      return;
    }
    if (msg.method) for (const fn of this.notified) fn(msg.method, msg.params);
  }

  private write(m: unknown) {
    try {
      this.proc.stdin.write(JSON.stringify(m) + "\n");
      this.proc.stdin.flush();
    } catch {
      // it stopped; the read loop reports that
    }
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.next++;
      this.waiting.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write({ method, params });
  }

  onNotification(fn: (method: string, params: any) => void) {
    this.notified.push(fn);
  }

  /** How jin answers Codex's own requests (approvals); without it they are refused. */
  onRequest(fn: (method: string, params: any) => Promise<unknown>) {
    this.asked = fn;
  }

  async initialize() {
    await this.request("initialize", { clientInfo: { name: "jin", version: "1" } });
    this.notify("initialized");
  }

  close() {
    this.proc.kill();
  }
}
