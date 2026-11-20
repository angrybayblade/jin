"use client";
import { Layers } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** The stack at the top of the sidebar: switches between jin's chat and the desk. */
export function ViewSwitch() {
  const onDesk = usePathname().startsWith("/desk");
  const label = onDesk ? "Switch to jin's chat" : "Switch to the desk";
  return (
    <Link href={onDesk ? "/" : "/desk"} className={`button quiet icon-only view-switch${onDesk ? " is-desk" : ""}`} title={label} aria-label={label}>
      <Layers size={15} />
    </Link>
  );
}
