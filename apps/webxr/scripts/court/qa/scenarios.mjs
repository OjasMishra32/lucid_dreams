// The QA-owned checks: what the integrator's e2e.mjs does not run, or that need no page.
//   never-public  P36: serve.mjs (plain and --dev) answers only on 127.0.0.1, refuses a foreign Host and any path out of
//                 the bundle folder; vite does not serve the bundle.
//   fallbacks     P41: runFallback drives each URL flag of the plan's risk table through e2e.mjs --query and judges the
//                 flag's own P-rows.
// never-public returns lines { ok, what, detail, tags } like e2e.mjs prints.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { children, freePort, startVite, WEBXR } from "./harness.mjs";
import { judgeFallback, leaksBundle, withDeadline } from "./lib.mjs";

const SERVE = join(WEBXR, "src/court/serve.mjs");
export const STANDIN = join(WEBXR, "scripts/court/out/standin");

/** One HTTP request with full control of Host and path; resolves { status, type, body } (the whole body) or { error }. */
function get(host, port, path, headers = {}, timeout = 5000) {
  return new Promise((ok) => {
    const req = request({ host, port, path, headers, timeout }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode, type: res.headers["content-type"] ?? "", body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (e) => ok({ error: e.code ?? e.message }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => ok({ error: e.code ?? e.message }));
    req.end();
  });
}

/**
 * Raw request paths that climb out of the bundle folder and come back down to `canaryFile`, 1 to 3 levels up. The slashes
 * are percent-encoded (%2f), because a server's URL parser collapses "%2e%2e/" before the handler ever sees it, so those
 * probes test the parser, not the bundle handler; "..%2f" survives the parser and only the handler's own decode and
 * containment check stand in the way. Send them with a raw http.request (get below), which normalises nothing.
 */
export function traversalPaths(bundleDir, canaryFile) {
  const out = [];
  let ancestor = bundleDir;
  for (let n = 1; n <= 3; n++) {
    ancestor = dirname(ancestor);
    const down = relative(ancestor, canaryFile).split("/").join("%2f");
    for (const up of ["..%2f", "%2e%2e%2f", ".%2e%2f"]) out.push(`/bundle/${up.repeat(n)}${down}`);
  }
  return out;
}

/** The probes that got the canary (or a bundle file) back: [`<path> -> <status> <type> <bytes>`]. */
export async function probeLeaks(port, paths, token) {
  const leaked = [];
  for (const p of paths) {
    const r = await get("127.0.0.1", port, p);
    if (leaksBundle(r, { tokens: [token] })) leaked.push(`${p} -> ${r.status} ${(r.type ?? "").split(";")[0]} ${r.body.length} bytes`);
  }
  return leaked;
}

/**
 * Everything the P36 server check writes lives in one temp folder outside every checkout: the dist stub, a one-file
 * bundle (the stand-in's court.json) and the canary one level above the bundle folder.
 */
export function makeSandbox() {
  const tmp = mkdtempSync(join(tmpdir(), "qa-p36-"));
  const dist = join(tmp, "dist");
  const bundle = join(tmp, "bundle");
  mkdirSync(dist);
  mkdirSync(bundle);
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>qa</title>");
  copyFileSync(join(STANDIN, "court.json"), join(bundle, "court.json"));
  return { tmp, dist, bundle, canary: join(tmp, "canary.txt") };
}

async function serveCheck(extra, label) {
  const lines = [];
  const add = (ok, what, detail) => lines.push({ ok, what: `${what} (P36)`, detail: `${label}: ${detail}`, tags: ["P36"] });
  const { tmp, dist, bundle, canary } = makeSandbox();
  const port = await freePort();
  const child = children.add(spawn(process.execPath, [SERVE, "--bundle", bundle, "--dist", dist, "--port", String(port), ...extra], { stdio: ["ignore", "pipe", "pipe"] }));
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  try {
    const until = Date.now() + 60000;
    while (Date.now() < until && child.exitCode === null && !log.includes(`127.0.0.1:${port}`)) await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode !== null || !log.includes(`127.0.0.1:${port}`)) {
      add(false, "serve.mjs starts", `did not start: ${log.trim().split("\n")[0]?.slice(0, 120) ?? "no output"}`);
      return lines;
    }
    const own = await get("127.0.0.1", port, "/bundle/court.json");
    add(own.status === 200 && /json/.test(own.type), "serve.mjs serves the bundle on 127.0.0.1", `GET /bundle/court.json -> ${own.status ?? own.error} ${own.type}`);
    const evil = await get("127.0.0.1", port, "/bundle/court.json", { Host: "evil.example" });
    add(evil.status >= 400 && evil.status < 500, "serve.mjs refuses a foreign Host", `Host evil.example -> ${evil.status ?? evil.error}`);
    // a leak is the canary file's own content (or a bundle file): vite's index.html fallback (200 for any unknown path
    // in --dev) is the app shell, not a leak
    const token = `QA-CANARY-${randomBytes(12).toString("hex")}`;
    writeFileSync(canary, token);
    const paths = traversalPaths(bundle, canary);
    const leaked = await probeLeaks(port, paths, token);
    add(!leaked.length, "serve.mjs does not serve a file outside the bundle folder", leaked.length ? `served: ${leaked[0]}` : `${paths.length} raw climbing paths to a planted canary: none served it`);
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) add(true, "serve.mjs refuses the LAN address", "no LAN interface on this machine (Host check above is the only guard tested)");
    else {
      const r = await get(lan.address, port, "/bundle/court.json", {}, 3000);
      add(r.status === undefined, "serve.mjs refuses the LAN address", `${lan.address} -> ${r.status ?? r.error}`);
    }
  } finally {
    child.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
  return lines;
}

