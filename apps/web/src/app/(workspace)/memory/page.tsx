import { MemoryPage } from "@/components/Memory";
import { daemon, homeMachine, type JournalEntry, type Machine } from "@/lib/daemon";

export const dynamic = "force-dynamic";

export default async function Page() {
  const home = homeMachine();
  const [rows, machines] = await Promise.all([daemon<JournalEntry[]>("/api/memory").catch(() => [] as JournalEntry[]), daemon<Machine[]>("/api/machines", { local: true }).catch(() => [] as Machine[])]);
  return <MemoryPage initial={rows} home={home === "local" ? "this machine" : (machines.find((m) => m.id === home)?.label ?? home)} />;
}
