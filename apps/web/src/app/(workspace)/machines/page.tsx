import { Machines } from "@/components/Machines";
import { daemon, type Machine } from "@/lib/daemon";

export const dynamic = "force-dynamic";

export default async function MachinesPage({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const [machines, { m }] = await Promise.all([daemon<Machine[]>("/api/machines", { local: true }), searchParams]);
  return <Machines machines={machines} selected={m ?? null} />;
}
