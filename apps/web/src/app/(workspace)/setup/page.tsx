import { Setup } from "@/components/Setup";
import { daemon, type SetupState } from "@/lib/daemon";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  return <Setup initial={await daemon<SetupState>("/api/setup", { local: true })} />;
}
