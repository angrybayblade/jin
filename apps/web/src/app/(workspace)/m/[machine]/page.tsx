import { redirect } from "next/navigation";

// A machine's notices link here: its tasks are in the sidebar, the chats are home's.
export default function MachinePage() {
  redirect("/");
}
