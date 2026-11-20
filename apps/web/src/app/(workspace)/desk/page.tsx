import { Boundary } from "@/components/Boundary";
import { Chat } from "@/components/Chat";
import { Panes } from "@/components/Panes";
import { ActivityDesk } from "@/components/ActivityDesk";
import { daemon, daemonWsBase, type Approval, type DeskStatus, type FeedItem, type Session, type SessionEvent } from "@/lib/daemon";

export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = { github: "GitHub", slack: "Slack", linear: "Linear", notion: "Notion", gmail: "Gmail" };

/** What the desk agent cannot reach, in one line (nothing when every source is connected). */
function missing(desks: DeskStatus[] | null): string | undefined {
  const off = (desks ?? []).filter((d) => d.state !== "connected").map((d) => LABEL[d.kind] ?? d.kind);
  return off.length ? `${off.join(", ")} ${off.length === 1 ? "is" : "are"} not connected to your Claude yet: claude.ai → Settings → Connectors${off.includes("GitHub") ? ", and gh auth login for GitHub" : ""}.` : undefined;
}

/**
 * The desk: what came in from GitHub, Slack, Linear, Notion and Gmail, with one continuing
 * desk agent on the right to catch up, prioritise and summarise it.
 */
export default async function DeskPage() {
  const [sessions, approvals, feed, desks] = await Promise.all([
    daemon<Session[]>("/api/sessions?kind=desk"),
    daemon<Approval[]>("/api/approvals?state=pending"),
    daemon<FeedItem[]>("/api/feed"),
    daemon<DeskStatus[]>("/api/desks", { timeoutMs: 8000 }).catch(() => null),
  ]);
  // One desk agent: the newest desk chat continues; the first message starts it.
  const session = sessions[0] ?? null;
  const events = session ? await daemon<SessionEvent[]>(`/api/sessions/${session.id}/events`) : [];
  return (
    <Panes
      id="desk"
      defaultSplit={60}
      labels={["Activity", "Desk agent"]}
      left={<Boundary label="Activity"><ActivityDesk items={feed} /></Boundary>}
      right={
        <Boundary label="The desk agent" resetKey={session?.id ?? "new"}>
        <Chat
          key={session?.id ?? "new"}
          kind="desk"
          session={session}
          initialEvents={events}
          approvals={approvals.filter((a) => a.sessionId === session?.id)}
          wsBase={await daemonWsBase({ home: true })}
          title="Desk agent"
          welcome={{
            heading: "Your desk",
            body: "I keep you on top of GitHub, Slack, Linear, Notion and Gmail: catch up, prioritise, summarise, draft replies. This is one conversation that carries on, so I remember what you have seen.",
            suggestions: ["Catch me up", "What should I do first?", "Summarise what came in since this morning"],
            notice: missing(desks),
          }}
          placeholder="Ask your desk…"
        />
        </Boundary>
      }
    />
  );
}
