import { z } from "zod";
import type { WorkspaceAdapter } from "./adapters";
import type { WorkspaceConfig } from "./config";
import { collectGithub, type Feed } from "./feed";
import type { JinTool } from "./harness";
import type { Sessions } from "./sessions";
import type { TaskPRs } from "./prs";
import type { Tasks } from "./tasks";
import type { TaskJobs } from "./jobs";
import { HOOK_EVENTS, type Hook, type Hooks } from "./hooks";
import { openTerminal, type ClaudeLaunch, type Terminals } from "./terminals";

export const CHAT_KINDS = ["jin", "slack", "linear", "notion", "gmail", "github"] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];
export type SessionKind = ChatKind | "task";

export const isChatKind = (k: string): k is ChatKind => (CHAT_KINDS as readonly string[]).includes(k);

const OUTWARD =
  "Anything that sends or changes something outside this machine (a message, a comment, an issue update, an email) is held for the user's approval by jin; draft it, then make the call, and the user decides.";

/** What each chat is for, appended to Claude's system prompt. */
export function chatInstructions(kind: SessionKind, workspace: WorkspaceConfig | undefined): string | undefined {
  const ws = workspace ? `The user's workspace is ${workspace.id} at ${workspace.root} (${workspace.adapter}).` : "";
  switch (kind) {
    case "jin":
      return [
        "You are jin, the user's orchestrator. You run on their machine; you are not the coding agent.",
        ws,
        "Your job: catch the user up, help them decide what matters, and hand work to task agents.",
        "- When asked to catch up (or at the start of a conversation), call jin_catch_up and give a short brief: what is blocked on them first (approvals, failing checks on their PRs, review requests), then what changed, then what can wait. Number the items so the user can say 'take 2'.",
        "- To work on something: propose a task id, type and the repos it touches (read docs/map/README.md in the workspace when unsure which repos), confirm with the user, then call jin_start_task with a clear prompt for Claude Code. It returns at once and sets up in the background. Use jin_start_agent only to open another Claude Code session in an existing task. Coding happens there, not here.",
        "- Hooks run an agent with fixed instructions when an event happens (a task's PR merged, all its PRs merged, a live event from Slack, Linear, Notion, Gmail or GitHub). jin_list_hooks shows them; jin_save_hook creates or changes one once the user agrees; jin_delete_hook removes one.",
        "- jin_update_feed snoozes, dismisses or marks items done once the user decides (several at once with itemIds).",
        "- jin_archive_task closes tasks the user is finished with: they leave the sidebar, their worktrees and branches stay (archived: false brings one back). jin_remove_task deletes a finished task's worktrees and branches; it refuses if work would be lost, and the user approves each call. Use it only when the user asks or during a merge cleanup.",
        "- Work can live on other machines (dev VMs the user added): jin_list_machines lists them; jin_list_tasks and jin_catch_up cover every connected machine. To start a task or a Claude Code session on one, pass its id as `machine`; when the user does not say where and more than one machine has the workspace, ask. Links to another machine's task look like /m/<machine>/t/<task>.",
        "Be brief and concrete. Link PRs and issues by URL.",
      ].join("\n");
    case "slack":
      return `You are jin's Slack desk. Use the Slack MCP tools to catch the user up on DMs, mentions and threads they are in, summarise what needs a reply, and draft replies in the user's voice. ${OUTWARD} If no Slack tools are available, say so and tell the user to run \`cws connect\` (or \`claude mcp add --transport http --scope user slack https://mcp.slack.com/mcp\`) and sign in.`;
    case "linear":
      return `You are jin's Linear desk. Use the Linear MCP tools to show the user's assigned issues and current cycle, what changed, and comments that need an answer. When the user wants to work on an issue, say so: they can start a task from jin's chat. ${OUTWARD} If no Linear tools are available, tell the user to run \`cws connect\` and sign in.`;
    case "notion":
      return `You are jin's Notion desk. Use the Notion MCP tools to find design docs and runbooks, answer from them with links, and surface comments and mentions. ${OUTWARD} If no Notion tools are available, tell the user to run \`cws connect\` and sign in.`;
    case "gmail":
      return `You are jin's Gmail desk. Use Gmail MCP tools, if available, to find mail that needs a reply and draft replies. ${OUTWARD} If no Gmail tools are available, say so plainly: Gmail is not connected to the user's Claude (claude.ai → Settings → Connectors → Gmail).`;
    case "github":
      return [
        "You are jin's GitHub desk. Use the gh CLI (already logged in) to catch the user up on comments on their pull requests, replies to their review comments, and review threads waiting on them. Prefer `gh api graphql` and `gh pr view --comments`.",
        "Summarise each thread in a line with its URL and what the user needs to do. Draft replies when asked.",
        OUTWARD,
        ws,
      ].join("\n");
    case "task":
      return undefined; // the workspace's own CLAUDE.md and skills apply
  }
}

