// The cable-off check (HEADSET 34-35, here in desktop Chrome): the production build served by serve.mjs (no --dev),
// IWER injected into the page (the build has no ?emulate), one online visit until the Service Worker holds the page,
// the show and the fallbacks; then the server stops (the cable comes out) and the main URL and each fallback flag
// (?show=small, ?hz=90, ?video=element) must load from the cache alone, offer Enter and start the session, with no
// request failing and no console error; pass 1's MP4 (the element fallback) must play from the cache in a <video>.
// A flag whose fallback the bundle doesn't have is a SKIP (the page refuses that flag online too; the stand-in has
// only the small stream). Stream C (`core`).
//   node apps/webxr/scripts/court/qa/offline.mjs [--bundle <folder with court.json>] [--no-build] [--json]
// --bundle defaults to the stand-in (scripts/court/out/standin, served with --standin; make it with
// `node apps/webxr/scripts/court/standin.mjs`); a real bundle lives outside the repo (serve.mjs refuses one inside).
// --no-build serves apps/webxr/dist as it is. One PASS/FAIL/SKIP line per check; exit 0 when every check that ran
// passes, 1 when one fails, 2 when it can't run (the build fails, no Chrome, no playwright-core, no IWER).
//   Negative control: COURT_E2E_CONTROL=offline-evict drops the main show stream from the cache just before the cable
// comes out; the main URL's line must FAIL then.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBXR = resolve(HERE, "../../..");
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const STANDIN = join(WEBXR, "scripts/court/out/standin");
const BUNDLE = resolve(opt("--bundle", STANDIN));
const IS_STANDIN = !args.includes("--bundle");
const JSON_OUT = args.includes("--json");
/** The fallbacks by URL flag: court.json's video.fallbacks key each one picks. */
export const FLAGS = [
  ["show=small", "small"],
  ["hz=90", "hz90"],
  ["video=element", "element"],
];
/** How long the online visit may take to cache the show and then the fallbacks, s. */
const CACHE_S = 300;

/** Every bundle-relative file path in a court.json value (strings that look like files inside the bundle; sw.js's rule). */
export function filePaths(value) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === "string" && /^[\w./-]+\.[a-z0-9]{2,5}$/i.test(v) && !v.startsWith("/") && !v.includes("..")) out.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return [...out];
}

/** The paths the main show needs (court.json and every file it names outside `fallbacks`) and each fallback's own. */
export function wanted(court) {
  const { fallbacks = {}, ...video } = court.video ?? {};
  return {
    main: ["court.json", ...filePaths({ ...court, video })],
    fallbacks: Object.fromEntries(FLAGS.map(([, key]) => [key, fallbacks[key] === undefined ? null : filePaths(fallbacks[key])])),
  };
}

/** playwright-core from apps/webxr's node_modules, $PLAYWRIGHT_CORE, or the npx cache (newest); never downloaded. */
function findPlaywright() {
  const require = createRequire(join(WEBXR, "package.json"));
  const tries = [];
  if (process.env.PLAYWRIGHT_CORE) tries.push(process.env.PLAYWRIGHT_CORE);
  try {
    tries.push(dirname(require.resolve("playwright-core/package.json")));
  } catch {
    // not a dependency of apps/webxr: look in the npx cache
  }
  const npx = join(homedir(), ".npm", "_npx");
  if (existsSync(npx))
    readdirSync(npx)
      .map((d) => join(npx, d, "node_modules", "playwright-core"))
      .filter((d) => existsSync(join(d, "package.json")))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .forEach((d) => tries.push(d));
  for (const dir of tries) {
    try {
      return require(dir);
    } catch {
      // try the next one
    }
  }
  throw new Error("playwright-core not found: set PLAYWRIGHT_CORE=<dir of playwright-core> (nothing is downloaded)");
}

