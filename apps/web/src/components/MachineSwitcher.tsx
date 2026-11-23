"use client";
import { RetrySoon } from "./AutoRefresh";
import { AlertTriangle, Bell, Radio, Server, Settings2, Sparkles, Webhook, Wrench } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Machine } from "@/lib/daemon";
import { openContextMenu, type MenuItem } from "./ContextMenu";
import { machineState } from "./Machines";

/** jin's settings pages, after "Manage machines": the menu in the sidebar's footer, and the phone drawer's list. */
const SETTINGS = [
  { label: "Live events", icon: Radio, href: "/live" },
  { label: "Hooks", icon: Webhook, href: "/hooks" },
  { label: "Skills", icon: Sparkles, href: "/skills" },
  { label: "Notifications", icon: Bell, href: "/notifications" },
  { label: "Problems", icon: AlertTriangle, href: "/problems" },
] as const;

/** The sidebar's footer: jin's settings, and the machines it reaches (to add or manage; tasks on any of them are in the list above). */
export function SettingsMenu({ machines, problems = 0 }: { machines: Machine[]; workspace?: string; /** Background failures on this machine. */ problems?: number }) {
  const router = useRouter();
  const down = machines.filter((m) => machineState(m).tone === "bad").length;
  const items = (): MenuItem[] => [
    { label: "Manage machines", icon: Server, hint: down ? `${down} not answering` : `${machines.length + 1}`, run: () => router.push("/machines") },
    { divider: true },
    ...SETTINGS.map(({ label, icon, href }) => ({ label, icon, ...(href === "/problems" && problems ? { hint: `${problems}` } : {}), run: () => router.push(href) })),
  ];
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
      {(down > 0 || problems > 0) && <span className="machine-dot is-bad" title={[down ? `${down} not answering` : "", problems ? `${problems} problem${problems === 1 ? "" : "s"} (Problems)` : ""].filter(Boolean).join("; ")} />}
    </button>
  );
}

/** The same settings as plain links, for the phone drawer (a menu that pops up over a drawer is one layer too many). */
export function SettingsLinks({ machines }: { machines: Machine[] }) {
  const path = usePathname();
  const down = machines.filter((m) => machineState(m).tone === "bad").length;
  const links = [{ label: "Manage machines", icon: Server, href: "/machines", hint: down ? `${down} not answering` : undefined }, ...SETTINGS, { label: "Set up jin", icon: Wrench, href: "/setup" }];
  return (
    <>
      <div className="nav-section">
        <span>Settings</span>
      </div>
      {links.map(({ label, icon: Icon, href, ...rest }) => (
        <Link key={href} href={href} className={`nav-item ${path === href ? "active" : ""}`}>
          <Icon size={14} className="nav-icon" />
          <span className="nav-label">{label}</span>
          {"hint" in rest && rest.hint && <span className="nav-sub">{rest.hint}</span>}
        </Link>
      ))}
    </>
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
