import { redirect } from "next/navigation";

/** Claude Code's settings moved into each machine's page (Machines → a machine → Coding agents). */
export default async function Page({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const { m } = await searchParams;
  redirect(`/machines?m=${encodeURIComponent(m ?? "local")}`);
}
