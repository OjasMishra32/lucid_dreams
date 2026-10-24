// The Court Side e2e runner: starts src/court/serve.mjs --dev (apps/webxr's vite as middleware, plain http on
// 127.0.0.1, a free port; IWER's ?emulate loads in dev only) with the court bundle at /bundle/, opens
// `?mode=court&emulate&probe=capture&bundle=/bundle/` (or `probe=timing`) in headless system Chrome through an
// already-installed playwright-core (never a download), presses Enter (a real click), and drives the page through
// window.__court (src/court/probe.ts): every XR frame advances the show by exactly 1/72 s and is read back in the page.
//   node apps/webxr/scripts/court/e2e.mjs [--only smoke,layers,...|all] [--timing] [--bundle <folder with court.json>]
//        [--query show=small] [--out <dir>] [--timeout <s per scenario, 240>] [--keep] (the console log in the report)
//        [--force] (run a scenario even while a module it needs isn't BUILT: to try a scenario against the stubs)
// --bundle defaults to the stand-in (scripts/court/out/standin, `node apps/webxr/scripts/court/standin.mjs`); a real
// bundle must live outside the repo (serve.mjs refuses it otherwise). One PASS/FAIL/SKIP line per check, a JSON report
// per scenario in scripts/court/out/e2e/ (with any saved frames as PNG). Exit 0 when every check that ran passed,
// 1 on any failure, 3 when every scenario asked for was skipped (nothing was checked). Run timing passes one at a time
// (parallel headless-Metal runs skew timing).
// Scenarios are files, one per check family, each owned by one stream: scripts/court/scenarios/<name>.mjs exports
// `needs` (court.ts module names that must be BUILT, window.__court.modules; until then the scenario is a SKIP) and a
// default async function(ctx). The runner is the integrator's; add or change a scenario only in its own file.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodePng } from "./png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBXR = resolve(HERE, "../..");
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const OUT = resolve(opt("--out", join(HERE, "out", "e2e")));
const TIMING = args.includes("--timing");
const STANDIN = join(HERE, "out", "standin");
const BUNDLE = resolve(opt("--bundle", STANDIN));
const IS_STANDIN = !args.includes("--bundle");
const QUERY = opt("--query", "");
/** No scenario runs longer than this (a stuck page must fail, not hang the runner). */
const SCENARIO_S = Number(opt("--timeout", 240));
const SCENARIO_DIR = join(HERE, "scenarios");

/** Thrown by ctx.skip(): the scenario can't run here (not a failure). */
class Skip extends Error {}

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

