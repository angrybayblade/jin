import { notFound } from "next/navigation";
import { Chat } from "@/components/Chat";
import { TodayPanel } from "@/components/TodayPanel";
import { Panes } from "@/components/Panes";
import { daemon, daemonWsBase, type Approval, type ChatKind, type DeskStatus, type FeedItem, type Session, type SessionEvent } from "@/lib/daemon";

export const dynamic = "force-dynamic";

const DESK: Record<Exclude<ChatKind, "jin">, { label: string; body: string; suggestions: string[]; connect: string }> = {
  github: {
    label: "GitHub",
    body: "Comments on your pull requests, replies to your review comments, and threads waiting on you. Uses your gh login.",
    suggestions: ["What are people saying on my PRs?", "Which review threads are waiting on me?", "Replies to my comments since yesterday"],
    connect: "Uses the gh CLI; `gh auth status` should show you logged in.",
  },
  slack: {
    label: "Slack",
    body: "DMs, mentions and threads you are in, with drafted replies. Sending waits for your approval.",
    suggestions: ["Catch me up on Slack", "Which threads need a reply from me?", "Draft a reply to the latest DM"],
    connect: "Uses Slack from your Claude: the claude.ai Slack connector, or a Slack MCP server in your Claude settings.",
  },
  linear: {
    label: "Linear",
    body: "Your issues and cycle, what changed, and comments waiting on you. Start a task from jin's chat.",
    suggestions: ["What's assigned to me this cycle?", "What changed on my issues today?", "Which issue should I pick up next?"],
    connect: "Uses Linear from your Claude: the claude.ai Linear connector, or a Linear MCP server in your Claude settings.",
  },
  notion: {
    label: "Notion",
    body: "Design docs and runbooks, answered with links, plus comments and mentions.",
    suggestions: ["Find the runbook for Thermos incidents", "Any Notion comments for me?", "Summarise the latest design doc on tool routing"],
    connect: "Uses Notion from your Claude: the claude.ai Notion connector, or a Notion MCP server in your Claude settings.",
  },
  gmail: {
    label: "Gmail",
    body: "Mail that needs a reply, with drafts. Sending waits for your approval.",
    suggestions: ["What needs a reply today?", "Summarise unread mail from people", "Draft a reply to the latest thread"],
    connect: "Uses Gmail from your Claude: the claude.ai Gmail connector.",
  },
};

/** One line on whether the desk can reach its service, and what to do when it cannot. */
function connectionNote(label: string, s: DeskStatus | undefined): { ok: boolean; text: string } {
  if (!s) return { ok: true, text: `Checking ${label}…` };
  if (s.state === "connected") return { ok: true, text: s.kind === "github" ? "Connected through your gh login." : `Connected through ${s.via}.` };
  if (s.kind === "github") return { ok: false, text: "gh is not signed in: run gh auth login (or use Set up jin)." };
  if (s.state === "needs-auth") return { ok: false, text: `${s.via} needs you to sign in again: claude.ai → Settings → Connectors, or /mcp in Claude Code.` };
  if (s.state === "failed") return { ok: false, text: `${s.via} did not connect. Check it in claude.ai → Settings → Connectors.` };
  return { ok: false, text: `${label} is not connected to your Claude. Connect it in claude.ai → Settings → Connectors, then reload.` };
}

/** A knowledge desk: a chat with its own instructions and tools, plus context on the right. */
export default async function DeskPage({ params, searchParams }: { params: Promise<{ kind: string }>; searchParams: Promise<{ chat?: string }> }) {
  const { kind } = await params;
  if (!(kind in DESK)) notFound();
  const desk = DESK[kind as keyof typeof DESK];
  const [sessions, approvals, feed, desks] = await Promise.all([
    daemon<Session[]>(`/api/sessions?kind=${kind}`),
    daemon<Approval[]>("/api/approvals?state=pending"),
    kind === "github" ? daemon<FeedItem[]>("/api/feed") : Promise.resolve([] as FeedItem[]),
    daemon<DeskStatus[]>("/api/desks", { timeoutMs: 8000 }).catch(() => null),
  ]);
  const connection = connectionNote(desk.label, desks?.find((d) => d.kind === kind));
  // The open tab: ?chat=<id>, ?chat=new for a fresh one, else the newest chat.
  const want = (await searchParams).chat;
  const session = want === "new" ? null : (sessions.find((s) => s.id === want) ?? sessions[0] ?? null);
  const events = session ? await daemon<SessionEvent[]>(`/api/sessions/${session.id}/events`) : [];
  return (
    <Panes id="desk" defaultSplit={70} left={<>
      <Chat
        key={session?.id ?? "new"}
        chats={sessions}
        kind={kind as ChatKind}
        session={session}
        initialEvents={events}
        approvals={approvals.filter((a) => sessions.some((s) => s.id === a.sessionId))}
        wsBase={await daemonWsBase({ home: true })}
        title={desk.label}
        subtitle="desk"
        welcome={{ overline: desk.label, heading: `Your ${desk.label} desk`, body: desk.body, suggestions: desk.suggestions, notice: connection.ok ? undefined : connection.text }}
        placeholder={`Ask about ${desk.label}…`}
      /></>}
      right={kind === "github" ? (
        <TodayPanel items={feed.filter((i) => i.source === "github")} title="GitHub" note={connection.text} />
      ) : (
        <section className="side-panel">
          <header className="pane-header">
            <div className="pane-title">
              <span className="pane-name">About this desk</span>
            </div>
          </header>
          <div className="side-scroll pad">
            <p>{desk.body}</p>
            <p className={`desk-connection ${connection.ok ? "is-ok" : "is-missing"}`}>{connection.text}</p>
            <p className="meta">{desk.connect}</p>
          </div>
        </section>
      )}
    />
  );
}
