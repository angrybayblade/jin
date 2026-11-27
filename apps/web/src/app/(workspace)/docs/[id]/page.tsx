import { notFound } from "next/navigation";
import { DocPage } from "@/components/docs/DocPage";
import { MachineDown } from "@/components/MachineSwitcher";
import { daemon, DaemonUnavailable, daemonWsBase, homeMachine, view, type DocFull, type Session, type SessionEvent } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** One doc: the editor, and its comments, jin's suggestions, its chat with jin and its history. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^d[0-9a-f]{10}$/.test(id)) notFound();
  let doc: DocFull;
  let chat: { session: Session; events: SessionEvent[] } | null;
  try {
    // The doc and its chat in one call to the home.
    ({ doc, chat } = await view<{ doc: DocFull; chat: typeof chat }>(`/api/views/doc/${id}`, async () => {
      const doc = await daemon<DocFull>(`/api/docs/${id}`);
      const chat = doc.chatId
        ? await Promise.all([daemon<Session>(`/api/sessions/${doc.chatId}`), daemon<SessionEvent[]>(`/api/sessions/${doc.chatId}/events`)])
            .then(([session, events]) => ({ session, events }))
            .catch(() => null)
        : null;
      return { doc, chat };
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no doc/.test(message)) notFound();
    // The home not answering is said as such; any other failure is the page's error (with its reason).
    if (!(err instanceof DaemonUnavailable)) throw err;
    return <MachineDown id={homeMachine()} name="jin's home" message={message} />;
  }
  return <DocPage key={doc.id} initial={doc} chat={chat} wsBase={await daemonWsBase({ home: true })} />;
}
