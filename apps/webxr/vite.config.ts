import { defineConfig, type Plugin } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";

// Dream bundles live in <repo>/dreams (pipeline/runner/lucid_runner.py fetch puts them there). Served at /dreams/,
// plus /dreams/index.json: every bundle's dream.json, newest first.
const DREAMS = resolve(import.meta.dirname, "../../dreams");
const TYPES: Record<string, string> = {
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".spz": "application/octet-stream",
  ".ply": "application/octet-stream",
};

function dreams(): Plugin {
  return {
    name: "lucid-dreams",
    configureServer(server) {
      server.middlewares.use("/dreams", (req, res, next) => {
        const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
        if (path === "/index.json") {
          const list = existsSync(DREAMS)
            ? readdirSync(DREAMS)
                .map((id) => join(DREAMS, id, "dream.json"))
                .filter((p) => existsSync(p))
                .map((p) => ({ ...JSON.parse(readFileSync(p, "utf8")), mtime: statSync(p).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime)
            : [];
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(list));
          return;
        }
        const file = resolve(DREAMS, "." + path);
        if (!file.startsWith(DREAMS) || !existsSync(file) || statSync(file).isDirectory()) return next();
        res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
        res.setHeader("Content-Length", String(statSync(file).size));
        res.setHeader("Cache-Control", "public, max-age=3600");
        createReadStream(file).pipe(res);
      });
    },
  };
}

// WebXR needs HTTPS on the headset: the dev server uses a self-signed certificate (accept it once in the Quest
// browser) and listens on the LAN so the headset can reach this Mac. LUCID_HTTP=1 serves plain HTTP for desktop checks.
const http = Boolean(process.env.LUCID_HTTP);
// The lesson's Ask button gets its Gemini Live token from the bridge (apps/web, plain http on :5170). A page served
// over https can't call http, so the viewer asks its own server, which passes it on (with the headset's address).
const bridge = { "/api/live": { target: process.env.LUCID_BRIDGE ?? "http://localhost:5170", xfwd: true } };
export default defineConfig({
  plugins: [http ? null : basicSsl(), dreams()],
  server: { host: true, port: 5180, proxy: bridge },
  preview: { host: true, port: 5180, proxy: bridge },
});
