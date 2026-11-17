import { HooksPage } from "@/components/Hooks";
import { daemon, homeMachine, type HooksStatus, type Machine } from "@/lib/daemon";

export const dynamic = "force-dynamic";

export default async function Page() {
  const home = homeMachine();
  const [status, machines] = await Promise.all([daemon<HooksStatus>("/api/event-hooks"), daemon<Machine[]>("/api/machines", { local: true }).catch(() => [] as Machine[])]);
  return <HooksPage initial={status} home={home === "local" ? "this machine" : (machines.find((m) => m.id === home)?.label ?? home)} />;
}