async function viteCheck() {
  const { server, port } = await startVite();
  try {
    const lines = [];
    for (const p of ["/dreams/court-side/court.json", "/dreams/court-side/video/frames.json", "/dreams/court-side/video/show.h264"]) {
      const r = await get("127.0.0.1", port, p);
      const leaked = leaksBundle(r, { strict: true });
      lines.push({ ok: !leaked, what: "vite does not serve the court bundle (P36)", detail: `GET ${p} -> ${r.status ?? r.error} ${(r.type ?? "").split(";")[0]}${r.status === 200 && !leaked ? " (the app shell, not the bundle)" : ""}`, tags: ["P36"] });
    }
    return lines;
  } finally {
    server.kill();
  }
}

async function neverPublic() {
  const lines = await serveCheck([], "serve.mjs");
  if (/"--dev"/.test(readFileSync(SERVE, "utf8"))) lines.push(...(await serveCheck(["--dev"], "serve.mjs --dev")));
  lines.push(...(await viteCheck()));
  return { lines };
}

/** The flag is read somewhere in the code: a file or any .ts of a folder under `detect.in` matches `detect.pattern`. */
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

/**
 * One fallback flag against its own P-rows (fb.rows): { status, measured }. The rows are driven by the e2e scenarios
 * that check them (`coverage`: row -> scenario names, from checklist.json), run once with the flag in the URL
 * (`runE2e(names, query)` -> assignE2eRun's map). PASS only when every row has a passing tagged check; a row no
 * runnable scenario checks (or whose scenario waits on a stub) leaves the flag NOT-YET, never PASS.
 *   deps: { root, built, standinFallbacks (stream names the bundle carries, or null to skip), coverage, scenarios, runE2e }
 */
export async function runFallback(fb, deps) {
  const { root, built, standinFallbacks, coverage, scenarios, runE2e } = deps;
  if (!flagImplemented(root, fb.detect)) return { status: "NOT-YET", measured: `?${fb.flag} is not read by the code yet` };
  const missing = (fb.needs ?? []).filter((m) => built[m] !== true);
  if (missing.length) return { status: "NOT-YET", measured: `stub: ${missing.join(", ")}` };
  if (fb.standinStream && standinFallbacks && !standinFallbacks.includes(fb.standinStream)) return { status: "NOT-YET", measured: `the bundle has no "${fb.standinStream}" stream yet` };
  const wanted = [...new Set(["smoke", ...fb.rows.flatMap((r) => coverage[r] ?? [])])];
  const runnable = wanted.filter((n) => scenarios[n] && (scenarios[n].needs ?? []).every((m) => built[m] === true));
  const runs = await runE2e(runnable, fb.flag);
  // a scenario that can't run yet says why (its stubs), so the flag's row reads "room: stub: world", not "not run"
  for (const n of wanted) if (!runs[n]) runs[n] = { exists: !!scenarios[n], ran: false, notYet: scenarios[n] ? `stub: ${(scenarios[n].needs ?? []).filter((m) => built[m] !== true).join(", ")}` : "no scenario file yet", lines: [] };
  return judgeFallback(fb.rows, runs, coverage);
}

/** A QA scenario under a deadline: a stalled one fails instead of hanging the run. */
export function runQa(name, ms = 300000) {
  const fns = { "never-public": neverPublic };
  return withDeadline(fns[name](), ms, `qa ${name}`);
}

export const QA_SCENARIOS = { "never-public": () => runQa("never-public") };
