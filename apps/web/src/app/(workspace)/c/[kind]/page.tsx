import { redirect } from "next/navigation";

/** The per-app desks are one desk now. */
export default function OldDesk() {
  redirect("/desk");
}
