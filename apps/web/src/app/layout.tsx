import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ThermalMark } from "@/components/ThermalMark";
import "@/design/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "jin",
  description: "Catch up, decide what matters, and run agents on it.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-frame">
          <header className="app-header">
            <Link href="/" className="brand" aria-label="jin, command center">
              <ThermalMark size={28} label="jin" />
              <span className="brand-name">jin</span>
            </Link>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
