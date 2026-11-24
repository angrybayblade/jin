"use server";
import { revalidatePath } from "next/cache";
import { currentMachine, daemon, daemonWsBase, homeMachine, type Hook, type HooksStatus, type LiveStatus, type Machine, type SetupState, type ChatKind, type FileEntry, type JournalView, type NotificationKinds, type NotificationSettings, type TaskPR, type Mention, type ChatRef, type ClaudeSettingsFile, type HarnessSettingsFile, type ChatSkill, type Doc, type DocAnchor, type DocFull, type DocSuggestion, type DocSummary, type DocThread, type DocVersion, type SessionEvent, type ModelChoices, type RunChoice, type Repo, type RepoDiff, type TaskKindSpec, type Session, type TaskJob, type TaskActivity, type TaskLink, type TerminalInfo, type AgentId, type MachineAgents, type RoomAgent, type RoomMessage, type RoomProfile, type RoomState, type Problem, type TrackerView } from "@/lib/daemon";

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
  return failSafe(async () => {
    await daemon("/api/collect/github", { method: "POST" });
    revalidatePath("/", "layout");
  });
}

/** Snooze or dismiss feed items: one, or a whole thread (several itemId fields). */
export async function feedAction(form: FormData) {
  return failSafe(async () => {
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
  });
}

/** Done with, or later for, every item of a thread (the desk's Focus mode). */
export async function feedSet(ids: string[], action: "done" | "snooze") {
  return failSafe(async () => {
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await Promise.all(ids.map((id) => daemon(`/api/feed/${encodeURIComponent(id)}/${action}`, { method: "POST", ...(action === "snooze" ? { json: { until } } : {}) })));
    revalidatePath("/", "layout");
  });
}

/** A fresh start: everything still open from before `before` is done (kept, not deleted). */
export async function sweepFeed(before: string): Promise<number> {
  return failSafe(async () => {
    const r = await daemon<{ cleared: number }>("/api/feed/sweep", { method: "POST", json: { before } });
    revalidatePath("/", "layout");
    return r.cleared;
  });
}

// ---------------------------------------------------------------- chats

export async function createChat(kind: ChatKind, prompt: string, choice: RunChoice = {}): Promise<Session> {
  return failSafe(async () => {
    const s = await daemon<Session>("/api/chats", { method: "POST", json: { kind, prompt, ...choice } });
    revalidatePath("/", "layout");
    return s;
  });
}

export async function startTaskSession(taskId: string, prompt: string, choice: RunChoice = {}): Promise<Session> {
  return failSafe(async () => {
    const s = await daemon<Session>(`/api/tasks/${encodeURIComponent(taskId)}/sessions`, { method: "POST", json: { prompt, ...choice } });
    revalidatePath("/", "layout");
    return s;
  });
}

export async function sendMessage(sessionId: string, prompt: string, choice: RunChoice = {}): Promise<Session> {
  return failSafe(async () => {
    return daemon<Session>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { method: "POST", json: { prompt, ...choice } });
  });
}

/** The models and effort levels the composer offers. */
export async function modelChoices(): Promise<ModelChoices> {
  return failSafe(async () => {
    return daemon<ModelChoices>("/api/models");
  });
}

