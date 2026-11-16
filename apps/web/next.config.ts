import type { NextConfig } from "next";

const config: NextConfig = {
  // The command center talks to the daemon from the server only; the token never reaches the browser.
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
