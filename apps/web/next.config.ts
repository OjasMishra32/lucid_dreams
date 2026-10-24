import type { NextConfig } from "next";

// The headset app (apps/webxr, its stable build) lives at /xr/ on this same address, so one link is the website and
// the room: this server passes /xr/ through to it (plain http on :5182; ~/LucidDreams-held/rebuild-stable.sh runs it).
const XR = process.env.LUCID_XR ?? "http://localhost:5182";

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
  // One website: the home page shows every scene, so the old showcase page sends you there
  async redirects() {
    // one page, one scroll: the old separate pages send you to their section of it
    return [
      { source: "/showcase", destination: "/#scenes", permanent: false },
      { source: "/library", destination: "/#scenes", permanent: false },
      { source: "/technology", destination: "/#technology", permanent: false },
      { source: "/new", destination: "/#make", permanent: false },
    ];
  },
  // /xr/ keeps its slash: the headset app's own links are relative to it ("./" is its library)
  skipTrailingSlashRedirect: true,
  async rewrites() {
    // (its page by name: the WebXR server only answers under "/xr/", and a rewrite of the bare folder loses the slash)
    return [
      { source: "/xr", destination: `${XR}/xr/index.html` },
      { source: "/xr/:path+", destination: `${XR}/xr/:path+` },
    ];
  },
};

export default config;
