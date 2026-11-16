import { Machines } from "@/components/Machines";
import { currentMachine, daemon, type Machine } from "@/lib/daemon";

export const dynamic = "force-dynamic";

export default async function MachinesPage({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const [machines, current, { m }] = await Promise.all([daemon<Machine[]>("/api/machines", { local: true }), currentMachine(), searchParams]);
  return <Machines machines={machines} current={current} selected={m ?? (current !== "local" ? current : null)} />;
}
