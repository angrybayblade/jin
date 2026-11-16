import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/design/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "jin",
  description: "Catch up, decide what matters, and run agents on it.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
