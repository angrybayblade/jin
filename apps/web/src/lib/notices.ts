"use client";
/**
 * Notices: the one place an action that failed (or needs a word) says so, bottom right. An
 * action's own inline error (a form field, a panel) stays where it is; this is for the rest:
 * a menu item, a button with no room to speak, a promise nobody awaited.
 */

export interface Notice {
  id: number;
  tone: "error" | "info";
  /** One line: what failed. */
  text: string;
  /** The error itself, when it adds something (shown under, copyable). */
  detail?: string;
  /** Try it again. */
  retry?: () => void | Promise<unknown>;
}

type Listener = (list: Notice[]) => void;
let list: Notice[] = [];
let n = 0;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l(list));

export function subscribeNotices(l: Listener): () => void {
  listeners.add(l);
  l(list);
  return () => listeners.delete(l);
}

export function dismissNotice(id: number) {
  list = list.filter((x) => x.id !== id);
  emit();
}

/** Show a notice; errors stay until dismissed (or retried), others go after a few seconds. */
export function notice(tone: Notice["tone"], text: string, opts: { detail?: string; retry?: Notice["retry"] } = {}): number {
  // The same failure again replaces the earlier one rather than stacking.
  const same = list.find((x) => x.text === text && x.tone === tone);
  if (same) dismissNotice(same.id);
  const id = ++n;
  list = [...list.slice(-4), { id, tone, text, ...opts }];
  emit();
  if (tone !== "error") setTimeout(() => dismissNotice(id), 5000);
  return id;
}

/** What an error says, without the transport's prefix ("POST /api/...: "). */
export function messageOf(err: unknown): string {
  const m = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  // A server action that threw: in production Next keeps the reason in the server's log only.
  if (/An error occurred in the Server Components render|omitted in production/i.test(m)) return "jin's web server hit an error; ~/.jin/logs/web.log has the reason";
  return m.replace(/^(GET|POST|PUT|PATCH|DELETE) \S+: /, "").trim() || "something went wrong";
}

/**
 * Run an action and say so if it fails: a thrown error, or a server action's `{ error }`.
 * `what` names it for the notice ("Couldn't archive the task"). Resolves to the result, or null.
 */
export async function act<T>(what: string, run: () => Promise<T>, opts: { retry?: boolean } = {}): Promise<Exclude<T, { error: string }> | null> {
  const again = opts.retry === false ? undefined : () => act(what, run, opts);
  try {
    const r = await run();
    if (r && typeof r === "object" && "error" in r && typeof (r as { error: unknown }).error === "string") {
      notice("error", what, { detail: (r as { error: string }).error, retry: again });
      return null;
    }
    return r as Exclude<T, { error: string }>;
  } catch (err) {
    notice("error", what, { detail: messageOf(err), retry: again });
    return null;
  }
}
