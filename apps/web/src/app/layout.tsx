import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { DesktopShell } from "@/components/DesktopShell";
import { AnimatedFavicon } from "@/components/AnimatedFavicon";
import { LAYOUT_BOOT } from "@/lib/layout";
import "@/design/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "jin",
  description: "Catch up, decide what matters, and run agents on it.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Theme and density are cookies, so the first paint is already right (no flash).
  const jar = await cookies();
  const choice = jar.get("jin-theme")?.value;
  const theme = choice === "light" || choice === "dark" ? choice : undefined;
  const density = jar.get("jin-density")?.value === "comfortable" ? "comfortable" : "compact";
  return (
    <html lang="en" data-theme={theme} data-density={density} suppressHydrationWarning>
      <head>
        {/* Sidebar width, pane splits and hidden panes, from this browser, before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: LAYOUT_BOOT }} />
      </head>
      <body>
        <AnimatedFavicon />
        <DesktopShell />
        {children}
      </body>
    </html>
  );
}
