import { ClaudeSettingsPage } from "@/components/ClaudeSettings";
import { MachineDown } from "@/components/MachineSwitcher";
import { daemon, type ClaudeSettingsFile, type Machine } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** Claude Code's user settings, on this machine or another (?m=<id>). */
export default async function Page({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const [{ m }, machines] = await Promise.all([searchParams, daemon<Machine[]>("/api/machines", { local: true }).catch(() => [] as Machine[])]);
  const machine = m && machines.some((x) => x.id === m) ? m : "local";
  const choices = [{ id: "local", label: "This machine" }, ...machines.map((x) => ({ id: x.id, label: x.label }))];
  const name = choices.find((c) => c.id === machine)!.label;
  try {
    const file = await daemon<ClaudeSettingsFile>("/api/claude-settings", { machine });
    return <ClaudeSettingsPage key={`${machine}:${file.hash}`} initial={file} machine={machine} machines={choices} />;
  } catch (err) {
    return <MachineDown id={machine} name={name} message={err instanceof Error ? err.message : String(err)} />;
  }
}
