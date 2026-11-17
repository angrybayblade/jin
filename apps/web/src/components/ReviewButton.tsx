"use client";
import { ScanEye } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { startReview } from "@/app/actions";

/** Review a pull request as a task: makes the review task (or opens the one already reviewing it). */
export function ReviewButton({ pr, label = false }: { pr: string; label?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const r = await startReview([pr]);
    setBusy(false);
    if ("error" in r) return void alert(`Could not start the review: ${r.error}`);
    router.push(`/t/${encodeURIComponent(r.taskId)}`);
  };
  return (
    <button type="button" className={`button quiet small${label ? "" : " icon-only"}`} disabled={busy} onClick={() => void go()} title="Review this PR as a task" aria-label="Review this PR as a task">
      <ScanEye size={13} />
      {label && (busy ? " Starting…" : " Review")}
    </button>
  );
}
