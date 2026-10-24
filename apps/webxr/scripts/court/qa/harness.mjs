// A small browser harness for the QA-owned page scenarios (scenarios.mjs). e2e.mjs fixes the page URL and cannot be
// imported (it runs on load), so this repeats its two jobs, vite on a free port and headless system Chrome through an
// already-installed playwright-core (never downloaded), and adds what the QA scenarios need: extra URL flags.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WEBXR = resolve(HERE, "../../..");
export const COURT_SCRIPTS = resolve(HERE, "..");

/** playwright-core from apps/webxr's node_modules, $PLAYWRIGHT_CORE or the npx cache (newest); never downloaded. */
export function findPlaywright() {
  const require = createRequire(join(WEBXR, "package.json"));
  const tries = [];
  if (process.env.PLAYWRIGHT_CORE) tries.push(process.env.PLAYWRIGHT_CORE);
  try {
    tries.push(dirname(require.resolve("playwright-core/package.json")));
  } catch {
    // not a dependency of apps/webxr: the npx cache below
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
      // next
    }
  }
  throw new Error("playwright-core not found: set PLAYWRIGHT_CORE=<dir of playwright-core> (nothing is downloaded)");
}

/** A free TCP port on 127.0.0.1. */
export function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** This checkout's vite on a free port, accepted only once its own output names the port (as e2e.mjs does). */
export async function startVite() {
  let log = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
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

export async function launchBrowser() {
  const { chromium } = findPlaywright();
  return chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--ignore-gpu-blocklist", "--use-angle=metal", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"],
  });
}

/**
 * Open the court page with extra URL flags ("show=small"), press Enter and wait for window.__court. Returns
 * { page, errors, warnings, close } where errors/warnings are what the page's console and network produced.
 */
export async function openCourt(browser, port, { flag = "", bundle = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  const warnings = [];
  page.on("console", (m) => {
    const text = m.text().slice(0, 300);
    if (m.type() === "error" && !text.startsWith("Failed to load resource")) errors.push(text);
    if (m.type() === "warning") warnings.push(text);
  });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  const parts = ["mode=court", "emulate", "probe=capture"];
  if (bundle) parts.push(`bundle=${encodeURIComponent(bundle)}`);
  if (flag) parts.push(flag);
  await page.goto(`http://127.0.0.1:${port}/?${parts.join("&")}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__court && (window.__court.ready || window.__court.error), null, { timeout: 60000, polling: 200 });
  const loadError = await page.evaluate(() => window.__court.error);
  if (loadError) {
    await page.close();
    throw new Error(`the page could not load the bundle: ${loadError}`);
  }
  await page.click("#court-enter");
  return { page, errors, warnings, close: () => page.close() };
}
