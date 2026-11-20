import { Chat } from "@/components/Chat";
import { ChatRefs } from "@/components/ChatRefs";
import { Panes } from "@/components/Panes";
import { redirect } from "next/navigation";
import { currentMachine, daemon, daemonWsBase, type Status, type Approval, type Session, type SessionEvent } from "@/lib/daemon";

export const dynamic = "force-dynamic";

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
};

/** Home: a chat with jin, with what it has talked about on the right (the desk has what is waiting). */
export default async function Home({ searchParams }: { searchParams: Promise<{ chat?: string }> }) {
  const [sessions, approvals, status] = await Promise.all([
    daemon<Session[]>("/api/sessions?kind=jin"),
    daemon<Approval[]>("/api/approvals?state=pending"),
    daemon<Status>("/api/status"),
  ]);
  // First run on this machine (no workspace, no chats yet): set jin up first.
  if (status.workspaces.length === 0 && sessions.length === 0 && (await currentMachine()) === "local") redirect("/setup");
  // The open tab: ?chat=<id>, ?chat=new for a fresh one, else the newest chat.
  const want = (await searchParams).chat;
  const session = want === "new" ? null : (sessions.find((s) => s.id === want) ?? sessions[0] ?? null);
  const events = session ? await daemon<SessionEvent[]>(`/api/sessions/${session.id}/events`) : [];
  return (
    <Panes id="home" defaultSplit={70} labels={["Chat", "In this chat"]} left={<>
      <Chat
        key={session?.id ?? "new"}
        chats={sessions}
        kind="jin"
        session={session}
        initialEvents={events}
        approvals={approvals}
        wsBase={await daemonWsBase({ home: true })}
        title="Jin"
        subtitle="your orchestrator"
        welcome={{
          heading: greeting(),
          body: "Ask me to catch you up. I can start tasks, hand them to coding agents and keep track of what needs you.",
          suggestions: ["Catch me up", "What's blocked on me?", "Refresh GitHub and tell me what changed"],
        }}
        placeholder="Ask jin…"
      /></>}
      right={<ChatRefs key={session?.id ?? "new"} sessionId={session?.id ?? null} />}
    />
  );
}
