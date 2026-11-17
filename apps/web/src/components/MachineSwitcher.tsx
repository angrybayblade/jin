"use client";
import { RetrySoon } from "./AutoRefresh";
import { Bell, Monitor, Plus, Radio, Server, Settings2, Sparkles, Webhook } from "lucide-react";
import { useRouter } from "next/navigation";
import type { Machine } from "@/lib/daemon";
import { openContextMenu, type MenuItem } from "./ContextMenu";
import { machineState } from "./Machines";

/** The sidebar's footer: jin's settings, and the machines it reaches (to add or manage; tasks on any of them are in the list above). */
export function SettingsMenu({ machines, workspace }: { machines: Machine[]; workspace: string }) {
  const router = useRouter();
  const items = (): MenuItem[] => [
    { header: "Machines" },
    { label: "This machine", icon: Monitor, hint: workspace, run: () => router.push("/setup") },
    ...machines.map((m) => {
      const s = machineState(m);
      return { label: m.label, icon: Server, hint: s.label, run: () => router.push(`/machines?m=${m.id}`) } satisfies MenuItem;
    }),
    { label: "Add a machine…", icon: Plus, run: () => router.push("/machines") },
    { divider: true },
    { label: "Live events", icon: Radio, run: () => router.push("/live") },
    { label: "Hooks", icon: Webhook, run: () => router.push("/hooks") },
    { label: "Skills", icon: Sparkles, run: () => router.push("/skills") },
    { label: "Notifications", icon: Bell, run: () => router.push("/notifications") },
  ];
  const down = machines.filter((m) => machineState(m).tone === "bad").length;
  return (
    <button
      type="button"
      className="machine-switcher"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        // Above the line over the sidebar's footer, its left edge in line with the button.
        const footer = e.currentTarget.closest(".sidebar-bottom")?.getBoundingClientRect().top ?? r.top;
        openContextMenu({ clientX: r.left, clientY: footer - 10, preventDefault: () => e.preventDefault() }, items(), { above: true });
      }}
      title="Machines and settings"
    >
      <Settings2 size={13} />
      <span className="machine-switcher-name">{machines.length ? `${machines.length + 1} machines` : "Settings"}</span>
      {down > 0 && <span className="machine-dot is-bad" title={`${down} not answering`} />}
    </button>
  );
}

/** A page on a machine that is not answering: it retries until the machine is back. */
export function MachineDown({ id, name, message }: { id: string; name: string; message: string }) {
  const router = useRouter();
  return (
    <main className="daemon-down">
      <Server size={32} />
      <p>{message}</p>
      <RetrySoon />
      <span className="machine-actions">
        <button type="button" className="button" onClick={() => router.push(`/machines?m=${id}`)}>
          Check {name}
        </button>
      </span>
    </main>
  );
}
