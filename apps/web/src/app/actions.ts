"use server";
import { revalidatePath } from "next/cache";
import { daemon, type ChatKind, type FileEntry, type NotificationSettings, type TaskPR, type Repo, type RepoDiff, type Session, type TaskJob, type TerminalInfo } from "@/lib/daemon";

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

export async function feedAction(form: FormData) {
  const id = encodeURIComponent(text(form, "itemId"));
  const action = text(form, "action");
  if (action === "dismiss" || action === "done") await daemon(`/api/feed/${id}/${action}`, { method: "POST" });
  else if (action === "snooze") {
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await daemon(`/api/feed/${id}/snooze`, { method: "POST", json: { until } });
  } else throw new Error(`unknown feed action ${action}`);
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
    return await daemon<{ url: string }>("/api/bobby/open", { method: "POST", json: { pr, browser: true } });
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
  await daemon("/api/presence", { method: "POST", json: p });
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
