// The Court Side e2e runner: starts apps/webxr's Vite dev server (plain http, a free port), opens
// `?mode=court&emulate&probe=capture` (or `probe=timing`) in headless system Chrome through an already-installed
// playwright-core (never a download), presses Enter (a real click), and drives the page through window.__court
// (src/court/probe.ts): every XR frame advances the show by exactly 1/72 s and is read back in the page.
//   node apps/webxr/scripts/court/e2e.mjs [--only smoke,...] [--timing] [--bundle <court.json URL>] [--out <dir>]
//        [--timeout <s per scenario, 240>] [--keep] (leave the browser's console log in the report)
// One PASS/FAIL line per check, a JSON report per scenario in scripts/court/out/e2e/ (with any saved frames as PNG);
// exit 0 only when every check passes. Run timing passes one at a time (parallel headless-Metal runs skew timing).
// Add a scenario by adding an entry to SCENARIOS: it gets `ctx` (below) and records checks with ctx.check().
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBXR = resolve(HERE, "../..");
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const OUT = resolve(opt("--out", join(HERE, "out", "e2e")));
const TIMING = args.includes("--timing");
const BUNDLE = opt("--bundle", null);
/** No scenario runs longer than this (a stuck page must fail, not hang the runner). */
const SCENARIO_S = Number(opt("--timeout", 240));

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

/** This checkout's vite on a free port: only accepted once its own output names the port (a port another run already
 * holds makes this vite exit, and a 200 from that one would test the other checkout). */
