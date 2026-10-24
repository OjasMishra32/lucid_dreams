import { defineConfig, type Plugin } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { appendFileSync, createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
    // the dev server and the built app's preview server (the headset gets the stable build) serve dreams alike
    configureServer: (server) => serveDreams(server.middlewares),
    configurePreviewServer: (server) => serveDreams(server.middlewares),
  };
}

function serveDreams(middlewares: { use: (path: string, fn: (req: any, res: any, next: () => void) => void) => void }) {
  // errors from the headset (src/xr/report.ts) land in ~/Library/Logs/lucid-xr-errors.log, one JSON line each
  middlewares.use("/__log", (req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString().slice(0, 20000)));
    req.on("end", () => {
      try {
        appendFileSync(join(homedir(), "Library/Logs/lucid-xr-errors.log"), body.replace(/\n/g, " ") + "\n");
      } catch {
        // a log that can't be written is not worth an error page
      }
      res.statusCode = 204;
      res.end();
    });
  });
  {
    {
      middlewares.use("/dreams", (req, res, next) => {
        const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
        if (path === "/index.json") {
          // held dreams (dreams/.held: one id per line, as the web app reads it) stay out of the list; a link to one
          // still opens it
          const heldFile = join(DREAMS, ".held");
          const held = new Set(existsSync(heldFile) ? readFileSync(heldFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : []);
          const list = existsSync(DREAMS)
            ? readdirSync(DREAMS)
                .filter((id) => !held.has(id))
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
        // a private dream (a family's: any ian-grandma* id, or "private": true) is never served from here, not even by a
        // direct link: this server is reachable through a tunnel; the Quest app plays it from the headset's own storage
        const id = path.split("/").filter(Boolean)[0] ?? "";
        const meta = join(DREAMS, id, "dream.json");
        if (/^ian-grandma/.test(id) || (existsSync(meta) && JSON.parse(readFileSync(meta, "utf8")).private === true)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        // the headset keeps a copy and asks each time: an unchanged frame costs a 304, not 4 MB again; one a re-export
        // changed comes fresh
        const st = statSync(file);
        res.setHeader("Last-Modified", st.mtime.toUTCString());
        res.setHeader("Cache-Control", "no-cache");
        const since = req.headers["if-modified-since"];
        if (since && Date.parse(since) >= Math.floor(st.mtimeMs / 1000) * 1000) {
          res.statusCode = 304;
          res.end();
          return;
        }
        res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
        res.setHeader("Content-Length", String(st.size));
        createReadStream(file).pipe(res);
      });
    }
  }
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
