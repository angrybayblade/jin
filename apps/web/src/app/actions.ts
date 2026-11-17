"use server";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { daemon, homeMachine, MACHINE_COOKIE, type Hook, type HooksStatus, type LiveStatus, type Machine, type SetupState, type ChatKind, type FileEntry, type NotificationKinds, type NotificationSettings, type TaskPR, type Repo, type RepoDiff, type Session, type TaskJob, type TerminalInfo } from "@/lib/daemon";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

// ---------------------------------------------------------------- approvals and feed (forms)

export async function decideApproval(form: FormData) {
  const id = text(form, "approvalId");
  const decision = text(form, "decision");
  if (decision !== "approve" && decision !== "reject") throw new Error("decision must be approve or reject");
  await daemon(`/api/approvals/${encodeURIComponent(id)}`, { method: "POST", json: { decision } });
  revalidatePath("/", "layout");
}

export async function collectGithub() {
  await daemon("/api/collect/github", { method: "POST" });
  revalidatePath("/", "layout");
}

/** Snooze or dismiss feed items: one, or a whole thread (several itemId fields). */
export async function feedAction(form: FormData) {
  const ids = form.getAll("itemId").map(String).filter(Boolean);
  const action = text(form, "action");
  if (!ids.length) throw new Error("no feed items");
  const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await Promise.all(
    ids.map((raw) => {
      const id = encodeURIComponent(raw);
      if (action === "dismiss" || action === "done") return daemon(`/api/feed/${id}/${action}`, { method: "POST" });
      if (action === "snooze") return daemon(`/api/feed/${id}/snooze`, { method: "POST", json: { until } });
      throw new Error(`unknown feed action ${action}`);
    }),
  );
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------- chats

export async function createChat(kind: ChatKind, prompt: string): Promise<Session> {
  const s = await daemon<Session>("/api/chats", { method: "POST", json: { kind, prompt } });
  revalidatePath("/", "layout");
  return s;
}

export async function startTaskSession(taskId: string, prompt: string): Promise<Session> {
  const s = await daemon<Session>(`/api/tasks/${encodeURIComponent(taskId)}/sessions`, { method: "POST", json: { prompt } });
  revalidatePath("/", "layout");
  return s;
}

export async function sendMessage(sessionId: string, prompt: string): Promise<Session> {
  return daemon<Session>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { method: "POST", json: { prompt } });
}