async function startVite() {
  let log = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 5300 + Math.floor(Math.random() * 600);
    const server = spawn(process.execPath, [join(WEBXR, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
      cwd: WEBXR,
      env: { ...process.env, LUCID_HTTP: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    log = "";
    server.stdout.on("data", (d) => (log += d));
    server.stderr.on("data", (d) => (log += d));
    const until = Date.now() + 30000;
    while (Date.now() < until && server.exitCode === null) {
      if (log.includes(`127.0.0.1:${port}`)) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return { server, port };
        } catch {
          // not answering yet
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    server.kill();
  }
  throw new Error(`vite did not start:\n${log}`);
}

/**
 * The scenarios. Each gets ctx:
 *   page, check(name, ok, detail), save(name) (the next frame as out/e2e/<name>.png), frames(n), until(phase, max),
 *   snapshot(), seatHere(), press(action), device(fn, arg) (runs fn(window.__xrDevice, arg) in the page), report (an
 *   object written to <scenario>.json).
 */
const SCENARIOS = {
  /** The page loads, enters the emulated session, takes Seat here and reaches the watch, drawn opaque. */
  async smoke(ctx) {
    const first = await ctx.page.evaluate(() => window.__court.nextFrame());
    ctx.check("session", first.phase === "arrival" && first.setup, `first XR frame in ${first.phase}, setup ${first.setup}`);
    await ctx.seatHere();
    const toWatch = await ctx.until("watching", 72 * 8);
    if (!toWatch.length) throw new Error("no frames rendered after Seat here");
    const last = toWatch[toWatch.length - 1];
    const reached = last?.phase === "watching";
    ctx.check("reaches the watch", reached, reached ? `watching after ${toWatch.length} frames (${(toWatch.length / 72).toFixed(2)} s of show time)` : `still ${last?.phase} after ${toWatch.length} frames`);
    const watching = reached ? await ctx.frames(72) : [];
    await ctx.save("smoke-watch");
    const all = [...toWatch, ...watching];
    if (!TIMING) {
      // every frame must have been read back, or the check proves nothing
      const read = all.filter((f) => typeof f.alphaMin === "number");
      const alphaMin = Math.min(...read.map((f) => f.alphaMin));
      ctx.check("opaque (P33)", read.length === all.length && alphaMin === 255, `alpha min ${alphaMin} over ${read.length} of ${all.length} frames read back`);
    }
    const phases = [...new Set(all.map((f) => f.phase))];
    ctx.report.phases = phases;
    ctx.report.framesToWatch = toWatch.length;
    ctx.report.frames = all.map(({ thumb, ...f }) => f);
    ctx.report.snapshot = await ctx.snapshot();
  },
};

async function main() {
  const only = (opt("--only", "smoke") ?? "smoke").split(",");
  for (const name of only) if (!SCENARIOS[name]) throw new Error(`no scenario "${name}" (have: ${Object.keys(SCENARIOS).join(", ")})`);
  mkdirSync(OUT, { recursive: true });
  const { chromium } = findPlaywright();
  const { server, port } = await startVite();
  let browser;
  let failed = 0;
  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--ignore-gpu-blocklist", "--use-angle=metal", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"],
    });
    for (const name of only) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const errors = [];
      const warnings = [];
      const consoleLog = [];
      page.on("console", (m) => {
        const text = m.text().slice(0, 400);
        consoleLog.push(`${m.type()}: ${text}`);
        if (m.type() === "error" && !text.startsWith("Failed to load resource")) errors.push(text);
        if (m.type() === "warning") warnings.push(text);
      });
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 400)));
      page.on("response", (r) => {
        if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) errors.push(`HTTP ${r.status()} ${r.url()}`);
      });
      const saved = [];
      await page.exposeFunction("__courtSave", async (file, w, h, b64) => {
        const out = join(OUT, `${String(file).replace(/[^a-zA-Z0-9_-]/g, "_")}.png`);
        writeFileSync(out, encodePng({ width: w, height: h, channels: 4, data: new Uint8Array(Buffer.from(b64, "base64")) }));
        saved.push(out);
        return out;
      });
      const checks = [];
      const report = { scenario: name, mode: TIMING ? "timing" : "capture", started: new Date().toISOString() };
      const check = (what, ok, detail) => {
        checks.push({ what, ok: !!ok, detail });
        console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${what}: ${detail}`);
      };
      const q = new URLSearchParams({ mode: "court", emulate: "", probe: TIMING ? "timing" : "capture" });
      if (BUNDLE) q.set("bundle", BUNDLE);
      const url = `http://127.0.0.1:${port}/?${q.toString().replace(/=(&|$)/g, "$1")}`;
      try {
        await page.goto(url, { waitUntil: "load" });
        await page.waitForFunction(() => window.__court && (window.__court.ready || window.__court.error), null, { timeout: 60000, polling: 200 });
        const loadError = await page.evaluate(() => window.__court.error);
        if (loadError) throw new Error(`the page could not load the bundle: ${loadError}`);
        report.modules = await page.evaluate(() => window.__court.modules);
        await page.click("#court-enter");
        const ctx = {
          page,
          check,
          report,
          save: (n) => page.evaluate((x) => window.__court.save(x), n),
          frames: (n) => page.evaluate((x) => window.__court.frames(x), n),
          until: (phase, max) => page.evaluate(([p, m]) => window.__court.until(p, m), [phase, max]),
          snapshot: () => page.evaluate(() => window.__court.snapshot()),
          seatHere: () => page.evaluate(() => window.__court.seatHere()),
          press: (action) => page.evaluate((a) => window.__court.press(a), action),
          device: (fn, arg) => page.evaluate(([src, a]) => new Function("device", "arg", `return (${src})(device, arg)`)(window.__xrDevice, a), [fn.toString(), arg]),
        };
        // everything that waits on frames runs under one timeout: a page that stops presenting fails, never hangs
        let timer;
        await Promise.race([
          (async () => {
            await SCENARIOS[name](ctx);
            if (TIMING) await ctx.frames(72 * 2);
          })(),
          new Promise((_, fail) => (timer = setTimeout(() => fail(new Error(`timed out after ${SCENARIO_S} s`)), SCENARIO_S * 1000))),
        ]).finally(() => clearTimeout(timer));
        if (TIMING) {
          report.timing = await page.evaluate(() => window.__court.timing());
          for (const [phase, t] of Object.entries(report.timing ?? {}))
            console.log(`TIME ${name}: ${phase}: cpu p50 ${t.cpu.p50} p95 ${t.cpu.p95} ms; gpu ${t.gpu ? `p50 ${t.gpu.p50} p95 ${t.gpu.p95} ms` : "n/a"} (${t.cpu.n} frames)`);
        }
        const pageErrors = await page.evaluate(() => window.__court.errors);
        errors.push(...pageErrors);
      } catch (e) {
        check("runs", false, String(e?.message ?? e).split("\n")[0]);
        consoleLog.slice(-30).forEach((l) => console.error(`  ${l}`));
      }
      check("console clean (P25)", errors.length === 0, errors.length ? `${errors.length} errors: ${errors.slice(0, 3).join(" | ")}` : `0 errors, ${warnings.length} warnings`);
      Object.assign(report, { url, checks, errors, warnings, saved, ...(args.includes("--keep") ? { console: consoleLog } : {}) });
      writeFileSync(join(OUT, `${name}${TIMING ? "-timing" : ""}.json`), JSON.stringify(report, null, 2));
      failed += checks.filter((c) => !c.ok).length;
      await page.close();
    }
  } finally {
    await browser?.close();
    server.kill();
  }
  console.log(failed ? `E2E FAIL (${failed} checks failed; reports in ${OUT})` : `E2E OK (reports in ${OUT})`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
