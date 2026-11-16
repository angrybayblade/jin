import type { NextConfig } from "next";

const config: NextConfig = {
  // The command center talks to the daemon from the server only; the token never reaches the browser.
  poweredByHeader: false,
  // A separate build directory lets a test build run next to the dev server.
  distDir: process.env.JIN_WEB_DIST ?? ".next",
  reactStrictMode: true,
};

export default config;
