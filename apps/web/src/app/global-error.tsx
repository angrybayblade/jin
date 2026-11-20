"use client";
import "./globals.css";
import { ErrorView } from "@/components/ErrorView";

/** The app's own frame failed (the layout): the last resort, with its own page. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="daemon-down">
          <ErrorView title="jin couldn't load" error={error} retry={() => (reset(), location.reload())} />
        </main>
      </body>
    </html>
  );
}