/** This checkout's serve.mjs --dev on a free port, accepted once its own first line names the port. */
async function startServer() {
  const argv = [join(WEBXR, "src/court/serve.mjs"), "--dev", "--port", "0", "--bundle", BUNDLE];
  if (IS_STANDIN) argv.push("--standin");
  const server = spawn(process.execPath, argv, { cwd: WEBXR, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const until = Date.now() + 60000;
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
  throw new Error(`serve.mjs --dev did not start:\n${log}`);
}

/** Every scenario file: { name, needs, run }. */
async function loadScenarios() {
  const out = {};
  for (const file of readdirSync(SCENARIO_DIR).filter((f) => f.endsWith(".mjs")).sort()) {
    const mod = await import(pathToFileURL(join(SCENARIO_DIR, file)).href);
    out[basename(file, ".mjs")] = { needs: mod.needs ?? [], owner: mod.owner ?? "?", run: mod.default };
  }
  return out;
}

/**
 * Each scenario gets ctx:
 *   page; modules (window.__court.modules: which court.ts modules are BUILT); check(name, ok, detail); skip(reason) (throws: the rest of the scenario doesn't run); report (an object
 *   written to <scenario>.json); timing (true on a timing pass: no read-back); out (the report folder);
 *   court, showFrames (the bundle's court.json and video/frames.json); standin (true when the bundle is the stand-in, so
 *   truth(view, showFrame) works: the true scene from a captured frame's view, standin.mjs truthAt);
 *   writePng(name, { width, height, rgb | rgba }) (into out/, returns the path);
 *   nextFrame(); frames(n); until(phase, max); save(name) (the next frame as out/<name>.png; resolves with its log,
 *   view included); snapshot(); seatHere(); press(action); pressFrames(action, n) (press, then the next n frames,
 *   starting with the frame that acts on the press: frames run freely, so time anything that starts at a press this
 *   way, never with a separate frames() call);
 *   device(fn, arg) (runs fn(window.__xrDevice, arg) in the page: IWER's XRDevice, e.g. position, quaternion, hands,
 *   updateVisibilityState).
 */
function makeContext(page, check, report, bundleJson) {
  let standin = null;
  return {
    page,
    modules: report.modules,
    check,
    report,
    timing: TIMING,
    out: OUT,
    court: bundleJson.court,
    showFrames: bundleJson.frames,
    standin: IS_STANDIN,
    skip: (reason) => {
      throw new Skip(reason);
    },
    truth: async (view, showFrame, opts) => {
      if (!IS_STANDIN) throw new Error("truth() needs the stand-in bundle (no --bundle)");
      standin ??= await import("./standin.mjs");
      const src = bundleJson.frames[showFrame]?.src;
      if (src === undefined) throw new Error(`truth(): no show frame ${showFrame}`);
      return standin.truthAt(view, src, opts);
    },
    writePng: (name, img) => {
      const file = join(OUT, `${String(name).replace(/[^a-zA-Z0-9_-]/g, "_")}.png`);
      const data = img.rgba ?? img.rgb;
      writeFileSync(file, encodePng({ width: img.width, height: img.height, channels: img.rgba ? 4 : 3, data }));
      return file;
    },
    nextFrame: () => page.evaluate(() => window.__court.nextFrame()),
    frames: (n) => page.evaluate((x) => window.__court.frames(x), n),
    until: (phase, max) => page.evaluate(([p, m]) => window.__court.until(p, m), [phase, max]),
    save: (n) => page.evaluate((x) => window.__court.save(x), n),
    snapshot: () => page.evaluate(() => window.__court.snapshot()),
    seatHere: () => page.evaluate(() => window.__court.seatHere()),
    press: (action) => page.evaluate((a) => window.__court.press(a), action),
    pressFrames: (action, n) => page.evaluate(([a, m]) => (window.__court.press(a), window.__court.frames(m)), [action, n]),
    device: (fn, arg) => page.evaluate(([src, a]) => new Function("device", "arg", `return (${src})(device, arg)`)(window.__xrDevice, a), [fn.toString(), arg]),
  };
}

/** The page every scenario opens: the court in IWER, probed, the bundle from serve.mjs, plus --query. */
function pageUrl(port) {
  const q = new URLSearchParams({ mode: "court", emulate: "", probe: TIMING ? "timing" : "capture", bundle: "/bundle/" });
  for (const [k, v] of new URLSearchParams(QUERY)) q.set(k, v);
  return `http://127.0.0.1:${port}/?${q.toString().replace(/=(&|$)/g, "$1")}`;
}

async function main() {
  const scenarios = await loadScenarios();
  const asked = opt("--only", "smoke");
  const only = asked === "all" ? Object.keys(scenarios) : asked.split(",");
  for (const name of only) if (!scenarios[name]) throw new Error(`no scenario "${name}" (have: ${Object.keys(scenarios).join(", ")})`);
  if (!existsSync(join(BUNDLE, "court.json")))
    throw new Error(`no court.json in ${BUNDLE}${IS_STANDIN ? ": make the stand-in first (node apps/webxr/scripts/court/standin.mjs)" : ""}`);
  const court = JSON.parse(readFileSync(join(BUNDLE, "court.json"), "utf8"));
  const bundleJson = { court, frames: JSON.parse(readFileSync(join(BUNDLE, court.video.frames), "utf8")) };
  mkdirSync(OUT, { recursive: true });
  const { chromium } = findPlaywright();
  const { server, port } = await startServer();
  let browser;
  let failed = 0;
  const skipped = [];
  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--ignore-gpu-blocklist", "--use-angle=metal", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"],
    });
    // warm the dev server with one throwaway load of the same page: vite optimizes the dependencies it discovers on a
    // first load and answers a page that raced it with 504 "Outdated Optimize Dep"; no scenario should be that page
    const warm = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await warm.goto(pageUrl(port), { waitUntil: "load" });
      await warm.waitForFunction(() => window.__court && (window.__court.ready || window.__court.error), null, { timeout: 90000, polling: 200 });
    } catch (e) {
      console.log(`(warm-up: ${String(e?.message ?? e).split("\n")[0]})`);
    } finally {
      await warm.close();
    }
    for (const name of only) {
      const scenario = scenarios[name];
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
      const report = { scenario: name, owner: scenario.owner, mode: TIMING ? "timing" : "capture", started: new Date().toISOString() };
      const check = (what, ok, detail) => {
        checks.push({ what, ok: !!ok, detail });
        console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${what}: ${detail}`);
      };
      const url = pageUrl(port);
      let skip = null;
      try {
        await page.goto(url, { waitUntil: "load" });
        await page.waitForFunction(() => window.__court && (window.__court.ready || window.__court.error), null, { timeout: 60000, polling: 200 });
        const loadError = await page.evaluate(() => window.__court.error);
        if (loadError) throw new Error(`the page could not load the bundle: ${loadError}`);
        report.modules = await page.evaluate(() => window.__court.modules);
        const waiting = scenario.needs.filter((m) => report.modules[m] !== true);
        if (waiting.length && !args.includes("--force")) throw new Skip(`waiting on ${waiting.join(", ")} (BUILT false; owner ${scenario.owner})`);
        await page.click("#court-enter");
        const ctx = makeContext(page, check, report, bundleJson);
        // everything that waits on frames runs under one timeout: a page that stops presenting fails, never hangs
        let timer;
        await Promise.race([
          (async () => {
            await scenario.run(ctx);
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
        if (e instanceof Skip) skip = e.message;
        else {
          check("runs", false, String(e?.message ?? e).split("\n")[0]);
          consoleLog.slice(-30).forEach((l) => console.error(`  ${l}`));
        }
      }
      if (skip !== null && checks.length === 0) {
        console.log(`SKIP ${name}: ${skip}`);
        skipped.push(name);
        report.skipped = skip;
      } else {
        if (skip !== null) console.log(`SKIP ${name} (the rest): ${skip}`);
        check("console clean (P25)", errors.length === 0, errors.length ? `${errors.length} errors: ${errors.slice(0, 3).join(" | ")}` : `0 errors, ${warnings.length} warnings`);
      }
      Object.assign(report, { url, checks, errors, warnings, saved, ...(args.includes("--keep") ? { console: consoleLog } : {}) });
      writeFileSync(join(OUT, `${name}${TIMING ? "-timing" : ""}.json`), JSON.stringify(report, null, 2));
      failed += checks.filter((c) => !c.ok).length;
      await page.close();
    }
  } finally {
    await browser?.close();
    server.kill();
  }
  const skips = skipped.length ? `; skipped: ${skipped.join(", ")}` : "";
  if (failed) console.log(`E2E FAIL (${failed} checks failed${skips}; reports in ${OUT})`);
  else if (skipped.length === only.length) console.log(`E2E NOTHING CHECKED (every scenario skipped${skips})`);
  else console.log(`E2E OK (reports in ${OUT}${skips})`);
  process.exit(failed ? 1 : skipped.length === only.length ? 3 : 0);
}

main().catch((e) => {
  console.error("E2E RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
