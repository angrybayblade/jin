import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AnimatedFavicon } from "@/components/AnimatedFavicon";
import "@/design/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "jin",
  description: "Catch up, decide what matters, and run agents on it.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The theme choice is a cookie, so the first paint is already right (no flash).
  const choice = (await cookies()).get("jin-theme")?.value;
  const theme = choice === "light" || choice === "dark" ? choice : undefined;
  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <body>
        <AnimatedFavicon />
        {children}
      </body>
    </html>
  );
}
