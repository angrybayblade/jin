import type { NextConfig } from "next";

const config: NextConfig = {
  // The command center talks to the daemon from the server only; the token never reaches the browser.
  poweredByHeader: false,
  // A separate build directory lets a test build run next to the dev server.
  distDir: process.env.JIN_WEB_DIST ?? ".next",
  reactStrictMode: true,
  experimental: {
    // A page fetched ahead (a hovered chat, a task here) is kept 30 s, not Next's 5 minutes: opened
    // later, it is fetched again rather than shown from an old copy.
    staleTimes: { static: 30 },
  },
};

export default config;
