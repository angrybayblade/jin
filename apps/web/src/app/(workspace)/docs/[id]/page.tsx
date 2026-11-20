import { notFound } from "next/navigation";
import { DocPage } from "@/components/docs/DocPage";
import { MachineDown } from "@/components/MachineSwitcher";
import { daemon, daemonWsBase, homeMachine, type DocFull, type Session, type SessionEvent } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** One doc: the editor, and its comments, jin's suggestions, its chat with jin and its history. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^d[0-9a-f]{10}$/.test(id)) notFound();
  let doc: DocFull;
  try {
    doc = await daemon<DocFull>(`/api/docs/${id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no doc/.test(message)) notFound();
    return <MachineDown id={homeMachine()} name="jin's home" message={message} />;
  }
  const chat = doc.chatId
    ? await Promise.all([daemon<Session>(`/api/sessions/${doc.chatId}`), daemon<SessionEvent[]>(`/api/sessions/${doc.chatId}/events`)])
        .then(([session, events]) => ({ session, events }))
        .catch(() => null)
    : null;
  return <DocPage key={doc.id} initial={doc} chat={chat} wsBase={await daemonWsBase({ home: true })} />;
}
