// The QA-owned scenarios: checks the integrator's e2e.mjs does not run (it fixes the page URL) or that need no page.
//   never-public  P36: serve.mjs answers only on 127.0.0.1 and refuses a foreign Host; vite does not serve the bundle.
//   fallbacks     P41: every URL flag of the plan's risk table loads and reaches the watch, opaque, with a clean console.
// Each returns lines { ok, what, detail, tags } like e2e.mjs prints, or { notYet } when it can't run yet.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, launchBrowser, openCourt, startVite, WEBXR } from "./harness.mjs";

const SERVE = join(WEBXR, "src/court/serve.mjs");
export const STANDIN = join(WEBXR, "scripts/court/out/standin");

/** One HTTP request with full control of Host and path; resolves { status, type, body } or { error }. */
function get(host, port, path, headers = {}, timeout = 4000) {
  return new Promise((ok) => {
    const req = request({ host, port, path, headers, timeout }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode, type: res.headers["content-type"] ?? "", body: Buffer.concat(chunks).toString("utf8", 0, 4000) }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => ok({ error: e.code ?? e.message }));
    req.end();
  });
}

async function serveCheck(extra, label) {
  const lines = [];
  const add = (ok, what, detail) => lines.push({ ok, what: `${what} (P36)`, detail: `${label}: ${detail}`, tags: ["P36"] });
  const dist = mkdtempSync(join(tmpdir(), "qa-dist-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>qa</title>");
  const port = await freePort();
  const child = spawn(process.execPath, [SERVE, "--bundle", STANDIN, "--standin", "--dist", dist, "--port", String(port), ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  try {
    const until = Date.now() + 40000;
    while (Date.now() < until && child.exitCode === null && !log.includes(`127.0.0.1:${port}`)) await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode !== null || !log.includes(`127.0.0.1:${port}`)) {
      add(false, "serve.mjs starts", `did not start: ${log.trim().split("\n")[0]?.slice(0, 120) ?? "no output"}`);
      return lines;
    }
    const own = await get("127.0.0.1", port, "/bundle/court.json");
    add(own.status === 200 && /json/.test(own.type), "serve.mjs serves the bundle on 127.0.0.1", `GET /bundle/court.json -> ${own.status ?? own.error} ${own.type}`);
    const evil = await get("127.0.0.1", port, "/bundle/court.json", { Host: "evil.example" });
    add(evil.status >= 400 && evil.status < 500, "serve.mjs refuses a foreign Host", `Host evil.example -> ${evil.status ?? evil.error}`);
    const esc = await get("127.0.0.1", port, "/bundle/%2e%2e/%2e%2e/%2e%2e/package.json");
    add(esc.status !== 200, "serve.mjs refuses a path out of the bundle folder", `traversal -> ${esc.status ?? esc.error}`);
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) add(true, "serve.mjs refuses the LAN address", "no LAN interface on this machine (Host check above is the only guard tested)");
    else {
      const r = await get(lan.address, port, "/bundle/court.json", {}, 3000);
      add(r.status === undefined, "serve.mjs refuses the LAN address", `${lan.address} -> ${r.status ?? r.error}`);
    }
  } finally {
    child.kill();
  }
  return lines;
}

async function viteCheck() {
  const { server, port } = await startVite();
  try {
    const paths = ["/dreams/court-side/court.json", "/dreams/court-side/video/frames.json"];
    const lines = [];
    for (const p of paths) {
      const r = await get("127.0.0.1", port, p);
      let leaked = false;
      if (r.status === 200 && /json/.test(r.type)) {
        try {
          const j = JSON.parse(r.body.length < 4000 ? r.body : "null");
          leaked = !!j && (j.version !== undefined || Array.isArray(j));
        } catch {
          leaked = /"video"|"freeze"/.test(r.body);
        }
      }
      lines.push({ ok: !leaked, what: "vite does not serve the court bundle (P36)", detail: `GET ${p} -> ${r.status ?? r.error} ${r.type.split(";")[0]}${r.status === 200 ? " (the app shell, not the bundle)" : ""}`, tags: ["P36"] });
    }
    return lines;
  } finally {
    server.kill();
  }
}

async function neverPublic() {
  const lines = await serveCheck([], "serve.mjs --standin");
  if (/"--dev"/.test(readFileSync(SERVE, "utf8"))) lines.push(...(await serveCheck(["--dev"], "serve.mjs --dev")));
  lines.push(...(await viteCheck()));
  return { lines };
}

/** The flag is read somewhere in the code: every file under `in`, a file or a folder, matches `pattern`. */
export function flagImplemented(root, detect) {
  const files = [];
  for (const rel of detect.in) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) readdirSync(p).filter((n) => n.endsWith(".ts")).forEach((n) => files.push(join(p, n)));
    else files.push(p);
  }
  const re = new RegExp(detect.pattern);
  return files.some((f) => re.test(readFileSync(f, "utf8")));
}

/** One fallback flag: { status, measured } (PASS, FAIL or NOT-YET). `shared` carries one browser and vite across flags. */
export async function runFallback(fb, { root, built, bundle, shared }) {
  if (!flagImplemented(root, fb.detect)) return { status: "NOT-YET", measured: `?${fb.flag} is not read by the code yet` };
  const missing = (fb.needs ?? []).filter((m) => built[m] !== true);
  if (missing.length) return { status: "NOT-YET", measured: `stub: ${missing.join(", ")}` };
  if (fb.standinStream && !bundle) {
    const court = JSON.parse(readFileSync(join(STANDIN, "court.json"), "utf8"));
    if (!court.video?.fallbacks?.[fb.standinStream]) return { status: "NOT-YET", measured: `the stand-in bundle has no "${fb.standinStream}" stream yet` };
  }
  shared.vite ??= await startVite();
  shared.browser ??= await launchBrowser();
  let opened;
  try {
    opened = await openCourt(shared.browser, shared.vite.port, { flag: fb.flag, bundle });
    const { page } = opened;
    await page.evaluate(() => window.__court.nextFrame());
    await page.evaluate(() => window.__court.seatHere());
    const toWatch = await page.evaluate(() => window.__court.until("watching", 72 * 8));
    const last = toWatch[toWatch.length - 1];
    if (last?.phase !== "watching") return { status: "FAIL", measured: `never reached the watch (stuck in ${last?.phase} after ${toWatch.length} frames)` };
    const more = await page.evaluate(() => window.__court.frames(72));
    const all = [...toWatch, ...more].filter((f) => typeof f.alphaMin === "number");
    const alphaMin = all.length ? Math.min(...all.map((f) => f.alphaMin)) : -1;
    const errs = [...opened.errors, ...(await page.evaluate(() => window.__court.errors))];
    const bad = [];
    if (alphaMin !== 255) bad.push(`alpha min ${alphaMin}`);
    if (errs.length) bad.push(`${errs.length} console errors: ${errs[0].slice(0, 60)}`);
    if (opened.warnings.length) bad.push(`${opened.warnings.length} warnings: ${opened.warnings[0].slice(0, 60)}`);
    return bad.length ? { status: "FAIL", measured: bad.join("; ") } : { status: "PASS", measured: `watch after ${toWatch.length} frames, alpha min 255, 0 errors, 0 warnings` };
  } catch (e) {
    return { status: "FAIL", measured: String(e?.message ?? e).split("\n")[0].slice(0, 120) };
  } finally {
    await opened?.close().catch(() => {});
  }
}

export async function closeShared(shared) {
  await shared.browser?.close().catch(() => {});
  shared.vite?.server.kill();
}

export const QA_SCENARIOS = { "never-public": neverPublic };
