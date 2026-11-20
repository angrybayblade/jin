"use client";
import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";
import { ErrorView } from "@/components/ErrorView";

/** A page that failed: the sidebar stays, and so does a way back. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  useEffect(() => console.error("page failed:", error), [error]);
  return (
    <main className="page-error">
      <ErrorView
        title="This page couldn't load"
        error={error}
        back
        retry={() =>
          startTransition(() => {
            router.refresh();
            reset();
          })
        }
      />
    </main>
  );
}
