import { defineConfig } from "vite";

// base "./" so the built site works from any folder or subpath (GitHub Pages, a static host, a USB stick).
export default defineConfig({
  base: "./",
  server: { host: true, port: 5190 },
  preview: { host: true, port: 5190 },
  // Spark (with its WASM sorter inlined) is ~3.3 MB on its own; it loads after the page paints, so the warning is noise
  build: { target: "es2022", chunkSizeWarningLimit: 3500 },
});
