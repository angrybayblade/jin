"use server";
import { revalidatePath } from "next/cache";
import { daemon } from "@/lib/daemon";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export async function decideApproval(form: FormData) {
  const id = text(form, "approvalId");
  const decision = text(form, "decision");
  if (decision !== "approve" && decision !== "reject") throw new Error("decision must be approve or reject");
  await daemon(`/api/approvals/${encodeURIComponent(id)}`, { method: "POST", json: { decision } });
  revalidatePath("/", "layout");
}

export async function collectGithub() {
  await daemon("/api/collect/github", { method: "POST" });
  revalidatePath("/");
}

export async function feedAction(form: FormData) {
  const id = encodeURIComponent(text(form, "itemId"));
  const action = text(form, "action");
  if (action === "dismiss" || action === "done") await daemon(`/api/feed/${id}/${action}`, { method: "POST" });
  else if (action === "snooze") {
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await daemon(`/api/feed/${id}/snooze`, { method: "POST", json: { until } });
  } else throw new Error(`unknown feed action ${action}`);
  revalidatePath("/");
}

export async function promoteItem(form: FormData) {
  const repos = text(form, "repos")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  await daemon(`/api/feed/${encodeURIComponent(text(form, "itemId"))}/promote`, {
    method: "POST",
    json: { taskId: text(form, "taskId"), type: text(form, "type") || undefined, repos, slug: text(form, "slug") || undefined },
  });
  revalidatePath("/");
}

export async function startSession(form: FormData) {
  const taskId = text(form, "taskId");
  await daemon(`/api/tasks/${encodeURIComponent(taskId)}/sessions`, { method: "POST", json: { prompt: text(form, "prompt") } });
  revalidatePath("/");
}

export async function sendMessage(form: FormData) {
  const sessionId = text(form, "sessionId");
  await daemon(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { method: "POST", json: { prompt: text(form, "prompt") } });
  revalidatePath(`/sessions/${sessionId}`);
}
