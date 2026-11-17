import { SkillsPage } from "@/components/Skills";
import { daemon, homeMachine, type Machine, type SkillsStatus } from "@/lib/daemon";

export const dynamic = "force-dynamic";

export default async function Page() {
  const home = homeMachine();
  const [status, machines] = await Promise.all([daemon<SkillsStatus>("/api/skills"), daemon<Machine[]>("/api/machines", { local: true }).catch(() => [] as Machine[])]);
  return <SkillsPage initial={status} home={home === "local" ? "this machine" : (machines.find((m) => m.id === home)?.label ?? home)} />;
}
