import { notFound, redirect } from "next/navigation";
import { daemon, type Session } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** Old session links: open the chat where the session lives. */
export default async function SessionRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let s: Session;
  try {
    s = await daemon<Session>(`/api/sessions/${encodeURIComponent(id)}`);
  } catch {
    notFound();
  }
  redirect(s.kind === "task" && s.taskId ? `/t/${encodeURIComponent(s.taskId)}` : s.kind === "jin" ? "/" : `/c/${s.kind}`);
}
