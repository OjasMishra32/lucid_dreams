import type { NextConfig } from "next";

const config: NextConfig = {
  // Builds only from apps/web (ignore lockfiles further up the disk).
  turbopack: { root: __dirname },
  // The bridge runs on Ojasva's Mac and is opened from laptops and the Quest on the same Wi-Fi.
  allowedDevOrigins: ["*.local", "192.168.*.*", "10.*.*.*", "172.*.*.*"],
  // Uploads stream straight to disk; never let the framework buffer a 4K clip.
  serverExternalPackages: ["busboy"],
  // Next 16 writes an AGENTS.md here by default; the bridge finds the repo root by the first AGENTS.md above it,
  // so that file made it read apps/web/dreams (empty) instead of the repo's dreams/.
  agentRules: false,
};

export default config;
