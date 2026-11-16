"use server";
import { revalidatePath } from "next/cache";
import { daemon, type ChatKind, type FileEntry, type RepoDiff, type Session } from "@/lib/daemon";

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

export async function terminalTicket(): Promise<string> {
  const { ticket } = await daemon<{ ticket: string }>("/api/tickets", { method: "POST", json: { path: "/api/terminal" } });
  return ticket;
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
