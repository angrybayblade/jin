"use client";
import { Bell, Monitor, Plus, Radio, Server, Settings2, Sparkles, Webhook, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { switchMachine } from "@/app/actions";
import type { Machine } from "@/lib/daemon";
import { openContextMenu, type MenuItem } from "./ContextMenu";
import { machineState } from "./Machines";

/** The sidebar's footer: which machine's jin you're looking at; click to switch, add or manage machines. */
export function MachineSwitcher({ machines, current, workspace }: { machines: Machine[]; current: string; workspace: string }) {
  const router = useRouter();
  const on = machines.find((m) => m.id === current);
  const go = (id: string) =>
    void switchMachine(id).then(() => {
      router.push("/");
      router.refresh();
    });
  const items = (): MenuItem[] => [
    { header: "Machines" },
    { label: "This machine", icon: Monitor, hint: current === "local" ? "current" : undefined, run: () => go("local") },
    ...machines.map((m) => {
      const s = machineState(m);
      return { label: m.label, icon: Server, hint: current === m.id ? "current" : s.label, disabled: !m.connected && current !== m.id, run: () => go(m.id) } satisfies MenuItem;
    }),
    { divider: true },
    { label: "Add a machine…", icon: Plus, run: () => router.push("/machines") },
    { label: "Set up this machine", icon: Wrench, run: () => router.push("/setup") },
    { label: "Live events", icon: Radio, run: () => router.push("/live") },
    { label: "Hooks", icon: Webhook, run: () => router.push("/hooks") },
    { label: "Skills", icon: Sparkles, run: () => router.push("/skills") },
    { label: "Notifications", icon: Bell, run: () => router.push("/notifications") },
    ...(machines.length ? [{ label: "Manage machines", icon: Settings2, run: () => router.push(on ? `/machines?m=${on.id}` : "/machines") } satisfies MenuItem] : []),
  ];
  const tone = on ? machineState(on).tone : "ok";
  return (
    <button
      type="button"
      className="machine-switcher"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        // Above the line over the sidebar's footer, its left edge in line with the switcher.
        const footer = e.currentTarget.closest(".sidebar-bottom")?.getBoundingClientRect().top ?? r.top;
        openContextMenu({ clientX: r.left, clientY: footer - 10, preventDefault: () => e.preventDefault() }, items(), { above: true });
      }}
      title="Switch machine"
    >
      {on ? <Server size={13} /> : <Monitor size={13} />}
      <span className="machine-switcher-name">{on ? on.label : "This machine"}</span>
      {on && <span className={`machine-dot is-${tone}`} />}
      <span className="meta machine-switcher-where">{workspace}</span>
    </button>
  );
}

/** A remote machine's jin is not answering: say so, and offer the way back. */
export function MachineDown({ name, message }: { name: string; message: string }) {
  const router = useRouter();
  return (
    <main className="daemon-down">
      <Server size={32} />
      <p>{message}</p>
      <span className="machine-actions">
        <button type="button" className="button primary" onClick={() => void switchMachine("local").then(() => router.refresh())}>
          Back to this machine
        </button>
        <button type="button" className="button" onClick={() => void switchMachine("local").then(() => router.push(`/machines`))}>
          Check {name}
        </button>
      </span>
    </main>
  );
}
