import { ProblemsPage } from "@/components/Problems";
import { daemon, homeMachine, type Machine, type Problem } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** What failed in the background, on this machine, the home and every connected machine. */
export default async function Page() {
  const machines = await daemon<Machine[]>("/api/machines", { local: true }).catch(() => [] as Machine[]);
  const home = homeMachine();
  const where = [{ id: "local", label: "This machine" }, ...machines.filter((m) => m.connected).map((m) => ({ id: m.id, label: m.id === home ? `${m.label} (home)` : m.label }))];
  const groups = await Promise.all(
    where.map(async (m) => {
      try {
        return { ...m, problems: await daemon<Problem[]>("/api/problems", { machine: m.id, timeoutMs: 4000 }), error: null };
      } catch (err) {
        return { ...m, problems: [] as Problem[], error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  return <ProblemsPage groups={groups} />;
}
