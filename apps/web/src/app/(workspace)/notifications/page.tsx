import { NotificationsPage } from "@/components/NotificationKinds";
import { daemon, type NotificationKinds } from "@/lib/daemon";

export const dynamic = "force-dynamic";

export default async function Page() {
  const kinds = await daemon<NotificationKinds[]>("/api/notifications/kinds").catch(() => [] as NotificationKinds[]);
  return <NotificationsPage initial={kinds} />;
}
