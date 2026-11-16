import { notFound } from "next/navigation";
import { Chat } from "@/components/Chat";
import { TodayPanel } from "@/components/TodayPanel";
import { Panes } from "@/components/Panes";
import { daemon, daemonWsBase, type Approval, type ChatKind, type FeedItem, type Session, type SessionEvent } from "@/lib/daemon";

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
    connect: "Uses the Slack MCP server from your Claude settings. Missing? Run `cws connect` in the workspace, or `claude mcp add --transport http --scope user slack https://mcp.slack.com/mcp`, then sign in with /mcp in Claude Code.",
  },
  linear: {
    label: "Linear",
    body: "Your issues and cycle, what changed, and comments waiting on you. Start a task from jin's chat.",
    suggestions: ["What's assigned to me this cycle?", "What changed on my issues today?", "Which issue should I pick up next?"],
    connect: "Uses the Linear MCP server from your Claude settings. Missing? Run `cws connect` in the workspace and sign in.",
  },
  notion: {
    label: "Notion",
    body: "Design docs and runbooks, answered with links, plus comments and mentions.",
    suggestions: ["Find the runbook for Thermos incidents", "Any Notion comments for me?", "Summarise the latest design doc on tool routing"],
    connect: "Uses the Notion MCP server from your Claude settings. Missing? Run `cws connect` in the workspace and sign in.",
  },
  gmail: {
    label: "Gmail",
    body: "Mail that needs a reply, with drafts. Sending waits for your approval.",
    suggestions: ["What needs a reply today?", "Summarise unread mail from people", "Draft a reply to the latest thread"],
    connect: "Needs a Gmail MCP server in your Claude settings; none is configured yet.",
  },
};

/** A knowledge desk: a chat with its own instructions and tools, plus context on the right. */
export default async function DeskPage({ params, searchParams }: { params: Promise<{ kind: string }>; searchParams: Promise<{ chat?: string }> }) {
  const { kind } = await params;
  if (!(kind in DESK)) notFound();
  const desk = DESK[kind as keyof typeof DESK];
  const [sessions, approvals, feed] = await Promise.all([
    daemon<Session[]>(`/api/sessions?kind=${kind}`),
    daemon<Approval[]>("/api/approvals?state=pending"),
    kind === "github" ? daemon<FeedItem[]>("/api/feed") : Promise.resolve([] as FeedItem[]),
  ]);
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
        wsBase={daemonWsBase()}
        title={desk.label}
        subtitle="desk"
        welcome={{ overline: desk.label, heading: `Your ${desk.label} desk`, body: desk.body, suggestions: desk.suggestions }}
        placeholder={`Ask about ${desk.label}…`}
      /></>}
      right={kind === "github" ? (
        <TodayPanel items={feed.filter((i) => i.source === "github")} title="GitHub" note={desk.connect} />
      ) : (
        <section className="side-panel">
          <header className="pane-header">
            <div className="pane-title">
              <span className="pane-name">About this desk</span>
            </div>
          </header>
          <div className="side-scroll pad">
            <p>{desk.body}</p>
            <p className="meta">{desk.connect}</p>
          </div>
        </section>
      )}
    />
  );
}
