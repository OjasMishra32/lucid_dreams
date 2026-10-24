// The Court Side demo server (3.1, P36): the vite build and the court bundle, on 127.0.0.1 only (the Quest reaches it
// over USB with `adb reverse tcp:<port> tcp:<port>`), never through a tunnel. Plain JS so tsc and the vite build leave
// it alone. Owned by the integrator.
//   npm --prefix apps/webxr run build
//   node apps/webxr/src/court/serve.mjs --bundle <bundle folder, outside the repo> [--port 5185] [--dist apps/webxr/dist]
// Serves:  /            the build (index.html; open /?mode=court&bundle=/bundle/)
//          /bundle/...  the bundle folder (court.json beside it); CORS only for pages on localhost / 127.0.0.1, so the
//                       dev page and the e2e runner can read a real bundle without vite ever serving it
//          /court-sw.js the Service Worker (sw.js), scoped to /
// Refuses: any Host but 127.0.0.1 or localhost (DNS rebinding); a bundle inside this checkout or the main one (vite and
// the tunnel serve apps/webxr/ and dreams/; only the synthetic stand-in may be served from there, with --standin); and
// any path (symlinks included) that leaves its folder.
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const expand = (p) => (p.startsWith("~/") ? join(process.env.HOME ?? "", p.slice(2)) : p);

const bundleArg = opt("--bundle", null);
if (!bundleArg) {
  console.error("usage: node apps/webxr/src/court/serve.mjs --bundle <folder with court.json> [--port 5185] [--dist <vite build>]");
  process.exit(2);
}
const bundlePath = resolve(expand(bundleArg));
if (!existsSync(join(bundlePath, "court.json"))) {
  console.error(`no court.json in ${bundlePath}`);
  process.exit(2);
}
const BUNDLE = realpathSync(bundlePath);
const DIST_ARG = resolve(expand(opt("--dist", resolve(HERE, "../../dist"))));
const PORT = Number(opt("--port", 5185)); // 5180 is vite, 5190 apps/site
const SW = join(HERE, "sw.js");
// this checkout, and the main checkout when this is a worktree (where vite and the tunnel usually run)
const checkouts = [realpathSync(REPO)];
try {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: HERE, encoding: "utf8" }).trim();
  checkouts.push(realpathSync(dirname(common)));
} catch {
  // not a git checkout: this folder's repo is the only one
}
const within = (dir, root) => dir === root || dir.startsWith(root + sep);
if (!args.includes("--standin") && checkouts.some((root) => within(BUNDLE, root) || within(root, BUNDLE))) {
  console.error(`refusing ${BUNDLE}: it is inside a checkout that vite and the tunnel serve; keep the court bundle outside the repo (P36). The synthetic stand-in may pass --standin.`);
  process.exit(2);
}
if (!existsSync(join(DIST_ARG, "index.html"))) {
  console.error(`no build in ${DIST_ARG}: run npm --prefix apps/webxr run build first`);
  process.exit(2);
}
const DIST = realpathSync(DIST_ARG);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".wasm": "application/wasm", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".h264": "video/h264", ".glb": "model/gltf-binary",
  ".ply": "application/octet-stream", ".spz": "application/octet-stream",
};
const LOCAL_HOST = new RegExp(`^(127\\.0\\.0\\.1|localhost)(:${PORT})?$`);
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/** The real file a URL path names inside root (a real path), or null if it, or a symlink on the way, leaves root. */
function inside(root, urlPath) {
  try {
    const file = realpathSync(resolve(root, "." + urlPath));
    return within(file, root) && statSync(file).isFile() ? file : null;
  } catch {
    return null; // missing, or unreadable
  }
}

const server = createServer((req, res) => {
  const deny = (code) => {
    res.statusCode = code;
    res.end();
  };
  if (!LOCAL_HOST.test(req.headers.host ?? "")) return deny(403);
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
  } else file = inside(DIST, path === "/" ? "/index.html" : path);
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
  console.log(`Court Side on http://127.0.0.1:${PORT}/?mode=court&bundle=/bundle/ (bundle ${BUNDLE})`);
  console.log(`Quest over USB: adb reverse tcp:${PORT} tcp:${PORT}, then open that URL in the Quest browser`);
});