/** serve.mjs on the build, a free port, accepted once it answers for court.json. */
async function startServer() {
  const argv = [join(WEBXR, "src/court/serve.mjs"), "--port", "0", "--bundle", BUNDLE, "--dist", join(WEBXR, "dist")];
  if (IS_STANDIN) argv.push("--standin");
  const server = spawn(process.execPath, argv, { cwd: WEBXR, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const until = Date.now() + 30000;
  while (Date.now() < until && server.exitCode === null) {
    const port = /Court Side on http:\/\/127\.0\.0\.1:(\d+)\//.exec(log)?.[1];
    if (port) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/bundle/court.json`)).ok) return { server, port: Number(port) };
      } catch {
        // not answering yet
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  server.kill();
  throw new Error(`serve.mjs did not start:\n${log}`);
}

async function main() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    if (!JSON_OUT) console.log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"} offline: ${name}: ${detail}`);
  };
  if (!existsSync(join(BUNDLE, "court.json"))) throw new Error(`no court.json in ${BUNDLE}${IS_STANDIN ? " (make the stand-in: node apps/webxr/scripts/court/standin.mjs)" : ""}`);
  if (!args.includes("--no-build")) {
    const b = spawnSync("npm", ["--prefix", WEBXR, "run", "build"], { encoding: "utf8" });
    if (b.status !== 0) throw new Error(`the build failed:\n${(b.stdout + b.stderr).slice(-2000)}`);
  }
  if (!existsSync(join(WEBXR, "dist", "index.html"))) throw new Error("no build in apps/webxr/dist (drop --no-build)");
  const iwerFile = join(WEBXR, "node_modules/iwer/build/iwer.min.js");
  if (!existsSync(iwerFile)) throw new Error("no IWER build at apps/webxr/node_modules/iwer/build/iwer.min.js (npm --prefix apps/webxr install)");
  const iwer = readFileSync(iwerFile, "utf8");
  const court = JSON.parse(readFileSync(join(BUNDLE, "court.json"), "utf8"));
  const want = wanted(court);
  const pw = findPlaywright();
  const { chromium } = pw.default ?? pw;
  let { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}/?mode=court&bundle=/bundle/`;
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--ignore-gpu-blocklist", "--use-angle=metal", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    // IWER as the headset (a Quest 3 with hands), installed before the page's own scripts
    await context.addInitScript({
      content: `${iwer};(() => { const d = new IWER.XRDevice(IWER.metaQuest3); d.installRuntime({ forceInstall: true }); d.primaryInputMode = "hand"; window.__xrDevice = d; })();`,
    });
    const page = await context.newPage();
    const errors = [];
    const failed = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    page.on("requestfailed", (r) => failed.push(`${new URL(r.url()).pathname} (${r.failure()?.errorText ?? "failed"})`));
    const status = () => page.evaluate(() => document.querySelector("#court-status")?.textContent ?? document.body.innerText.slice(0, 120));
    const cached = () =>
      page.evaluate(async () => {
        const out = [];
        for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
        return out;
      });
    const loaded = () => page.waitForFunction(() => !/Loading the court/.test(document.body.innerText) && document.querySelector("#court-enter")?.disabled === false, null, { timeout: 60000 });

    // online: the page, the show, then the fallbacks in the background
    let t = Date.now();
    await page.goto(base, { waitUntil: "load" });
    await loaded();
    check("online, the page loads and offers Enter", true, `${await status()} in ${Date.now() - t} ms`);
    const need = [...want.main, ...Object.values(want.fallbacks).flatMap((p) => p ?? [])].map((p) => `/bundle/${p}`);
    let have = new Set();
    for (const until = Date.now() + CACHE_S * 1000; Date.now() < until; await page.waitForTimeout(1000)) {
      have = new Set(await cached());
      if (have.has("/") && need.every((p) => have.has(p))) break;
    }
    const missing = (paths) => paths.map((p) => `/bundle/${p}`).filter((p) => !have.has(p));
    check("the Service Worker caches the page", have.has("/"), have.has("/") ? "/ cached" : "/ not cached");
    check("the Service Worker caches the main show", missing(want.main).length === 0, `${want.main.length - missing(want.main).length} of ${want.main.length} files${missing(want.main).length ? `; missing ${missing(want.main).join(" ")}` : ""}`);
    for (const [, key] of FLAGS) {
      const paths = want.fallbacks[key];
      if (paths) check(`the Service Worker caches the ${key} fallback`, missing(paths).length === 0, `${paths.length - missing(paths).length} of ${paths.length} files in ${Math.round((Date.now() - t) / 1000)} s${missing(paths).length ? `; missing ${missing(paths).join(" ")}` : ""}`);
    }

    if (process.env.COURT_E2E_CONTROL === "offline-evict") {
      const evicted = await page.evaluate(async (url) => {
        let n = 0;
        for (const k of await caches.keys()) if (await (await caches.open(k)).delete(url)) n++;
        return n;
      }, `/bundle/${court.video.file}`);
      check("negative control: the main show stream dropped from the cache (the main URL must FAIL)", null, `${court.video.file}: ${evicted} cache entr${evicted === 1 ? "y" : "ies"} dropped`);
    }
    // the cable comes out
    server.kill();
    await new Promise((r) => server.once("exit", r));
    for (const [flag, key] of [[null, null], ...FLAGS]) {
      const name = flag ? `?${flag}` : "the main URL";
      if (key && !want.fallbacks[key]) {
        check(`cable off, ${name}`, null, `the bundle has no ${key} fallback (court.json video.fallbacks.${key}); the page refuses ${name} online too`);
        continue;
      }
      errors.length = 0;
      failed.length = 0;
      t = Date.now();
      let entered = "never entered";
      try {
        await page.goto(flag ? `${base}&${flag}` : base, { waitUntil: "load" });
        await loaded();
        const ready = Date.now() - t;
        await page.click("#court-enter");
        await page.waitForFunction(() => /In the headset/.test(document.querySelector("#court-status")?.textContent ?? ""), null, { timeout: 15000 });
        await page.waitForTimeout(2000); // frames run in the session
        entered = `loads in ${ready} ms, then "${await status()}"`;
      } catch (e) {
        entered = `${(e.message ?? String(e)).split("\n")[0]} (status "${await status().catch(() => "?")}")`;
      }
      const uses = key ? `the ${key} fallback` : "the main show";
      const clean = errors.length === 0 && failed.length === 0;
      check(`cable off, ${name} loads from the cache and enters (${uses})`, /^loads/.test(entered) && clean, `${entered}${failed.length ? `; failed: ${failed.slice(0, 4).join(", ")}` : ""}${errors.length ? `; console: ${errors.slice(0, 3).join(" | ")}` : ""}`);
    }
    // pass 1's MP4 in a <video>, from the cache alone, as video.ts plays it: from the start at 1x (it never seeks)
    if (want.fallbacks.element) {
      const src = `/bundle/${want.fallbacks.element[0]}`;
      const r = await page.evaluate(async (url) => {
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        let frames = 0;
        const count = () => {
          frames++;
          v.requestVideoFrameCallback(count);
        };
        v.requestVideoFrameCallback(count);
        try {
          await new Promise((ok, fail) => {
            v.addEventListener("loadeddata", () => ok(), { once: true });
            v.addEventListener("error", () => fail(new Error(`media error ${v.error?.code}`)), { once: true });
            setTimeout(() => fail(new Error("no loadeddata in 15 s")), 15000);
            v.src = url;
          });
          await v.play();
          const until = performance.now() + 5000;
          while (v.currentTime < 1.5 && !v.ended && performance.now() < until) await new Promise((r) => setTimeout(r, 100));
          const played = v.currentTime;
          v.pause();
          return { ok: played >= 1.5 || v.ended, detail: `${v.duration.toFixed(2)} s, ${v.videoWidth} x ${v.videoHeight}: played to ${played.toFixed(2)} s, ${frames} frames presented` };
        } catch (e) {
          return { ok: false, detail: String(e.message ?? e) };
        }
      }, src);
      check("cable off, pass 1's MP4 plays in a <video> from the cache", r.ok, r.detail);
    }
  } finally {
    await browser.close();
    server.kill();
  }
  if (JSON_OUT) console.log(JSON.stringify({ bundle: IS_STANDIN ? "stand-in" : "real", results }, null, 1));
  return results.some((r) => r.ok === false) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`offline: can't run: ${e.message ?? e}`);
      process.exit(2);
    },
  );
}
