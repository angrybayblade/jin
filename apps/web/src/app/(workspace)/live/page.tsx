import { LiveEvents } from "@/components/LiveEvents";
import { daemon, homeMachine, type LiveStatus, type Machine } from "@/lib/daemon";

export const dynamic = "force-dynamic";

export default async function LivePage() {
  const home = homeMachine();
  const [status, machines] = await Promise.all([daemon<LiveStatus>("/api/composio"), daemon<Machine[]>("/api/machines", { local: true }).catch(() => [] as Machine[])]);
  return <LiveEvents initial={status} home={home === "local" ? "this machine" : (machines.find((m) => m.id === home)?.label ?? home)} />;
}
