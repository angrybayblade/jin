import { Chat } from "@/components/Chat";
import { TodayPanel } from "@/components/TodayPanel";
import { Panes } from "@/components/Panes";
import { daemon, daemonWsBase, type Approval, type FeedItem, type Session, type SessionEvent } from "@/lib/daemon";

export const dynamic = "force-dynamic";

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
};

/** Home: a chat with jin, with what is waiting on the right. */
export default async function Home({ searchParams }: { searchParams: Promise<{ chat?: string }> }) {
  const [sessions, approvals, feed] = await Promise.all([
    daemon<Session[]>("/api/sessions?kind=jin"),
    daemon<Approval[]>("/api/approvals?state=pending"),
    daemon<FeedItem[]>("/api/feed"),
  ]);
  // The open tab: ?chat=<id>, ?chat=new for a fresh one, else the newest chat.
  const want = (await searchParams).chat;
  const session = want === "new" ? null : (sessions.find((s) => s.id === want) ?? sessions[0] ?? null);
  const events = session ? await daemon<SessionEvent[]>(`/api/sessions/${session.id}/events`) : [];
  return (
    <Panes id="home" defaultSplit={70} left={<>
      <Chat
        key={session?.id ?? "new"}
        chats={sessions}
        kind="jin"
        session={session}
        initialEvents={events}
        approvals={approvals}
        wsBase={daemonWsBase()}
        title="Jin"
        subtitle="your orchestrator"
        welcome={{
          heading: greeting(),
          body: "Ask me to catch you up. I can start tasks, hand them to coding agents and keep track of what needs you.",
          suggestions: ["Catch me up", "What's blocked on me?", "Refresh GitHub and tell me what changed"],
        }}
        placeholder="Ask jin…"
      /></>}
      right={<TodayPanel items={feed} />}
    />
  );
}
