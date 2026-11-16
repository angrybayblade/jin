import { Approvals } from "@/components/Approvals";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Feed } from "@/components/Feed";
import { Tasks } from "@/components/Tasks";
import { ThermalMark } from "@/components/ThermalMark";
import { daemon, DaemonUnavailable, type Approval, type FeedItem, type Session, type Status, type Task } from "@/lib/daemon";

export const dynamic = "force-dynamic";

export default async function CommandCenter() {
  let data: { status: Status; feed: FeedItem[]; approvals: Approval[]; tasks: Task[]; sessions: Session[] };
  try {
    const [status, feed, approvals, tasks, sessions] = await Promise.all([
      daemon<Status>("/api/status"),
      daemon<FeedItem[]>("/api/feed"),
      daemon<Approval[]>("/api/approvals?state=pending"),
      daemon<Task[]>("/api/tasks"),
      daemon<Session[]>("/api/sessions"),
    ]);
    data = { status, feed, approvals, tasks, sessions };
  } catch (err) {
    if (!(err instanceof DaemonUnavailable)) throw err;
    return (
      <main className="page-container">
        <div className="empty-state">
          <ThermalMark size={32} state="queued" variant="workflow" />
          <p>{err.message}</p>
        </div>
      </main>
    );
  }

  const working = data.sessions.filter((s) => s.state === "running").length;
  return (
    <main className="page-container">
      <AutoRefresh />
      <div className="page-heading">
        <div>
          <h1>Command center</h1>
          <p className="meta">
            {data.status.workspaces.join(", ") || "no workspace configured"} · {data.status.mode === "vm" ? "always on" : "local"}
          </p>
        </div>
      </div>
      <div className="metrics">
        <div className="metric">
          <span className="metric-label">Waiting for you</span>
          <span className="metric-value">{data.approvals.length}</span>
        </div>
        <div className="metric">
          <span className="metric-label">To catch up on</span>
          <span className="metric-value">{data.feed.filter((i) => i.state === "new").length}</span>
        </div>
        <div className="metric">
          <span className="metric-label">Agents working</span>
          <span className="metric-value">{working}</span>
        </div>
      </div>
      <Approvals approvals={data.approvals} />
      <div className="columns">
        <Feed items={data.feed} />
        <Tasks tasks={data.tasks} sessions={data.sessions} />
      </div>
    </main>
  );
}
