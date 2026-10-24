import { defineConfig, type Plugin } from "vite";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

// The bridge (apps/web on the Mac) serves the real dreams. The site's own server passes /api and /dreams through to it,
// so the page reads them from its own origin (no CORS, no mixed content). LUCID_BRIDGE points at another bridge.
const target = process.env.LUCID_BRIDGE ?? "http://localhost:5170";
const proxy = { "/api": { target, changeOrigin: true }, "/dreams": { target, changeOrigin: true } };

// public/media-staging is where raw renders land before they're encoded into public/media; it never ships.
const dropStaging = (): Plugin => ({
  name: "drop-media-staging",
  apply: "build",
  closeBundle() {
    rmSync(resolve(import.meta.dirname, "dist/media-staging"), { recursive: true, force: true });
  },
});

// base "./" so the built site works from any folder or subpath (GitHub Pages, a static host, a USB stick).
export default defineConfig({
  base: "./",
  plugins: [dropStaging()],
  server: { host: true, port: 5190, proxy },
  preview: { host: true, port: 5190, proxy },
  // Spark (with its WASM sorter inlined) is ~3.3 MB on its own; it loads only near the live 3D scenes
  build: { target: "es2022", chunkSizeWarningLimit: 3500 },
});