export async function stopSession(sessionId: string): Promise<Session> {
  return failSafe(async () => {
    return daemon<Session>(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST" });
  });
}

/** A one-time ticket for the browser to open a websocket to the daemon. */
export async function streamTicket(sessionId: string): Promise<string> {
  return failSafe(async () => {
    const { ticket } = await daemon<{ ticket: string }>("/api/tickets", { method: "POST", json: { path: `/api/sessions/${sessionId}/stream` } });
    return ticket;
  });
}

// ---------------------------------------------------------------- terminals (shell and Claude Code)

export async function attachTicket(terminalId: string): Promise<string> {
  return failSafe(async () => {
    const { ticket } = await daemon<{ ticket: string }>("/api/tickets", { method: "POST", json: { path: `/api/terminals/${terminalId}/attach` } });
    return ticket;
  });
}

/** A machine's coding agents and its default (`machine`: another machine; else the page's own). */
export async function listAgents(machine?: string): Promise<MachineAgents | { error: string }> {
  try {
    return await daemon<MachineAgents>("/api/agents", { machine });
  } catch (err) {
    return fail(err);
  }
}

/** The agent new tabs on a machine start. */
export async function setDefaultAgent(id: AgentId, machine?: string): Promise<MachineAgents | { error: string }> {
  try {
    const r = await daemon<MachineAgents>("/api/agents/default", { method: "PUT", json: { id }, machine });
    revalidatePath("/", "layout");
    return r;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** `machine`: the task's machine, from a page that is not on it (the sidebar); else the page's own. */
export async function openTerminal(opts: { taskId?: string; kind: "shell" | "agent"; agent?: AgentId; prompt?: string; cols?: number; rows?: number; forkFrom?: string; machine?: string }): Promise<TerminalInfo> {
  return failSafe(async () => {
    const { machine, ...json } = opts;
    const t = await daemon<TerminalInfo>("/api/terminals", { method: "POST", json, machine });
    revalidatePath("/", "layout");
    return t;
  });
}

/** Start a tab's process again (after a daemon restart, Claude Code resumes its conversation). */
export async function startTerminal(id: string): Promise<TerminalInfo> {
  return failSafe(async () => {
    const t = await daemon<TerminalInfo>(`/api/terminals/${encodeURIComponent(id)}/start`, { method: "POST", json: {} });
    revalidatePath("/", "layout");
    return t;
  });
}

export async function closeTerminal(id: string): Promise<void> {
  return failSafe(async () => {
    await daemon(`/api/terminals/${encodeURIComponent(id)}`, { method: "DELETE" });
    revalidatePath("/", "layout");
  });
}

// ---------------------------------------------------------------- workspace pane

export async function listFiles(taskId: string, path: string): Promise<FileEntry[]> {
  return failSafe(async () => {
    return daemon<FileEntry[]>(`/api/tasks/${encodeURIComponent(taskId)}/files?path=${encodeURIComponent(path)}`);
  });
}

export async function readFile(taskId: string, path: string): Promise<{ content: string } | { error: string }> {
  try {
    return await daemon<{ content: string }>(`/api/tasks/${encodeURIComponent(taskId)}/file?path=${encodeURIComponent(path)}`);
  } catch (err) {
    return { error: err instanceof Error ? err.message.replace(/^GET \S+: /, "") : String(err) };
  }
}

export async function writeFile(taskId: string, path: string, content: string): Promise<void> {
  return failSafe(async () => {
    await daemon(`/api/tasks/${encodeURIComponent(taskId)}/file`, { method: "PUT", json: { path, content } });
  });
}

export async function getDiff(taskId: string): Promise<RepoDiff[]> {
  return failSafe(async () => {
    return daemon<RepoDiff[]>(`/api/tasks/${encodeURIComponent(taskId)}/diff`);
  });
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

/** What an @ in a chat could mean (on the home: every machine's tasks, PRs, issues). */
export async function searchMentions(q: string): Promise<Mention[]> {
  return failSafe(async () => {
    return daemon<Mention[]>(`/api/mentions?q=${encodeURIComponent(q)}`, { timeoutMs: 12_000 });
  });
}

/** What a chat mentioned: PRs, tickets, tasks, Slack threads, Notion pages, links. */
export async function chatRefs(sessionId: string): Promise<ChatRef[]> {
  return failSafe(async () => {
    return daemon<ChatRef[]>(`/api/sessions/${encodeURIComponent(sessionId)}/refs`, { timeoutMs: 8_000 });
  });
}

/** The kinds of task the (first) workspace runs, for the new-task form. */
/** The kinds of task a machine's workspace runs, and its issue tracker (null: its tasks have no issues). */
export async function listTaskKinds(machine?: string): Promise<{ kinds: TaskKindSpec[]; tracker: TrackerView | null }> {
  return failSafe(async () => {
    const w = (await daemon<{ id: string; taskKinds?: TaskKindSpec[]; tracker?: TrackerView | null }[]>("/api/workspaces", { machine }))[0];
    return { kinds: w?.taskKinds ?? [], tracker: w?.tracker ?? null };
  });
}

export async function listRepos(workspace?: string, machine?: string): Promise<Repo[]> {
  return failSafe(async () => {
    const ws = workspace ?? (await daemon<{ id: string }[]>("/api/workspaces", { machine }))[0]?.id;
    return ws ? daemon<Repo[]>(`/api/workspaces/${encodeURIComponent(ws)}/repos`, { machine }) : [];
  });
}

/** Create a task in the background; its page shows setup progress until it is ready. */
/** A title for a task given none: its issue's, else its first PR's (looked up on the home). */
export async function taskTitle(id: string, refs: string[] = []): Promise<{ title: string; from: "issue" | "pr" } | null> {
  const q = new URLSearchParams({ id });
  for (const r of refs) q.append("ref", r);
  return daemon<{ title: string; from: "issue" | "pr" } | null>(`/api/mentions/title?${q}`, { timeoutMs: 20_000 }).catch(() => null);
}

export async function startTaskJob(input: { id: string; kind?: "change" | "scratch"; type?: string; repos: string[]; slug: string; setup: boolean; prompt?: string; links?: string[]; machine?: string; /** Where the first prompt goes: a Claude Code session, or the task's agent room. */ startIn?: "claude" | "room" }): Promise<{ job: TaskJob } | { error: string }> {
  try {
    const { machine, ...json } = input;
    // A scratch task needs no title: the workspace numbers it, and it ties to no issue.
    if (json.kind !== "scratch" && !json.slug.trim()) {
      const found = await taskTitle(json.id, json.links);
      if (!found) return { error: `No title given, and none found for ${json.id} in its issue or a linked PR. Add a title.` };
      json.slug = found.title;
    }
    const job = await daemon<TaskJob>("/api/task-jobs", { method: "POST", json, machine });
    revalidatePath("/", "layout");
    return { job };
  } catch (err) {
    return { error: err instanceof Error ? err.message.replace(/^POST \S+: /, "") : String(err) };
  }
}

export async function getTaskJob(id: string): Promise<TaskJob> {
  return failSafe(async () => {
    return daemon<TaskJob>(`/api/task-jobs/${encodeURIComponent(id)}`);
  });
}

// ---------------------------------------------------------------- finder

/** Something a room message can tag, as the picker offers it: `insert` goes after the @. */
export interface RoomTag {
  kind: "pr" | "issue" | "task" | "doc" | "file";
  insert: string;
  label: string;
  hint: string | null;
}

/** What to offer after an @ in a task's room (besides its agents): its files, docs, and PRs, issues and tasks. */
export async function roomTagOptions(taskId: string, q: string): Promise<RoomTag[]> {
  const t = encodeURIComponent(taskId);
  const [files, docs, found] = await Promise.all([
    q ? daemon<{ path: string }[]>(`/api/tasks/${t}/find?q=${encodeURIComponent(q)}&limit=5`).catch(() => []) : Promise.resolve([]),
    daemon<DocSummary[]>(`/api/docs${q ? `?q=${encodeURIComponent(q)}` : ""}`).catch(() => [] as DocSummary[]),
    q ? daemon<Mention[]>(`/api/mentions?q=${encodeURIComponent(q)}`).catch(() => [] as Mention[]) : Promise.resolve([] as Mention[]),
  ]);
  const NOUN = { pr: "pull request", issue: "issue", task: "jin task" } as const;
  return [
    ...found.slice(0, 5).map((m): RoomTag => ({ kind: m.kind, insert: m.label, label: m.title ?? m.label, hint: [m.kind === "issue" && m.noun ? m.noun : NOUN[m.kind], m.label, m.state].filter(Boolean).join(" · ") })),
    ...docs.slice(0, 4).map((d): RoomTag => ({ kind: "doc", insert: `doc:${d.id}`, label: d.title || "Untitled", hint: "jin doc" })),
    ...files.map((f): RoomTag => ({ kind: "file", insert: `file:${f.path}`, label: f.path.split("/").pop() ?? f.path, hint: f.path })),
  ];
}

export async function findFiles(taskId: string, q: string): Promise<{ path: string }[]> {
  return failSafe(async () => {
    return daemon<{ path: string }[]>(`/api/tasks/${encodeURIComponent(taskId)}/find?q=${encodeURIComponent(q)}&limit=40`);
  });
}

export async function searchFiles(taskId: string, q: string): Promise<{ path: string; line: number; text: string }[]> {
  return failSafe(async () => {
    return daemon<{ path: string; line: number; text: string }[]>(`/api/tasks/${encodeURIComponent(taskId)}/grep?q=${encodeURIComponent(q)}&limit=120`);
  });
}

// ---------------------------------------------------------------- context menus: rename, archive, remove

export async function updateTask(id: string, patch: { title?: string | null; archived?: boolean }, machine?: string): Promise<void> {
  return failSafe(async () => {
    await daemon(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", json: patch, machine });
    revalidatePath("/", "layout");
  });
}

/** Remove a task with the workspace's own tooling. */
/** Remove a task's checkouts; `discard` (scratch tasks) throws it away whole, unsaved work and its branch included. */
export async function removeTask(id: string, machine?: string, discard = false): Promise<{ ok: true } | { error: string }> {
  try {
    await daemon(`/api/tasks/${encodeURIComponent(id)}${discard ? "?discard=1" : ""}`, { method: "DELETE", machine });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message.replace(/^DELETE \S+: /, "") : String(err) };
  }
}

export async function revealTask(id: string, machine?: string): Promise<void> {
  return failSafe(async () => {
    await daemon(`/api/tasks/${encodeURIComponent(id)}/reveal`, { method: "POST", machine });
  });
}

export async function updateSession(id: string, patch: { title?: string; archived?: boolean }): Promise<void> {
  return failSafe(async () => {
    await daemon(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", json: patch });
    revalidatePath("/", "layout");
  });
}

export async function deleteSession(id: string): Promise<void> {
  return failSafe(async () => {
    await daemon(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    revalidatePath("/", "layout");
  });
}

export async function updateTerminal(id: string, patch: { title?: string; archived?: boolean }): Promise<TerminalInfo> {
  return failSafe(async () => {
    const t = await daemon<TerminalInfo>(`/api/terminals/${encodeURIComponent(id)}`, { method: "PATCH", json: patch });
    revalidatePath("/", "layout");
    return t;
  });
}

export async function restartTerminal(id: string): Promise<TerminalInfo> {
  return failSafe(async () => {
    const t = await daemon<TerminalInfo>(`/api/terminals/${encodeURIComponent(id)}/restart`, { method: "POST", json: {} });
    revalidatePath("/", "layout");
    return t;
  });
}

export async function archivedTerminals(taskId: string): Promise<TerminalInfo[]> {
  return failSafe(async () => {
    return daemon<TerminalInfo[]>(`/api/terminals?task=${encodeURIComponent(taskId)}&archived=1`);
  });
}

export async function archivedChats(kind: string): Promise<Session[]> {
  return failSafe(async () => {
    return daemon<Session[]>(`/api/sessions?kind=${encodeURIComponent(kind)}&archived=1`);
  });
}

// ---------------------------------------------------------------- notifications

export async function setNotifications(s: NotificationSettings): Promise<NotificationSettings> {
  return failSafe(async () => {
    return daemon<NotificationSettings>("/api/notifications", { method: "PATCH", json: s });
  });
}

export async function testNotification(): Promise<{ sent: boolean; skipped: string | null }> {
  return failSafe(async () => {
    return daemon("/api/notifications/test", { method: "POST" });
  });
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
  return failSafe(async () => {
    await daemon(`/api/tasks/${encodeURIComponent(taskId)}/prs`, { method: "DELETE", json: { url } });
    revalidatePath("/", "layout");
  });
}

export async function refreshTaskPrs(taskId: string): Promise<void> {
  return failSafe(async () => {
    await daemon(`/api/tasks/${encodeURIComponent(taskId)}/prs/refresh`, { method: "POST" });
    revalidatePath("/", "layout");
  });
}

// ---------------------------------------------------------------- remote machines (this machine's daemon)

/**
 * Every action that would throw instead returns its failure as a value (lib/actions throws it
 * again in the browser, message intact): in production Next strips a thrown error's message
 * before it reaches the browser, and "something failed" helps nobody.
 */
async function failSafe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    // Next's own control flow (redirect, notFound) is not a failure.
    if (err && typeof err === "object" && "digest" in err && /^NEXT_/.test(String((err as { digest?: unknown }).digest))) throw err;
    const message = err instanceof Error ? err.message.replace(/^\w+ \S+: /, "") : String(err);
    console.error(`action failed: ${message}`);
    return { jinError: message } as T;
  }
}

const fail = (err: unknown) => ({ error: err instanceof Error ? err.message.replace(/^\w+ \S+: /, "") : String(err) });
const machinePath = (id: string, rest = "") => `/api/machines/${encodeURIComponent(id)}${rest}`;

export async function listMachines(): Promise<Machine[]> {
  return failSafe(async () => {
    return daemon<Machine[]>("/api/machines", { local: true });
  });
}

export async function getMachine(id: string): Promise<Machine> {
  return failSafe(async () => {
    return daemon<Machine>(machinePath(id), { local: true });
  });
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
  return failSafe(async () => {
    await daemon(machinePath(id, "/setup"), { method: "POST", local: true });
  });
}

export async function checkMachineAuth(id: string): Promise<void> {
  return failSafe(async () => {
    await daemon(machinePath(id, "/auth"), { method: "POST", local: true });
  });
}

export async function startMachineSignIn(id: string, tool: string): Promise<void> {
  return failSafe(async () => {
    await daemon(machinePath(id, `/auth/${tool}`), { method: "POST", local: true });
  });
}

export async function cancelMachineSignIn(id: string, tool: string): Promise<void> {
  return failSafe(async () => {
    await daemon(machinePath(id, `/auth/${tool}`), { method: "DELETE", local: true });
  });
}

export async function submitMachineSignInCode(id: string, tool: string, code: string): Promise<{ error: string } | null> {
  try {
    await daemon(machinePath(id, `/auth/${tool}/code`), { method: "POST", json: { code }, local: true });
    return null;
  } catch (err) {
    return fail(err);
  }
}

/** Set a tool's token on the machine instead of signing in (a tool that takes one, e.g. Doppler for cws). */
export async function setMachineToolToken(id: string, tool: string, token: string): Promise<{ error: string } | null> {
  try {
    await daemon(machinePath(id, `/auth/${encodeURIComponent(tool)}/token`), { method: "POST", json: { token }, local: true });
    return null;
  } catch (err) {
    return fail(err);
  }
}

/** Look again for workspaces on the machine. */
export async function detectMachineWorkspaces(id: string): Promise<void> {
  return failSafe(async () => {
    await daemon(machinePath(id, "/workspaces/detect"), { method: "POST", local: true });
  });
}

export async function setupMachineWorkspace(id: string, opts: { provider: string; path?: string; source?: string }): Promise<{ error: string } | null> {
  try {
    await daemon(machinePath(id, "/workspace"), { method: "POST", json: { provider: opts.provider, path: opts.path || undefined, source: opts.source || undefined }, local: true });
    return null;
  } catch (err) {
    return fail(err);
  }
}

export async function removeMachine(id: string): Promise<void> {
  return failSafe(async () => {
    await daemon(machinePath(id), { method: "DELETE", local: true });
    revalidatePath("/", "layout");
  });
}


// ---------------------------------------------------------------- first-run setup (this machine's daemon)

export async function getSetup(): Promise<SetupState> {
  return failSafe(async () => {
    return daemon<SetupState>("/api/setup", { local: true });
  });
}

/** This machine's jin: its version and system line, for its page in Machines. */
export async function getLocalStatus(): Promise<{ version: string | null; system: string | null } | { error: string }> {
  try {
    const s = await daemon<{ version?: string | null; system?: string | null }>("/api/status", { local: true });
    return { version: s.version ?? null, system: s.system ?? null };
  } catch (err) {
    return fail(err);
  }
}

export async function checkSetupAuth(): Promise<void> {
  return failSafe(async () => {
    await daemon("/api/setup/auth", { method: "POST", local: true });
  });
}

export async function startSetupSignIn(tool: string): Promise<void> {
  return failSafe(async () => {
    await daemon(`/api/setup/auth/${tool}`, { method: "POST", local: true });
  });
}

export async function cancelSetupSignIn(tool: string): Promise<void> {
  return failSafe(async () => {
    await daemon(`/api/setup/auth/${tool}`, { method: "DELETE", local: true });
  });
}

export async function submitSetupSignInCode(tool: string, code: string): Promise<{ error: string } | null> {
  try {
    await daemon(`/api/setup/auth/${tool}/code`, { method: "POST", json: { code }, local: true });
    return null;
  } catch (err) {
    return fail(err);
  }
}

export async function adoptSetupWorkspace(path: string, provider?: string): Promise<{ error: string } | null> {
  try {
    await daemon("/api/setup/workspace", { method: "POST", json: { path, provider }, local: true });
    revalidatePath("/", "layout");
    return null;
  } catch (err) {
    return fail(err);
  }
}

export async function installSetupWorkspace(provider: string, source?: string): Promise<{ error: string } | null> {
  try {
    await daemon("/api/setup/install", { method: "POST", json: { provider, source: source || undefined }, local: true });
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
  return failSafe(async () => {
    return daemon<LiveStatus>("/api/composio");
  });
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
  return failSafe(async () => {
    await daemon("/api/composio/listener", { method: "POST", json: { on } });
  });
}

// ---------------------------------------------------------------- hooks (on the home)

export async function getHooks(): Promise<HooksStatus> {
  return failSafe(async () => {
    return daemon<HooksStatus>("/api/event-hooks");
  });
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

// ---------------------------------------------------------------- skills (on the home)

export async function getSkill(name: string): Promise<{ name: string; body: string; tags: string[] } | { error: string }> {
  try {
    return await daemon<{ name: string; body: string; tags: string[] }>(`/api/skills/${encodeURIComponent(name)}`);
  } catch (err) {
    return fail(err);
  }
}

export async function saveSkill(name: string, patch: { body?: string; tags?: string[] }): Promise<{ name: string; body: string; tags: string[] } | { error: string }> {
  try {
    const r = await daemon<{ name: string; body: string; tags: string[] }>(`/api/skills/${encodeURIComponent(name)}`, { method: "PUT", json: patch });
    revalidatePath("/skills");
    return r;
  } catch (err) {
    return fail(err);
  }
}

export async function deleteSkill(name: string): Promise<{ removed: boolean } | { error: string }> {
  try {
    const r = await daemon<{ removed: boolean }>(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
    revalidatePath("/skills");
    return r;
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------- what a task follows

export async function getActivity(taskId: string): Promise<TaskActivity | { error: string }> {
  try {
    return await daemon<TaskActivity>(`/api/tasks/${encodeURIComponent(taskId)}/activity`);
  } catch (err) {
    return fail(err);
  }
}

export async function addTaskLink(taskId: string, url: string, machine?: string): Promise<TaskLink | { error: string }> {
  try {
    return await daemon<TaskLink>(`/api/tasks/${encodeURIComponent(taskId)}/links`, { method: "POST", json: { url }, machine });
  } catch (err) {
    return fail(err);
  }
}

export async function removeTaskLink(taskId: string, key: string, machine?: string): Promise<{ removed: boolean } | { error: string }> {
  try {
    return await daemon<{ removed: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/links?key=${encodeURIComponent(key)}`, { method: "DELETE", machine });
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------- reviewing PRs as tasks

/** A review task for these PRs (links or <repo>#<n>) on this machine, or the one already reviewing them. */
export async function startReview(prs: string[], prompt?: string, setup?: boolean, links?: string[], machine?: string): Promise<{ taskId: string; existing: boolean } | { error: string }> {
  try {
    const r = await daemon<{ taskId: string; existing: boolean }>("/api/reviews", { method: "POST", json: { prs, prompt, setup, links }, machine });
    revalidatePath("/", "layout");
    return r;
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------- what notifies (on the home)

export async function getNotificationKinds(): Promise<NotificationKinds[]> {
  return failSafe(async () => {
    return daemon<NotificationKinds[]>("/api/notifications/kinds");
  });
}

export async function chooseNotificationKinds(app: string, kinds: string[]): Promise<NotificationKinds[] | { error: string }> {
  try {
    await daemon<NotificationSettings>("/api/notifications", { method: "PATCH", json: { sources: { [app]: kinds } } });
    return await daemon<NotificationKinds[]>("/api/notifications/kinds");
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------- work journal (the task's machine)

/** The task's journal, or why it cannot be shown (an error thrown here would reach the page as React's unreadable #441). */
export async function getJournal(taskId: string): Promise<JournalView | { error: string }> {
  try {
    return await daemon<JournalView>(`/api/tasks/${encodeURIComponent(taskId)}/journal`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/journal: not found$/.test(message)) {
      const machine = await currentMachine();
      return { error: `jin on ${machine === "local" ? "this machine" : machine} is older and has no journal yet. Update jin there (Machines → Update jin).` };
    }
    return { error: message };
  }
}

/** Claude Code's user settings on a machine ("local": this one). */
export async function getClaudeSettings(machine: string): Promise<ClaudeSettingsFile | { error: string }> {
  try {
    return await daemon<ClaudeSettingsFile>("/api/claude-settings", { machine });
  } catch (err) {
    return fail(err);
  }
}

/** Write them, if the file is still the version `base` names. */
export async function saveClaudeSettings(machine: string, settings: Record<string, unknown>, base: string): Promise<ClaudeSettingsFile | { error: string }> {
  try {
    return await daemon<ClaudeSettingsFile>("/api/claude-settings", { machine, method: "PUT", json: { settings, base } });
  } catch (err) {
    return fail(err);
  }
}

export async function getAgentSettings(machine: string, agent: HarnessSettingsFile["agent"]): Promise<HarnessSettingsFile | { error: string }> {
  try {
    return await daemon<HarnessSettingsFile>(`/api/agents/${agent}/settings`, { machine });
  } catch (err) {
    return fail(err);
  }
}

/** Save a coding agent's settings: the forms' object, or the file's text edited by hand. */
export async function saveAgentSettings(machine: string, agent: HarnessSettingsFile["agent"], change: { settings: Record<string, unknown> } | { text: string }, base: string): Promise<HarnessSettingsFile | { error: string }> {
  try {
    return await daemon<HarnessSettingsFile>(`/api/agents/${agent}/settings`, { machine, method: "PUT", json: { ...change, base } });
  } catch (err) {
    return fail(err);
  }
}

/** The skills a chat of this kind can run (for the composer's / picker). */
export async function chatSkills(kind: string): Promise<ChatSkill[]> {
  return daemon<ChatSkill[]>(`/api/chat-skills?kind=${encodeURIComponent(kind)}`, { timeoutMs: 30_000 }).catch(() => []);
}

// ---------------------------------------------------------------- jin docs (on the home)

const docPath = (id: string) => `/api/docs/${encodeURIComponent(id)}`;

export async function listDocs(q?: string, tag?: string): Promise<DocSummary[]> {
  return failSafe(async () => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (tag) qs.set("tag", tag);
    return daemon<DocSummary[]>(`/api/docs${qs.size ? `?${qs}` : ""}`);
  });
}

export async function createDoc(title?: string, body?: string): Promise<Doc | { error: string }> {
  try {
    const d = await daemon<Doc>("/api/docs", { method: "POST", json: { title: title ?? "", body: body ?? "" } });
    revalidatePath("/", "layout");
    return d;
  } catch (err) {
    return fail(err);
  }
}

export async function getDoc(id: string): Promise<DocFull | { error: string }> {
  try {
    return await daemon<DocFull>(docPath(id), { timeoutMs: 8_000 });
  } catch (err) {
    return fail(err);
  }
}

/** Save a doc's text, title or tags; `base` is the version the change was made on (409 when it moved). */
export async function saveDoc(id: string, patch: { title?: string; body?: string; tags?: string[] }, base: number): Promise<Doc | { error: string; conflict?: boolean }> {
  try {
    return await daemon<Doc>(docPath(id), { method: "PUT", json: { ...patch, base } });
  } catch (err) {
    const f = fail(err);
    return { ...f, conflict: /changed since you opened it/.test(f.error) };
  }
}

export async function archiveDoc(id: string, archived = true): Promise<void> {
  return failSafe(async () => {
    await daemon(docPath(id), { method: "PATCH", json: { archived } });
    revalidatePath("/", "layout");
  });
}

export async function commentDoc(id: string, text: string, anchor: DocAnchor | null): Promise<DocThread | { error: string }> {
  try {
    return await daemon<DocThread>(`${docPath(id)}/threads`, { method: "POST", json: { text, anchor } });
  } catch (err) {
    return fail(err);
  }
}

export async function replyDoc(id: string, threadId: string, text: string): Promise<DocThread | { error: string }> {
  try {
    return await daemon<DocThread>(`${docPath(id)}/threads/${encodeURIComponent(threadId)}/comments`, { method: "POST", json: { text } });
  } catch (err) {
    return fail(err);
  }
}

export async function resolveDocThread(id: string, threadId: string, resolved: boolean): Promise<DocThread | { error: string }> {
  try {
    return await daemon<DocThread>(`${docPath(id)}/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", json: { resolved } });
  } catch (err) {
    return fail(err);
  }
}

export async function decideDocSuggestion(id: string, suggestionId: string, accept: boolean, base: number): Promise<{ doc: Doc; suggestion: DocSuggestion } | { error: string }> {
  try {
    return await daemon<{ doc: Doc; suggestion: DocSuggestion }>(`${docPath(id)}/suggestions/${encodeURIComponent(suggestionId)}/${accept ? "accept" : "reject"}`, { method: "POST", json: { base } });
  } catch (err) {
    return fail(err);
  }
}

/** Ask jin in the doc's chat (it starts on first use). */
export async function askDoc(id: string, prompt: string, choice: RunChoice = {}): Promise<{ id: string }> {
  return failSafe(async () => {
    const r = await daemon<{ chatId: string }>(`${docPath(id)}/ask`, { method: "POST", json: { prompt, ...choice } });
    return { id: r.chatId };
  });
}

/** A doc chat's session and its events (when jin's chat for a doc started from a comment). */
export async function docChat(chatId: string): Promise<{ session: Session; events: SessionEvent[] } | null> {
  try {
    const [session, events] = await Promise.all([daemon<Session>(`/api/sessions/${encodeURIComponent(chatId)}`), daemon<SessionEvent[]>(`/api/sessions/${encodeURIComponent(chatId)}/events`)]);
    return { session, events };
  } catch {
    return null;
  }
}

export async function docVersions(id: string): Promise<DocVersion[]> {
  return failSafe(async () => {
    return daemon<DocVersion[]>(`${docPath(id)}/versions`);
  });
}

export async function docVersion(id: string, version: number): Promise<{ version: number; title: string; body: string; by: string; at: string }> {
  return failSafe(async () => {
    return daemon(`${docPath(id)}/versions/${version}`);
  });
}

export async function restoreDocVersion(id: string, version: number, base: number): Promise<Doc | { error: string }> {
  try {
    return await daemon<Doc>(`${docPath(id)}/versions/${version}/restore`, { method: "POST", json: { base } });
  } catch (err) {
    return fail(err);
  }
}

/** A doc for a task (from its "+" menu): tagged with the task, linked to it, so its Claude Code can read it. */
export async function createTaskDoc(taskId: string): Promise<Doc | { error: string }> {
  try {
    const d = await daemon<Doc>("/api/docs", { method: "POST", json: { title: "", body: "", tags: [taskId.toLowerCase()] } });
    // The link lives with the task, on the task's machine (the doc lives on jin's home).
    await daemon(`/api/tasks/${encodeURIComponent(taskId)}/links`, { method: "POST", json: { url: `doc:${d.id}` } }).catch(() => {});
    revalidatePath("/", "layout");
    return d;
  } catch (err) {
    return fail(err);
  }
}

/** What a doc tab in a task needs: the doc, its chat with jin, and where the chat streams from. */
export async function docTab(id: string): Promise<{ doc: DocFull; chat: { session: Session; events: SessionEvent[] } | null; wsBase: string } | { error: string }> {
  try {
    const doc = await daemon<DocFull>(docPath(id));
    const chat = doc.chatId ? await docChat(doc.chatId) : null;
    return { doc, chat, wsBase: await daemonWsBase({ home: true }) };
  } catch (err) {
    return fail(err);
  }
}

/** Name a task's doc link after the doc's title (linking again looks the title up). */
export async function relabelTaskDoc(taskId: string, docId: string): Promise<void> {
  await daemon(`/api/tasks/${encodeURIComponent(taskId)}/links`, { method: "POST", json: { url: `doc:${docId}` } }).catch(() => {});
}

export async function renameDoc(id: string, title: string): Promise<Doc | { error: string }> {
  try {
    const d = await daemon<Doc>(docPath(id), { method: "PATCH", json: { title } });
    revalidatePath("/", "layout");
    return d;
  } catch (err) {
    return fail(err);
  }
}

export async function duplicateDoc(id: string): Promise<Doc | { error: string }> {
  try {
    const d = await daemon<Doc>(`${docPath(id)}/duplicate`, { method: "POST" });
    revalidatePath("/", "layout");
    return d;
  } catch (err) {
    return fail(err);
  }
}

/** Delete a doc for good (its versions, comments and suggestions too). */
export async function deleteDoc(id: string): Promise<{ deleted: true } | { error: string }> {
  try {
    await daemon(docPath(id), { method: "DELETE" });
    revalidatePath("/", "layout");
    return { deleted: true };
  } catch (err) {
    return fail(err);
  }
}

/** Every open task on every machine that answers, for "move to task". */
export async function taskTargets(): Promise<{ id: string; title: string; machine: string; machineLabel: string }[]> {
  const machines = await daemon<Machine[]>("/api/machines", { local: true }).catch(() => [] as Machine[]);
  const places = [{ id: "local", label: "This machine" }, ...machines.filter((m) => m.connected).map((m) => ({ id: m.id, label: m.label }))];
  const lists = await Promise.all(
    places.map((m) =>
      daemon<{ id: string; title: string | null; slug: string; state: string; archived?: boolean }[]>("/api/tasks", { machine: m.id, timeoutMs: 4000 })
        .then((ts) => ts.filter((t) => t.state === "ready" && !t.archived).map((t) => ({ id: t.id, title: t.title ?? t.slug, machine: m.id, machineLabel: m.label })))
        .catch(() => []),
    ),
  );
  return lists.flat();
}

// ---------------------------------------------------------------- a task's agent room

const roomPath = (taskId: string, rest = "") => `/api/tasks/${encodeURIComponent(taskId)}/room${rest}`;

/** The room: its agents and what they do now, messages after `after`, what waits on you. */
export async function getRoom(taskId: string, after = 0): Promise<RoomState | { error: string }> {
  try {
    return await daemon<RoomState>(roomPath(taskId, `?after=${after}`));
  } catch (err) {
    return fail(err);
  }
}

/** Say something in the room: the agents you @-mention take a turn. */
export async function postRoomMessage(taskId: string, text: string): Promise<RoomMessage | { error: string }> {
  try {
    return await daemon<RoomMessage>(roomPath(taskId, "/messages"), { method: "POST", json: { text } });
  } catch (err) {
    return fail(err);
  }
}

export async function pinRoomMessage(taskId: string, seq: number, pinned: boolean): Promise<RoomMessage | { error: string }> {
  try {
    return await daemon<RoomMessage>(roomPath(taskId, `/messages/${seq}`), { method: "PATCH", json: { pinned } });
  } catch (err) {
    return fail(err);
  }
}

/** Add an agent to the room (no id), or change one's profile. */
export async function saveRoomAgent(taskId: string, id: string | null, profile: RoomProfile): Promise<RoomAgent | { error: string }> {
  try {
    return await daemon<RoomAgent>(roomPath(taskId, id ? `/agents/${encodeURIComponent(id)}` : "/agents"), { method: id ? "PATCH" : "POST", json: profile });
  } catch (err) {
    return fail(err);
  }
}

/** Remove an agent, stop its turn, or start it over with a new session ("fresh"). */
export async function roomAgentAction(taskId: string, id: string, action: "remove" | "stop" | "fresh"): Promise<{ ok: true } | { error: string }> {
  try {
    const path = roomPath(taskId, `/agents/${encodeURIComponent(id)}`);
    await daemon(action === "remove" ? path : `${path}/${action}`, { method: action === "remove" ? "DELETE" : "POST" });
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** An agent's own steps (its session's events): for you to look at, never shown to the other agents. */
export async function roomAgentEvents(taskId: string, id: string, after = 0): Promise<SessionEvent[]> {
  return daemon<SessionEvent[]>(roomPath(taskId, `/agents/${encodeURIComponent(id)}/events?after=${after}`)).catch(() => []);
}

export async function decideRoomApproval(taskId: string, approvalId: string, decision: "approve" | "reject"): Promise<{ ok: true } | { error: string }> {
  try {
    await daemon(roomPath(taskId, `/approvals/${encodeURIComponent(approvalId)}`), { method: "POST", json: { decision } });
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** For the task's Room tab: agents working, agents waiting on you, the last message. */
export async function roomStatus(taskId: string): Promise<RoomTabStatus | null> {
  return daemon<RoomTabStatus>(roomPath(taskId, "/status")).catch(() => null);
}
export type RoomTabStatus = { working: number; waiting: number; lastSeq: number; name: string | null };

/** Name the room (its tab's title); an empty name goes back to "Room". */
export async function renameRoom(taskId: string, name: string): Promise<RoomTabStatus | { error: string }> {
  try {
    return await daemon<RoomTabStatus>(roomPath(taskId, ""), { method: "PATCH", json: { name } });
  } catch (err) {
    return fail(err);
  }
}

/** Start the room over: its messages go, every agent begins a new session (the agents stay). */
export async function clearRoom(taskId: string): Promise<{ ok: true } | { error: string }> {
  try {
    await daemon(roomPath(taskId, "/messages"), { method: "DELETE" });
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** Background failures on a machine (this one unless named). */
export async function listProblems(machine?: string): Promise<Problem[]> {
  return daemon<Problem[]>("/api/problems", { machine, timeoutMs: 4000 }).catch(() => []);
}

export async function clearProblems(machine: string): Promise<{ ok: true } | { error: string }> {
  try {
    await daemon("/api/problems", { method: "DELETE", machine });
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
