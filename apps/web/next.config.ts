import type { NextConfig } from "next";

const config: NextConfig = {
  // A second server (a preview beside the live one) builds into its own folder: NEXT_DIST_DIR=.next-preview
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Builds only from apps/web (ignore lockfiles further up the disk).
  turbopack: { root: __dirname },
  // The bridge runs on Ojasva's Mac and is opened from laptops and the Quest on the same Wi-Fi.
  allowedDevOrigins: ["*.local", "192.168.*.*", "10.*.*.*", "172.*.*.*"],
  // Uploads stream straight to disk; never let the framework buffer a 4K clip.
  serverExternalPackages: ["busboy"],
  // Posters are 1080x1920 renders; pages ask for them sized to the card (with ?v= for a rebuilt bundle).
  images: { localPatterns: [{ pathname: "/dreams/**" }], formats: ["image/webp"] },
  // Next 16 writes an AGENTS.md here by default; the bridge finds the repo root by the first AGENTS.md above it,
  // so that file made it read apps/web/dreams (empty) instead of the repo's dreams/.
  agentRules: false,
};

export default config;