export async function stopSession(sessionId: string): Promise<Session> {
  return daemon<Session>(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST" });
}

/** A one-time ticket for the browser to open a websocket to the daemon. */
export async function streamTicket(sessionId: string): Promise<string> {
  const { ticket } = await daemon<{ ticket: string }>("/api/tickets", { method: "POST", json: { path: `/api/sessions/${sessionId}/stream` } });
  return ticket;
}

// ---------------------------------------------------------------- terminals (shell and Claude Code)

export async function attachTicket(terminalId: string): Promise<string> {
  const { ticket } = await daemon<{ ticket: string }>("/api/tickets", { method: "POST", json: { path: `/api/terminals/${terminalId}/attach` } });
  return ticket;
}

export async function openTerminal(opts: { taskId?: string; kind: "shell" | "claude"; prompt?: string; cols?: number; rows?: number }): Promise<TerminalInfo> {
  const t = await daemon<TerminalInfo>("/api/terminals", { method: "POST", json: opts });
  revalidatePath("/", "layout");
  return t;
}

/** Start a tab's process again (after a daemon restart, Claude Code resumes its conversation). */
export async function startTerminal(id: string): Promise<TerminalInfo> {
  const t = await daemon<TerminalInfo>(`/api/terminals/${encodeURIComponent(id)}/start`, { method: "POST", json: {} });
  revalidatePath("/", "layout");
  return t;
}

export async function closeTerminal(id: string): Promise<void> {
  await daemon(`/api/terminals/${encodeURIComponent(id)}`, { method: "DELETE" });
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------- workspace pane

export async function listFiles(taskId: string, path: string): Promise<FileEntry[]> {
  return daemon<FileEntry[]>(`/api/tasks/${encodeURIComponent(taskId)}/files?path=${encodeURIComponent(path)}`);
}

export async function readFile(taskId: string, path: string): Promise<{ content: string } | { error: string }> {
  try {
    return await daemon<{ content: string }>(`/api/tasks/${encodeURIComponent(taskId)}/file?path=${encodeURIComponent(path)}`);
  } catch (err) {
    return { error: err instanceof Error ? err.message.replace(/^GET \S+: /, "") : String(err) };
  }
}

export async function writeFile(taskId: string, path: string, content: string): Promise<void> {
  await daemon(`/api/tasks/${encodeURIComponent(taskId)}/file`, { method: "PUT", json: { path, content } });
}

export async function getDiff(taskId: string): Promise<RepoDiff[]> {
  return daemon<RepoDiff[]>(`/api/tasks/${encodeURIComponent(taskId)}/diff`);
}

// ---------------------------------------------------------------- bobby (PR reviews)

/** Open the PR's review in Bobby in your default browser, starting Bobby if it is not running. */
export async function openInBobby(pr: string): Promise<{ url: string } | { error: string }> {
  try {
    return await daemon<{ url: string }>("/api/bobby/open", { method: "POST", json: { pr, browser: true }, local: true });
  } catch (err) {
    return { error: err instanceof Error ? err.message.replace(/^POST \S+: /, "") : String(err) };
  }
}

// ---------------------------------------------------------------- new tasks

export async function listRepos(workspace?: string): Promise<Repo[]> {
  const ws = workspace ?? (await daemon<{ id: string }[]>("/api/workspaces"))[0]?.id;
  return ws ? daemon<Repo[]>(`/api/workspaces/${encodeURIComponent(ws)}/repos`) : [];
}

/** Create a task in the background; its page shows setup progress until it is ready. */
export async function startTaskJob(input: { id: string; type?: string; repos: string[]; slug: string; setup: boolean; prompt?: string }): Promise<{ job: TaskJob } | { error: string }> {
  try {
    const job = await daemon<TaskJob>("/api/task-jobs", { method: "POST", json: input });
    revalidatePath("/", "layout");
    return { job };
  } catch (err) {
    return { error: err instanceof Error ? err.message.replace(/^POST \S+: /, "") : String(err) };
  }
}

export async function getTaskJob(id: string): Promise<TaskJob> {
  return daemon<TaskJob>(`/api/task-jobs/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------- finder

export async function findFiles(taskId: string, q: string): Promise<{ path: string }[]> {
  return daemon<{ path: string }[]>(`/api/tasks/${encodeURIComponent(taskId)}/find?q=${encodeURIComponent(q)}&limit=40`);
}

export async function searchFiles(taskId: string, q: string): Promise<{ path: string; line: number; text: string }[]> {
  return daemon<{ path: string; line: number; text: string }[]>(`/api/tasks/${encodeURIComponent(taskId)}/grep?q=${encodeURIComponent(q)}&limit=120`);
}

// ---------------------------------------------------------------- context menus: rename, archive, remove

export async function updateTask(id: string, patch: { title?: string | null; archived?: boolean }): Promise<void> {
  await daemon(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", json: patch });
  revalidatePath("/", "layout");
}

/** Remove a task with the workspace's own tooling (cws task rm). */
export async function removeTask(id: string): Promise<{ ok: true } | { error: string }> {
  try {
    await daemon(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message.replace(/^DELETE \S+: /, "") : String(err) };
  }
}

export async function revealTask(id: string): Promise<void> {
  await daemon(`/api/tasks/${encodeURIComponent(id)}/reveal`, { method: "POST" });
}

export async function updateSession(id: string, patch: { title?: string; archived?: boolean }): Promise<void> {
  await daemon(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", json: patch });
  revalidatePath("/", "layout");
}

export async function deleteSession(id: string): Promise<void> {
  await daemon(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  revalidatePath("/", "layout");
}

export async function updateTerminal(id: string, patch: { title?: string; archived?: boolean }): Promise<TerminalInfo> {
  const t = await daemon<TerminalInfo>(`/api/terminals/${encodeURIComponent(id)}`, { method: "PATCH", json: patch });
  revalidatePath("/", "layout");
  return t;
}

export async function restartTerminal(id: string): Promise<TerminalInfo> {
  const t = await daemon<TerminalInfo>(`/api/terminals/${encodeURIComponent(id)}/restart`, { method: "POST", json: {} });
  revalidatePath("/", "layout");
  return t;
}

export async function archivedTerminals(taskId: string): Promise<TerminalInfo[]> {
  return daemon<TerminalInfo[]>(`/api/terminals?task=${encodeURIComponent(taskId)}&archived=1`);
}

export async function archivedChats(kind: string): Promise<Session[]> {
  return daemon<Session[]>(`/api/sessions?kind=${encodeURIComponent(kind)}&archived=1`);
}

// ---------------------------------------------------------------- notifications

export async function setNotifications(s: NotificationSettings): Promise<NotificationSettings> {
  return daemon<NotificationSettings>("/api/notifications", { method: "PATCH", json: s });
}

export async function testNotification(): Promise<{ sent: boolean; skipped: string | null }> {
  return daemon("/api/notifications/test", { method: "POST" });
}

export async function reportPresence(p: { path: string; chat: string | null; terminal: string | null; focused: boolean }): Promise<void> {
  // To the home (its notices) and, with a home set, to this machine too (its own Claude Code sessions).
  await Promise.all([daemon("/api/presence", { method: "POST", json: p }), homeMachine() !== "local" ? daemon("/api/presence", { method: "POST", json: p, machine: "local" }).catch(() => {}) : null]);
}

// ---------------------------------------------------------------- pull requests attached to tasks

export async function attachTaskPr(taskId: string, url: string): Promise<TaskPR | { error: string }> {
  try {
    const pr = await daemon<TaskPR>(`/api/tasks/${encodeURIComponent(taskId)}/prs`, { method: "POST", json: { url } });
    revalidatePath("/", "layout");
    return pr;
  } catch (err) {
    return { error: err instanceof Error ? err.message.replace(/^POST \S+: /, "") : String(err) };
  }
}

export async function detachTaskPr(taskId: string, url: string): Promise<void> {
  await daemon(`/api/tasks/${encodeURIComponent(taskId)}/prs`, { method: "DELETE", json: { url } });
  revalidatePath("/", "layout");
}

export async function refreshTaskPrs(taskId: string): Promise<void> {
  await daemon(`/api/tasks/${encodeURIComponent(taskId)}/prs/refresh`, { method: "POST" });
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------- remote machines (this machine's daemon)

const fail = (err: unknown) => ({ error: err instanceof Error ? err.message.replace(/^\w+ \S+: /, "") : String(err) });
const machinePath = (id: string, rest = "") => `/api/machines/${encodeURIComponent(id)}${rest}`;

export async function listMachines(): Promise<Machine[]> {
  return daemon<Machine[]>("/api/machines", { local: true });
}

export async function getMachine(id: string): Promise<Machine> {
  return daemon<Machine>(machinePath(id), { local: true });
}

/** Add a machine by the host you'd type after `ssh`; onboarding starts at once. */
export async function addMachine(host: string, label?: string): Promise<Machine | { error: string }> {
  try {
    const m = await daemon<Machine>("/api/machines", { method: "POST", json: { host, label }, local: true });
    revalidatePath("/", "layout");
    return m;
  } catch (err) {
    return fail(err);
  }
}

/** Run onboarding again: also updates jin's daemon there to this jin's commit. */
export async function rerunMachineSetup(id: string): Promise<void> {
  await daemon(machinePath(id, "/setup"), { method: "POST", local: true });
}

export async function checkMachineAuth(id: string): Promise<void> {
  await daemon(machinePath(id, "/auth"), { method: "POST", local: true });
}

export async function startMachineSignIn(id: string, tool: string): Promise<void> {
  await daemon(machinePath(id, `/auth/${tool}`), { method: "POST", local: true });
}

export async function cancelMachineSignIn(id: string, tool: string): Promise<void> {
  await daemon(machinePath(id, `/auth/${tool}`), { method: "DELETE", local: true });
}

export async function submitMachineSignInCode(id: string, tool: string, code: string): Promise<{ error: string } | null> {
  try {
    await daemon(machinePath(id, `/auth/${tool}/code`), { method: "POST", json: { code }, local: true });
    return null;
  } catch (err) {
    return fail(err);
  }
}

export async function setMachineDopplerToken(id: string, token: string): Promise<{ error: string } | null> {
  try {
    await daemon(machinePath(id, "/doppler-token"), { method: "POST", json: { token }, local: true });
    return null;
  } catch (err) {
    return fail(err);
  }
}

/** Look again for composio workspaces on the machine. */
export async function detectMachineWorkspaces(id: string): Promise<void> {
  await daemon(machinePath(id, "/workspaces/detect"), { method: "POST", local: true });
}

export async function setupMachineWorkspace(id: string, path?: string): Promise<{ error: string } | null> {
  try {
    await daemon(machinePath(id, "/workspace"), { method: "POST", json: { path: path || undefined }, local: true });
    return null;
  } catch (err) {
    return fail(err);
  }
}

export async function removeMachine(id: string): Promise<void> {
  await daemon(machinePath(id), { method: "DELETE", local: true });
  const jar = await cookies();
  if (jar.get(MACHINE_COOKIE)?.value === id) jar.delete(MACHINE_COOKIE);
  revalidatePath("/", "layout");
}

/** Show another machine's jin ("local" for this one): tasks, terminals and chats all come from it. */
export async function switchMachine(id: string): Promise<void> {
  const jar = await cookies();
  // "local" is kept explicitly: with a home set, no cookie means the home.
  jar.set(MACHINE_COOKIE, id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------- first-run setup (this machine's daemon)

export async function getSetup(): Promise<SetupState> {
  return daemon<SetupState>("/api/setup", { local: true });
}

export async function checkSetupAuth(): Promise<void> {
  await daemon("/api/setup/auth", { method: "POST", local: true });
}

export async function startSetupSignIn(tool: string): Promise<void> {
  await daemon(`/api/setup/auth/${tool}`, { method: "POST", local: true });
}

export async function cancelSetupSignIn(tool: string): Promise<void> {
  await daemon(`/api/setup/auth/${tool}`, { method: "DELETE", local: true });
}

export async function submitSetupSignInCode(tool: string, code: string): Promise<{ error: string } | null> {
  try {
    await daemon(`/api/setup/auth/${tool}/code`, { method: "POST", json: { code }, local: true });
    return null;
  } catch (err) {
    return fail(err);
  }
}

export async function adoptSetupWorkspace(path: string): Promise<{ error: string } | null> {
  try {
    await daemon("/api/setup/workspace", { method: "POST", json: { path }, local: true });
    revalidatePath("/", "layout");
    return null;
  } catch (err) {
    return fail(err);
  }
}

export async function installSetupWorkspace(): Promise<{ error: string } | null> {
  try {
    await daemon("/api/setup/install", { method: "POST", local: true });
    return null;
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------- refresh

/**
 * A fingerprint of what the app shows, from the machine it shows and every other connected
 * machine (for the sidebar): the page re-renders only when it changes. A machine whose jin
 * predates /api/stamp counts as changed every 15 seconds.
 */
export async function changeStamp(): Promise<string> {
  const machines = await daemon<Machine[]>("/api/machines", { local: true }).catch(() => [] as Machine[]);
  const ids = ["local", ...machines.filter((m) => m.connected).map((m) => m.id)];
  const parts = await Promise.all(
    ids.map((id) =>
      daemon<{ stamp: string }>("/api/stamp", { machine: id, timeoutMs: 1500 })
        .then((r) => `${id}:${r.stamp}`)
        .catch(() => `${id}:?${Math.floor(Date.now() / 15_000)}`),
    ),
  );
  return [current(), ...parts].join("|");
  function current() {
    return machines.map((m) => `${m.id}${m.connected ? "+" : "-"}${m.busy ? "*" : ""}`).join(",");
  }
}

// ---------------------------------------------------------------- home (the always-on hub)

/** Use a machine as this jin's home: chats, desks, feed and approvals live there; this machine attaches to it. */
export async function setMachineHome(id: string, home: boolean): Promise<{ error: string } | null> {
  try {
    await daemon(machinePath(id, "/home"), { method: "POST", json: { home }, local: true });
    revalidatePath("/", "layout");
    return null;
  } catch (err) {
    return fail(err);
  }
}

/** The hub's own SSH key (made there if it has none): add its public half to your exe.dev account. */
export async function hubKey(id: string): Promise<{ publicKey: string } | { error: string }> {
  try {
    return await daemon<{ publicKey: string }>(machinePath(id, "/hub-key"), { method: "POST", local: true });
  } catch (err) {
    return fail(err);
  }
}

/** Copy this machine's chats and feed to the home, and ask the home to reach the other machines itself. */
export async function moveToHome(id: string): Promise<{ history: { sessions: number; events: number; feed: number; transcripts?: number }; machines: { id: string; ok: boolean; error?: string }[] } | { error: string }> {
  try {
    const r = await daemon<{ history: { sessions: number; events: number; feed: number; transcripts?: number }; machines: { id: string; ok: boolean; error?: string }[] }>(machinePath(id, "/move"), { method: "POST", local: true });
    revalidatePath("/", "layout");
    return r;
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------- live events (Composio, on the home)

export async function getLive(): Promise<LiveStatus> {
  return daemon<LiveStatus>("/api/composio");
}

export async function liveLogin(): Promise<{ url: string } | { error: string }> {
  try {
    return await daemon<{ url: string }>("/api/composio/login", { method: "POST" });
  } catch (err) {
    return fail(err);
  }
}

export async function liveProjects(): Promise<{ orgId: string; org: string; projects: { id: string; name: string }[] }[] | { error: string }> {
  try {
    return await daemon("/api/composio/projects");
  } catch (err) {
    return fail(err);
  }
}

export async function liveUseProject(orgId: string, projectId: string, name: string, userId?: string): Promise<{ error: string } | null> {
  try {
    await daemon("/api/composio/project", { method: "POST", json: { orgId, projectId, name, userId } });
    return null;
  } catch (err) {
    return fail(err);
  }
}

export async function liveConnect(toolkit: string): Promise<{ url: string } | { error: string }> {
  try {
    return await daemon<{ url: string }>(`/api/composio/connect/${toolkit}`, { method: "POST" });
  } catch (err) {
    return fail(err);
  }
}

export async function liveSetEvent(kind: string, on: boolean, linearTeams?: string[]): Promise<{ error: string } | null> {
  try {
    await daemon(`/api/composio/events/${kind}`, { method: "POST", json: { on, linearTeams } });
    return null;
  } catch (err) {
    return fail(err);
  }
}

export async function liveLinearTeams(): Promise<{ id: string; name: string; key: string | null }[] | { error: string }> {
  try {
    return await daemon("/api/composio/linear-teams");
  } catch (err) {
    return fail(err);
  }
}

export async function liveListener(on: boolean): Promise<void> {
  await daemon("/api/composio/listener", { method: "POST", json: { on } });
}

// ---------------------------------------------------------------- hooks (on the home)

export async function getHooks(): Promise<HooksStatus> {
  return daemon<HooksStatus>("/api/event-hooks");
}

export async function saveHook(h: Partial<Hook>): Promise<Hook | { error: string }> {
  try {
    return h.id ? await daemon<Hook>(`/api/event-hooks/${encodeURIComponent(h.id)}`, { method: "PATCH", json: h }) : await daemon<Hook>("/api/event-hooks", { method: "POST", json: h });
  } catch (err) {
    return fail(err);
  }
}

export async function deleteHook(id: string): Promise<{ removed: boolean } | { error: string }> {
  try {
    return await daemon<{ removed: boolean }>(`/api/event-hooks/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------- what notifies (on the home)

export async function getNotificationKinds(): Promise<NotificationKinds[]> {
  return daemon<NotificationKinds[]>("/api/notifications/kinds");
}

export async function chooseNotificationKinds(app: string, kinds: string[]): Promise<NotificationKinds[] | { error: string }> {
  try {
    await daemon<NotificationSettings>("/api/notifications", { method: "PATCH", json: { sources: { [app]: kinds } } });
    return await daemon<NotificationKinds[]>("/api/notifications/kinds");
  } catch (err) {
    return fail(err);
  }
}