/** A machine-aware view of jin's daemons: this one ("local") and each connected remote machine. */
export interface MachineAccess {
  list(): { id: string; label: string; connected: boolean; workspace: string | null; host: string }[];
  call<T>(id: string, method: string, path: string, payload?: unknown): Promise<T>;
}

/** Orchestration tools for jin's own chat. */
export function jinTools(deps: { feed: Feed; tasks: Tasks; sessions: Sessions; adapters: Map<string, WorkspaceAdapter>; workspaces: WorkspaceConfig[]; terminals: Terminals; claude: ClaudeLaunch; jobs: TaskJobs; prs?: TaskPRs; machines?: MachineAccess; hooks?: Hooks }): JinTool[] {
  const { feed, tasks, sessions, adapters, workspaces, terminals, claude, jobs, prs, machines, hooks } = deps;
  const remote = (id: string | undefined) => (id && id !== "local" ? id : null);
  const connected = () => (machines?.list() ?? []).filter((m) => m.connected);
  const link = (machine: string | null, taskId: string) => (machine ? `/m/${machine}/t/${taskId}` : `/t/${taskId}`);
  const machineArg = z.string().optional().describe('a machine id from jin_list_machines; omit (or "local") for this machine');
  /** Each connected machine's answer to `path`, tagged with the machine; one that fails is reported, not fatal. */
  const everyMachine = async <T>(path: string) =>
    Promise.all(
      connected().map(async (m) => {
        try {
          return { machine: m.id, label: m.label, data: await machines!.call<T>(m.id, "GET", path) };
        } catch (err) {
          return { machine: m.id, label: m.label, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  return [
    {
      name: "jin_list_machines",
      description: "The machines jin works on: this one (\"local\") and each remote machine the user added (a dev VM), with whether it is connected and its workspace.",
      input: {},
      run: async () => [
        { id: "local", label: "this machine", connected: true, workspaces: workspaces.map((w) => `${w.id} at ${w.root}`) },
        ...(machines?.list() ?? []).map((m) => ({ id: m.id, label: m.label, host: m.host, connected: m.connected, workspace: m.workspace })),
      ],
    },
    {
      name: "jin_catch_up",
      description: "What needs the user: pending approvals, open feed items (GitHub reviews, failing checks, mentions), and running agents.",
      input: {},
      run: async () => ({
        approvals: sessions.approvals("pending").map((a) => ({ id: a.id, sessionId: a.sessionId, action: a.action, reason: a.reason })),
        feed: feed
          .list()
          .filter((i) => i.state === "new")
          .map((i) => ({ id: i.id, kind: i.kind, title: i.title, summary: i.summary, url: i.externalRef, workspace: i.workspace })),
        agents: terminals
          .list()
          .filter((t) => t.kind === "claude" && t.status !== "exited")
          .map((t) => ({ terminalId: t.id, taskId: t.taskId, status: t.status })),
        // Other machines: their approvals and Claude Code sessions (open one with its link).
        machines: await Promise.all(
          connected().map(async (m) => {
            try {
              const [approvals, terms] = await Promise.all([
                machines!.call<{ id: string; action: unknown; reason: string }[]>(m.id, "GET", "/api/approvals?state=pending"),
                machines!.call<{ id: string; kind: string; taskId: string | null; status: string }[]>(m.id, "GET", "/api/terminals"),
              ]);
              return {
                machine: m.id,
                approvals: approvals.map((a) => ({ id: a.id, action: a.action, reason: a.reason })),
                agents: terms.filter((t) => t.kind === "claude" && t.status !== "exited").map((t) => ({ taskId: t.taskId, status: t.status, open: t.taskId ? link(m.id, t.taskId) : undefined })),
              };
            } catch (err) {
              return { machine: m.id, error: err instanceof Error ? err.message : String(err) };
            }
          }),
        ),
      }),
    },
    {
      name: "jin_refresh_github",
      description: "Pull new review requests, failing checks on the user's PRs, and mentions from GitHub into the feed.",
      input: {},
      run: async () => ({ added: feed.add(await collectGithub(workspaces)) }),
    },
    {
      name: "jin_list_repos",
      description: "Repos in a workspace, with their branches and descriptions.",
      input: { workspace: z.string().optional().describe("workspace id; defaults to the first"), machine: machineArg },
      run: async (a) => {
        const on = remote(a.machine as string | undefined);
        if (on) {
          const ws = (a.workspace as string | undefined) ?? (await machines!.call<{ id: string }[]>(on, "GET", "/api/workspaces"))[0]?.id;
          if (!ws) throw new Error(`${on} has no workspace yet`);
          return machines!.call(on, "GET", `/api/workspaces/${encodeURIComponent(ws)}/repos`);
        }
        const id = (a.workspace as string | undefined) ?? workspaces[0]?.id;
        const adapter = id ? adapters.get(id) : undefined;
        if (!adapter) throw new Error(`unknown workspace ${id}`);
        return adapter.repos();
      },
    },
    {
      name: "jin_list_tasks",
      description: "The user's tasks on every connected machine (or one, with machine), their state, and the pull requests attached to each (state, review, checks).",
      input: { machine: machineArg },
      run: async (a) => {
        type T = { id: string; workspace: string; title: string | null; slug: string; repos: string[]; state: string; archived?: boolean; parent?: string | null };
        type P = { taskId: string; url: string; title: string | null; state: string | null; draft: boolean; review: string | null; checks: string | null };
        const shape = (machine: string | null, list: T[], prList: P[]) =>
          list.map((t) => ({
            machine: machine ?? "local",
            id: t.id,
            workspace: t.workspace,
            title: t.title ?? t.slug,
            repos: t.repos,
            state: t.state,
            ...(t.archived ? { archived: true } : {}),
            ...(t.parent ? { subtaskOf: t.parent } : {}),
            open: link(machine, t.id),
            pullRequests: prList.filter((p) => p.taskId === t.id).map((p) => ({ url: p.url, title: p.title, state: p.draft && p.state === "OPEN" ? "DRAFT" : p.state, review: p.review, checks: p.checks })),
          }));
        const only = a.machine as string | undefined;
        const here = !only || only === "local" ? shape(null, tasks.list(), prs?.list() ?? []) : [];
        const there = (await everyMachine<T[]>("/api/tasks")).filter((r) => !only || only === r.machine);
        const out: unknown[] = [...here];
        for (const r of there) {
          if ("error" in r) out.push({ machine: r.machine, error: r.error });
          else out.push(...shape(r.machine, r.data as T[], await machines!.call<P[]>(r.machine, "GET", "/api/prs").catch(() => [])));
        }
        return out;
      },
    },
    {
      name: "jin_start_task",
      description:
        "Create a task in the background: a branch and worktree per repo (the workspace's own tooling), then its setup. Returns at once; the task shows in jin's sidebar with live setup progress. With a prompt, Claude Code opens in the task with it once setup is done, so no separate hand-off is needed. Confirm the id, type and repos with the user first.",
      input: {
        taskId: z.string().describe("e.g. a Linear issue id like PLEN-123"),
        repos: z.array(z.string()).min(1),
        slug: z.string().describe("short title"),
        type: z.enum(["feature", "enhancement", "refactor", "patch", "bug"]).optional(),
        prompt: z.string().optional().describe("what Claude Code should do once the task is ready"),
        setup: z.boolean().optional().describe("run each repo's setup (installs); default true"),
        workspace: z.string().optional(),
        feedItemId: z.string().optional().describe("the feed item this task comes from, if any"),
        machine: machineArg,
      },
      run: async (a) => {
        const on = remote(a.machine as string | undefined);
        if (on) {
          const job = await machines!.call<{ taskId: string }>(on, "POST", "/api/task-jobs", { id: a.taskId, repos: a.repos, slug: a.slug, type: a.type, setup: a.setup, prompt: a.prompt, workspace: a.workspace });
          return { setting_up: job.taskId, machine: on, open: link(on, job.taskId), note: `Setup runs on ${on} in the background; the task page shows progress.` };
        }
        const workspace = (a.workspace as string | undefined) ?? workspaces[0]?.id;
        if (!workspace) throw new Error("no workspace configured");
        const job = await jobs.start(
          workspace,
          { id: a.taskId as string, repos: a.repos as string[], slug: a.slug as string, type: a.type as string | undefined },
          { setup: a.setup as boolean | undefined, prompt: a.prompt as string | undefined, feedItemId: a.feedItemId as string | undefined },
        );
        return { setting_up: job.taskId, open: `/t/${job.taskId}`, note: "Setup runs in the background; the task page shows progress." };
      },
    },
    {
      name: "jin_start_agent",
      description: "Open Claude Code in a task's worktree, started with a prompt. The user watches and steers it in jin's task view; jin blocks deploys and pushes or PRs need the user's approval.",
      input: { taskId: z.string(), prompt: z.string(), machine: machineArg },
      run: async (a) => {
        const on = remote(a.machine as string | undefined);
        if (on) {
          const t = await machines!.call<{ id: string; taskId: string }>(on, "POST", "/api/terminals", { taskId: a.taskId, kind: "claude", prompt: a.prompt });
          return { terminalId: t.id, taskId: t.taskId, machine: on, open: link(on, t.taskId) };
        }
        const t = openTerminal({ terminals, tasks, workspaces, claude }, { taskId: a.taskId as string, kind: "claude", prompt: a.prompt as string });
        return { terminalId: t.id, taskId: t.taskId, open: `/t/${t.taskId}` };
      },
    },
    {
      name: "jin_archive_task",
      description:
        "Close (archive) tasks the user is done with: they leave jin's sidebar and task list; worktrees, branches and history stay. archived: false reopens. Confirm with the user first.",
      input: { taskIds: z.array(z.string()).min(1), archived: z.boolean().optional().describe("default true; false brings tasks back"), machine: machineArg },
      run: async (a) => {
        const archived = (a.archived as boolean | undefined) ?? true;
        const on = remote(a.machine as string | undefined);
        const out: unknown[] = [];
        for (const id of a.taskIds as string[]) {
          try {
            const t = on ? await machines!.call<{ id: string; archived: boolean }>(on, "PATCH", `/api/tasks/${encodeURIComponent(id)}`, { archived }) : tasks.update(id, { archived });
            out.push({ id: t.id, archived: t.archived, ...(on ? { machine: on } : {}) });
          } catch (err) {
            out.push({ id, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return out;
      },
    },
    {
      name: "jin_remove_task",
      description:
        "Remove a finished task's worktrees and local branches. Refuses when anything would be lost (uncommitted changes, commits on no remote) and says what. The user approves each call.",
      input: { taskId: z.string(), machine: machineArg },
      run: async (a) => {
        const on = remote(a.machine as string | undefined);
        const id = a.taskId as string;
        const t = on ? await machines!.call<{ id: string; state: string }>(on, "POST", `/api/tasks/${encodeURIComponent(id)}/remove-if-clean`) : await tasks.removeIfClean(id);
        return { id: t.id, state: t.state, ...(on ? { machine: on } : {}) };
      },
    },
    ...(hooks
      ? ([
          {
            name: "jin_list_hooks",
            description: "The user's hooks (an event, an optional filter, and fixed instructions an agent runs when it fires), the events hooks can use with their fields, and recent runs.",
            input: {},
            run: async () => ({ hooks: hooks.list(), events: HOOK_EVENTS, recentRuns: hooks.runs().slice(0, 10) }),
          },
          {
            name: "jin_save_hook",
            description:
              "Create a hook (no id) or change one: when `event` happens and the event's fields match `filter`, jin starts an agent with `instructions` and the event's details. Instructions are fixed text: write them as steps an agent can follow. Anything outward the agent does still waits for the user's approval. Confirm the hook with the user before saving.",
            input: {
              id: z.string().optional(),
              name: z.string().optional(),
              event: z.enum(["pr.merged", "task.merged", "live.event"]).optional(),
              filter: z.record(z.string(), z.string()).optional().describe('field → value, e.g. {"toolkit": "slack", "forYou": "true"}; "/pattern/" matches a pattern'),
              instructions: z.string().optional(),
              enabled: z.boolean().optional(),
            },
            run: async (a) => hooks.save(a as Partial<Hook>, "jin"),
          },
          {
            name: "jin_delete_hook",
            description: "Delete a hook. Confirm with the user first; disabling (jin_save_hook with enabled: false) keeps it.",
            input: { id: z.string() },
            run: async (a) => {
              hooks.remove(a.id as string);
              return { removed: a.id };
            },
          },
        ] satisfies JinTool[])
      : []),
    {
      name: "jin_update_feed",
      description: "Snooze (24h), dismiss or mark feed items done: one (itemId) or several (itemIds).",
      input: { itemId: z.string().optional(), itemIds: z.array(z.string()).optional(), action: z.enum(["snooze", "dismiss", "done"]) },
      run: async (a) => {
        const ids = [...((a.itemIds as string[] | undefined) ?? []), ...(a.itemId ? [a.itemId as string] : [])];
        if (!a.itemId && !a.itemIds) throw new Error("give itemId or itemIds");
        const one = (id: string) =>
          a.action === "snooze" ? feed.setState(id, "snoozed", { snoozedUntil: new Date(Date.now() + 86_400_000).toISOString() }) : feed.setState(id, a.action === "done" ? "done" : "dismissed");
        const results = ids.map((id) => {
          try {
            const i = one(id);
            return { id: i.id, state: i.state, title: i.title };
          } catch (err) {
            return { id, error: err instanceof Error ? err.message : String(err) };
          }
        });
        return ids.length === 1 && !a.itemIds ? one(ids[0]!) : results;
      },
    },
  ];
}
