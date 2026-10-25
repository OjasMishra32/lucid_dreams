import { defineConfig, type Plugin } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { appendFileSync, createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, extname } from "node:path";

// Where the app lives on its server: "/" on its own, "/xr/" when the website (apps/web) serves it at one address with
// the rest of Lucid Dreams (LUCID_BASE=/xr/: the headset's stable build). The routes below answer under both.
const BASE = process.env.LUCID_BASE ?? "/";
const mounts = (path: string) => (BASE === "/" ? [path] : [path, BASE.replace(/\/$/, "") + path]);

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

// Talk with them (apps/talk on :5175, src/talk.ts) for the people whose consent covers talk going through this server,
// which a tunnel makes public: the Talk server's token is added here from apps/talk/.env, so it never reaches a page.
// Vishal (his own word) and Ian's grandma (her family agreed to her being shown and heard: Ojasva, Sat Oct 24).
const TALK = process.env.LUCID_TALK ?? "http://localhost:5175";
const TALK_HERE = new Set(["vishal", "grandma"]);
const talkToken = () => {
  // beside this app in the repo; the headset's stable build is a copy of apps/webxr alone, whose dreams/ links back
  // into the repo, so look there too
  const homes = [process.env.LUCID_TALK_ENV, resolve(import.meta.dirname, "../talk/.env")];
  try {
    homes.push(resolve(realpathSync(DREAMS), "../apps/talk/.env"));
  } catch {
    // no dreams folder: no second place to look
  }
  for (const f of homes) {
    if (!f || !existsSync(f)) continue;
    const t = readFileSync(f, "utf8").match(/^TALK_TOKEN=(.*)$/m)?.[1]?.trim();
    if (t) return t;
  }
  return "";
};
async function relayTalk(req: any, res: any) {
  const url = new URL(req.url ?? "/", "http://talk");
  const send = (code: number, body: string | Buffer, type = "application/json") => {
    res.statusCode = code;
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  };
  // who's talking (their address, from the tunnel), so the Talk server's limits count each visitor, not this relay
  const visitor =
    String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || String(req.headers["cf-connecting-ip"] ?? "").trim() || req.socket?.remoteAddress || "";
  const headers = { "x-talk-token": talkToken(), "x-forwarded-for": visitor };
  try {
    const audio = url.pathname.match(/^\/audio\/([\w-]+)\.wav$/);
    if (audio && req.method === "GET") {
      const r = await fetch(`${TALK}/api/talk/audio/${audio[1]}.wav`, { headers });
      return send(r.status, Buffer.from(await r.arrayBuffer()), r.headers.get("content-type") ?? "audio/wav");
    }
    const m = url.pathname.match(/^\/([\w-]+)(\/health|\/reset)?$/);
    if (!m || !TALK_HERE.has(m[1])) return send(404, JSON.stringify({ error: "nobody to talk to by that name here" }));
    const who = m[1];
    if (m[2] === "/health") {
      const r = await fetch(`${TALK}/api/health`, { headers });
      const j = (await r.json()) as { ok?: boolean; people?: Record<string, { voice?: boolean }> };
      return send(r.ok ? 200 : 502, JSON.stringify({ ok: !!j.ok && !!j.people?.[who], voice: !!j.people?.[who]?.voice }));
    }
    if (req.method !== "POST") return send(405, JSON.stringify({ error: "POST what you said" }));
    const parts: Buffer[] = [];
    let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      size += c.length;
      if (size > 10 * 1024 * 1024) return send(413, JSON.stringify({ error: "too long: keep it under a minute" }));
      parts.push(c);
    }
    const session = encodeURIComponent((url.searchParams.get("session") ?? "default").slice(0, 64));
    const path = m[2] === "/reset" ? "/api/talk/reset" : "/api/talk";
    const r = await fetch(`${TALK}${path}?who=${who}&session=${session}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": req.headers["content-type"] ?? "audio/webm" },
      body: Buffer.concat(parts),
    });
    const j = (await r.json()) as { audio?: string | null };
    if (j.audio) j.audio = j.audio.replace(/^\/api\/talk\/audio\//, `${BASE}talk/audio/`);
    return send(r.status, JSON.stringify(j));
  } catch {
    return send(502, JSON.stringify({ error: "the Talk server isn't answering" }));
  }
}

function serveDreams(middlewares: { use: (path: string, fn: (req: any, res: any, next: () => void) => void) => void }) {
  for (const at of mounts("/talk")) middlewares.use(at, (req, res) => void relayTalk(req, res));
  // errors from the headset (src/xr/report.ts) land in ~/Library/Logs/lucid-xr-errors.log, one JSON line each
  for (const at of mounts("/__log")) middlewares.use(at, (req, res) => {
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
      for (const at of mounts("/dreams")) middlewares.use(at, (req, res, next) => {
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
        // a private dream ("private": true, or a family's ian-grandma* run not marked "private": false) is never served
        // from here, not even by a direct link: this server is reachable through a tunnel; the Quest app plays it from
        // the headset's own storage
        const id = path.split("/").filter(Boolean)[0] ?? "";
        const meta = join(DREAMS, id, "dream.json");
        let flag: unknown = null;
        try {
          flag = existsSync(meta) ? JSON.parse(readFileSync(meta, "utf8")).private : null;
        } catch {
          flag = true;
        }
        if (flag === true || (/^ian-grandma/i.test(id) && flag !== false)) {
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
const toBridge = { target: process.env.LUCID_BRIDGE ?? "http://localhost:5170", xfwd: true };
const bridge = Object.fromEntries(
  mounts("/api/live").map((at) => [at, at === "/api/live" ? toBridge : { ...toBridge, rewrite: (p: string) => p.slice(at.length - "/api/live".length) }]),
);
export default defineConfig({
  base: BASE,
  plugins: [http ? null : basicSsl(), dreams()],
  server: { host: true, port: 5180, proxy: bridge },
  preview: { host: true, port: 5180, proxy: bridge },
});
