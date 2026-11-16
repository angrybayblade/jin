import Link from "next/link";
import { notFound } from "next/navigation";
import { sendMessage } from "@/app/actions";
import { Approvals } from "@/components/Approvals";
import { AutoRefresh } from "@/components/AutoRefresh";
import { StatusMark } from "@/components/ThermalMark";
import { daemon, type Approval, type Session, type SessionEvent } from "@/lib/daemon";

export const dynamic = "force-dynamic";

function line(e: SessionEvent): { tone: string; text: string } | null {
  const p = e.payload;
  switch (e.kind) {
    case "prompt":
      return { tone: "prompt", text: `› ${p.text}` };
    case "message":
      return { tone: "message", text: p.text };
    case "tool.requested":
      return { tone: "tool", text: `$ ${p.input?.command ?? `${p.tool} ${JSON.stringify(p.input)}`}` };
    case "tool.denied":
      return { tone: "denied", text: `  denied: ${p.reason}` };
    case "approval.requested":
      return { tone: "waiting", text: `  waiting for approval: ${p.reason}` };
    case "approval.decided":
      return { tone: p.decision === "approved" ? "ok" : "denied", text: `  ${p.decision}` };
    case "session.failed":
      return { tone: "denied", text: `session failed: ${p.error}` };
    case "result":
      return { tone: "meta", text: `done${p.costUsd != null ? ` · $${Number(p.costUsd).toFixed(4)}` : ""}${p.turns ? ` · ${p.turns} turns` : ""}` };
    case "harness.started":
      return { tone: "meta", text: `${p.harness} (${p.adapter}) in ${p.cwd}${p.resume ? " · resumed" : ""}` };
    default:
      return null;
  }
}

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let session: Session;
  try {
    session = await daemon<Session>(`/api/sessions/${encodeURIComponent(id)}`);
  } catch {
    notFound();
  }
  const [events, approvals] = await Promise.all([
    daemon<SessionEvent[]>(`/api/sessions/${encodeURIComponent(id)}/events`),
    daemon<Approval[]>("/api/approvals?state=pending"),
  ]);
  const mine = approvals.filter((a) => a.sessionId === id);
  const busy = session.state === "running" || session.state === "waiting_approval";

  return (
    <main className="session-view" data-theme="dark">
      {busy && <AutoRefresh every={1500} />}
      <div className="session-header">
        <Link href="/" className="button quiet">
          ← Command center
        </Link>
        <StatusMark state={session.state} />
        <span className="task-id">{session.taskId}</span>
        <span className="meta">{session.harness}</span>
      </div>
      <Approvals approvals={mine} />
      <pre className="session-log" data-scroll="y" aria-label="Session log">
        {events.map((e) => {
          const l = line(e);
          return l ? (
            <div key={e.seq} className={`log-line is-${l.tone}`}>
              {l.text}
            </div>
          ) : null;
        })}
      </pre>
      {!busy && (
        <form action={sendMessage} className="composer">
          <input type="hidden" name="sessionId" value={id} />
          <input name="prompt" required placeholder="Follow up…" aria-label="Follow-up message" />
          <button type="submit" className="button primary">
            Send
          </button>
        </form>
      )}
    </main>
  );
}
