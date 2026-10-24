// The Court Side demo server (3.1, P36): the page and the court bundle, on 127.0.0.1 only (the Quest reaches it over USB
// with `adb reverse tcp:<port> tcp:<port>`), never through a tunnel. Plain JS so tsc and the vite build leave it alone.
// Owned by the integrator.
//   npm --prefix apps/webxr run build
//   node apps/webxr/src/court/serve.mjs --bundle <bundle folder, outside the repo> [--port 5185] [--dist apps/webxr/dist]
//   node apps/webxr/src/court/serve.mjs --dev --bundle <folder> [--standin] [--port 0] [--headset-dir <folder>]
// Serves:  /            the build (index.html; open /?mode=court&bundle=/bundle/), or with --dev apps/webxr's vite dev
//                       server as middleware (plain http, HMR on this port; the only way to get IWER's ?emulate, which
//                       loads in dev only: the e2e runs through this)
//          /bundle/...  the bundle folder (court.json beside it); CORS only for pages on localhost / 127.0.0.1, so the
//                       dev page and the e2e runner can read a real bundle without vite ever serving it
//          /court-sw.js the Service Worker (sw.js), scoped to /
//          POST /__court/headset (--dev only): `?probe=headset`'s records, appended to --headset-dir (else
//                       $COURT_DATA/qa/headset)/<session>.jsonl (headset-sink.mjs)
// Refuses: any Host but 127.0.0.1 or localhost (DNS rebinding); a bundle inside any checkout of the repo, worktrees
// included (vite and the tunnel serve apps/webxr/ and dreams/; only the synthetic stand-in may be served from there,
// with --standin); and any path (symlinks included) that leaves its folder. `--port 0` takes a free port; the first
// line printed names it.
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HEADSET_PATH, headsetDir, headsetSink } from "./headset-sink.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBXR = resolve(HERE, "../..");
const REPO = resolve(WEBXR, "../..");
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const expand = (p) => (p.startsWith("~/") ? join(process.env.HOME ?? "", p.slice(2)) : p);

const DEV = args.includes("--dev");
const bundleArg = opt("--bundle", null);
if (!bundleArg) {
  console.error("usage: node apps/webxr/src/court/serve.mjs [--dev] --bundle <folder with court.json> [--standin] [--port 5185] [--dist <vite build>]");
  process.exit(2);
}
const bundlePath = resolve(expand(bundleArg));
if (!existsSync(join(bundlePath, "court.json"))) {
  console.error(`no court.json in ${bundlePath}`);
  process.exit(2);
}
// realpath(3) (`.native`): the on-disk spelling, so a path typed in other capitals on a case-insensitive disk can't slip
// past the checks below
const real = realpathSync.native;
const BUNDLE = real(bundlePath);
const DIST_ARG = resolve(expand(opt("--dist", join(WEBXR, "dist"))));
const PORT = Number(opt("--port", 5185)); // 5180 is vite, 5190 apps/site; 0 = any free port
const SW = join(HERE, "sw.js");
// every checkout of this repo: this one, the main one and every worktree (vite dev in any of them serves its folder on
// the LAN, and the tunnel the main one's)
const checkouts = [real(REPO)];
try {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: HERE, encoding: "utf8" }).trim();
  checkouts.push(real(dirname(common)));
  const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: HERE, encoding: "utf8" });
  for (const line of list.split("\n")) if (line.startsWith("worktree ") && existsSync(line.slice(9))) checkouts.push(real(line.slice(9)));
} catch {
  // not a git checkout: this folder's repo is the only one
}
const within = (dir, root) => dir === root || dir.startsWith(root + sep);
// --standin admits exactly the synthetic stand-in (standin.mjs's folder), nothing else inside a checkout
const STANDIN = join(WEBXR, "scripts", "court", "out", "standin");
const standin = args.includes("--standin") && existsSync(STANDIN) && BUNDLE === real(STANDIN);
if (args.includes("--standin") && !standin) {
  console.error(`refusing --standin for ${BUNDLE}: it admits only the stand-in at ${STANDIN}`);
  process.exit(2);
}
if (!standin && checkouts.some((root) => within(BUNDLE, root) || within(root, BUNDLE))) {
  console.error(`refusing ${BUNDLE}: it is inside a checkout that vite and the tunnel serve; keep the court bundle outside the repo (P36). The synthetic stand-in may pass --standin.`);
  process.exit(2);
}
if (!DEV && !existsSync(join(DIST_ARG, "index.html"))) {
  console.error(`no build in ${DIST_ARG}: run npm --prefix apps/webxr run build first`);
  process.exit(2);
}
const DIST = DEV ? null : real(DIST_ARG);
const HEADSET_DIR = DEV ? headsetDir(opt("--headset-dir", null)) : null;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".wasm": "application/wasm", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".h264": "video/h264", ".glb": "model/gltf-binary",
  ".ply": "application/octet-stream", ".spz": "application/octet-stream",
};
let LOCAL_HOST = null; // set once listening (the real port, when --port 0)
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/** The real file a URL path names inside root (a real path), or null if it, or a symlink on the way, leaves root. */
function inside(root, urlPath) {
  try {
    const file = real(resolve(root, "." + urlPath));
    return within(file, root) && statSync(file).isFile() ? file : null;
  } catch {
    return null; // missing, or unreadable
  }
}

