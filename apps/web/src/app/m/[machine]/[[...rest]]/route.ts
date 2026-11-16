// /m/<machine>/<path>: show that machine's jin, then go to <path> there (the sidebar links
// other machines' tasks this way). "local" is this machine.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MACHINE_COOKIE } from "@/lib/daemon";

export async function GET(_req: Request, { params }: { params: Promise<{ machine: string; rest?: string[] }> }) {
  const { machine, rest } = await params;
  const home = process.env.JIN_HOME ?? join(homedir(), ".jin");
  const jar = await cookies();
  if (machine === "local") jar.delete(MACHINE_COOKIE);
  else if (/^[a-z0-9-]+$/.test(machine) && existsSync(join(home, "machines", `${machine}.json`))) {
    jar.set(MACHINE_COOKIE, machine, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  } else redirect("/machines");
  redirect(`/${(rest ?? []).map(encodeURIComponent).join("/")}`);
}
