import { HttpError, json, type Router } from "./http";

/**
 * What one page shows, in one call. The app reaches the home (and other machines) through an SSH
 * tunnel, where every call is a round trip; a page that asked for its chat list and then that
 * chat's events paid two. Each view composes the same routes the app would call, in-process.
 */
export function viewRoutes(router: Router) {
  const get = async <T>(path: string): Promise<T> => {
    const url = new URL(path, "http://jin.local");
    const m = router.match("GET", url.pathname);
    if (!m) throw new HttpError(404, `not found: ${url.pathname}`);
    const res = await m.handler(new Request(url), m.params, url);
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new HttpError(res.status, body?.error ?? `${url.pathname} failed`);
    return body;
  };
  const enc = encodeURIComponent;

  router
    // A chat page (jin's, the desk's): its chats, what waits for approval, the open one and its events;
    // with `feed`, the feed items in those states too (the desk's activity).
    .on("GET", "/api/views/chat", async (_req, _p, url) => {
      const kind = url.searchParams.get("kind") ?? "jin";
      const want = url.searchParams.get("chat");
      const feed = url.searchParams.get("feed");
      const [sessions, approvals, items] = await Promise.all([
        get<{ id: string }[]>(`/api/sessions?kind=${enc(kind)}`),
        get<unknown[]>("/api/approvals?state=pending"),
        feed ? get<unknown[]>(`/api/feed?state=${enc(feed)}`) : undefined,
      ]);
      const session = want === "new" ? null : (sessions.find((s) => s.id === want) ?? sessions[0] ?? null);
      const events = session ? await get<unknown[]>(`/api/sessions/${enc(session.id)}/events`) : [];
      return json({ sessions, approvals, session, events, ...(items ? { feed: items } : {}) });
    })
    // A doc, with its chat with jin (null when it has none, or it cannot be read).
    .on("GET", "/api/views/doc/:id", async (_req, p) => {
      const doc = await get<{ chatId?: string | null }>(`/api/docs/${enc(p.id!)}`);
      const chat = doc.chatId
        ? await Promise.all([get(`/api/sessions/${enc(doc.chatId)}`), get<unknown[]>(`/api/sessions/${enc(doc.chatId)}/events`)])
            .then(([session, events]) => ({ session, events }))
            .catch(() => null)
        : null;
      return json({ doc, chat });
    })
    // A machine in the sidebar: its tasks, terminals, task setups, PRs and status. Asked of every
    // machine on every page render, refresh and action: one call each, not five.
    .on("GET", "/api/views/sidebar", async () => {
      const [tasks, terminals, jobs, prs, status] = await Promise.all([
        get("/api/tasks"),
        get("/api/terminals"),
        get<unknown[]>("/api/task-jobs").catch(() => []),
        get<unknown[]>("/api/prs").catch(() => []),
        get("/api/status").catch(() => null),
      ]);
      return json({ tasks, terminals, jobs, prs, status });
    })
    // What the shell shows from the home: every chat, what waits for approval, your docs and the
    // notification settings.
    .on("GET", "/api/views/shell", async () => {
      const [sessions, approvals, docs, notifications] = await Promise.all([
        get("/api/sessions"),
        get("/api/approvals?state=pending"),
        get<unknown[]>("/api/docs").catch(() => []),
        get("/api/notifications").catch(() => null),
      ]);
      return json({ sessions, approvals, docs, notifications });
    })
    // A task's page on its machine: its setup while that runs; else the task, its terminals and PRs.
    .on("GET", "/api/views/task/:id", async (_req, p) => {
      const id = p.id!;
      const jobs = await get<{ taskId: string; state: string }[]>("/api/task-jobs");
      const job = jobs.find((j) => j.taskId === id) ?? null;
      if (job && job.state !== "done") return json({ job, task: null });
      const task = await get<{ state: string }>(`/api/tasks/${enc(id)}`).catch(() => null);
      if (!task || task.state !== "ready") return json({ job: null, task });
      const [terminals, prs] = await Promise.all([get(`/api/terminals?task=${enc(id)}`), get(`/api/tasks/${enc(id)}/prs`).catch(() => [])]);
      return json({ job: null, task, terminals, prs });
    });
}