const server = createServer();
let vite = null;
if (DEV) {
  process.env.LUCID_HTTP = "1"; // vite.config.ts: no self-signed certificate, this server is plain http
  const { createServer: createVite } = await import("vite");
  // HMR's socket rides on this server (same host and port; vite checks the Host and its token on the upgrade itself)
  // its own dependency cache per checkout (git-ignored): worktrees share node_modules through a symlink, and two vites
  // re-optimizing one node_modules/.vite answer each other's pages with 504 "Outdated Optimize Dep"
  const cacheDir = join(WEBXR, "scripts", "court", "out", "vite-deps");
  vite = await createVite({ root: WEBXR, configFile: join(WEBXR, "vite.config.ts"), appType: "spa", logLevel: "warn", cacheDir, server: { middlewareMode: true, ws: { server } } });
}

server.on("request", (req, res) => {
  const deny = (code) => {
    res.statusCode = code;
    res.end();
  };
  if (!LOCAL_HOST?.test(req.headers.host ?? "")) return deny(403);
  if (DEV && req.method === "POST" && (req.url ?? "").split("?")[0] === HEADSET_PATH) return headsetSink(req, res, HEADSET_DIR);
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") return deny(405);
  let path;
  try {
    path = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
  } catch {
    return deny(400);
  }
  let file = null;
  if (path === "/court-sw.js") {
    file = SW;
    res.setHeader("Service-Worker-Allowed", "/");
  } else if (path.startsWith("/bundle/")) {
    file = inside(BUNDLE, path.slice("/bundle".length));
    const origin = req.headers.origin;
    if (origin && LOCAL_ORIGIN.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") return deny(204);
  } else if (vite) return vite.middlewares(req, res, () => deny(404));
  else file = inside(DIST, path === "/" ? "/index.html" : path);
  if (!file) return deny(404);
  let st;
  try {
    st = statSync(file);
  } catch {
    return deny(404); // replaced by a re-sync between the lookup and now
  }
  res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
  res.setHeader("Content-Length", String(st.size));
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Last-Modified", st.mtime.toUTCString());
  if (req.method === "HEAD") return res.end();
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  const port = server.address().port;
  LOCAL_HOST = new RegExp(`^(127\\.0\\.0\\.1|localhost)(:${port})?$`);
  console.log(`Court Side on http://127.0.0.1:${port}/?mode=court&bundle=/bundle/${DEV ? "&emulate" : ""} (bundle ${BUNDLE}${DEV ? ", vite dev" : ""})`);
  console.log(`Quest over USB: adb reverse tcp:${port} tcp:${port}, then open that URL in the Quest browser`);
  if (DEV) console.log(HEADSET_DIR ? `?probe=headset records -> ${HEADSET_DIR}` : "?probe=headset records: none kept (pass --headset-dir or set COURT_DATA)");
});
const stop = () => {
  server.close();
  void (vite ? vite.close() : Promise.resolve()).finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
