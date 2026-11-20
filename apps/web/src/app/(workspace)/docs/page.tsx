import { DocLibrary } from "@/components/docs/DocLibrary";
import { MachineDown } from "@/components/MachineSwitcher";
import { daemon, homeMachine, type DocSummary } from "@/lib/daemon";

export const dynamic = "force-dynamic";

/** jin docs: specs, RFCs and notes you and jin work on (kept on jin's home). */
export default async function DocsPage() {
  try {
    const docs = await daemon<DocSummary[]>("/api/docs");
    return <DocLibrary docs={docs} />;
  } catch (err) {
    return <MachineDown id={homeMachine()} name="jin's home" message={err instanceof Error ? err.message : String(err)} />;
  }
}
