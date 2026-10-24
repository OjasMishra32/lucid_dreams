// Court Side QA: runs every automatable P-row (P1-P44 of the plan's section 0) against the current checkout and prints
//   P-row | status | measured | threshold
// status is PASS, FAIL, NOT-YET (the implementation or its check doesn't exist yet) or MANUAL (headset only: HEADSET.md).
// Exit code 1 on any FAIL. Results are written to ~/court-side-data/qa/<time>/ (private, outside every checkout).
//
//   node apps/webxr/scripts/court/qa/run.mjs [--only P1,P6] [--skip-unit] [--skip-e2e] [--no-fallbacks]
//        [--bundle <folder with court.json, outside the repo>] [--out <dir outside every checkout>] [--json] [--list]
//
// --bundle takes a FOLDER (what e2e.mjs and serve.mjs take), never a URL; the default is the stand-in
// (scripts/court/out/standin). A URL is refused with exit 2.
//
// How rows find their results: unit tests and e2e checks name their rows by tagging P<number> in the test or check
// name ("opaque (P33)"); a row with no tagged result is NOT-YET, never a silent PASS. Scenarios are the files in
// scripts/court/scenarios/ (each declares `needs`: court.ts modules that must be BUILT); they run through e2e.mjs
// (`--only <names>`, `--bundle`, `--query` for a fallback flag). checklist.json has each row's checks and the fallback flags.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { children } from "./harness.mjs";
import { QA_SCENARIOS, runFallback, STANDIN } from "./scenarios.mjs";
import {
  assignE2eRun, runWithFlakeRetry, checkoutRoots, discoverScenarios, exitCode, overlapsReal, parseBundleArg, parseTap, realpathLoose, latestPath, renderTable, resolveRow, scanBuilt, suiteStatus, summarize, validateChecklist, writeFresh,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COURT = resolve(HERE, "..");
const WEBXR = resolve(HERE, "../../..");
const REPO = resolve(WEBXR, "../..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const log = (m) => process.stderr.write(`[qa] ${m}\n`);

// nothing this run starts outlives it: an interrupt or a termination kills every child (and its group)
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    children.killAll();
    process.exit(130);
  });

const checklist = JSON.parse(readFileSync(join(HERE, "checklist.json"), "utf8"));
const problems = validateChecklist(checklist);
if (problems.length) {
  console.error(`checklist.json is not valid:\n  ${problems.join("\n  ")}`);
  process.exit(2);
}
const only = opt("--only") ? new Set(opt("--only").split(",").map((s) => s.trim().toUpperCase())) : null;
const rows = checklist.rows.filter((r) => !only || only.has(r.id));
if (flag("--list")) {
  console.log(renderTable(rows.map((r) => ({ id: r.id, status: r.checks.length ? "AUTO" : "MANUAL", measured: r.requirement, threshold: r.owner })), { firstHeader: "P-row" }).replace("status ", "kind   ").replace("measured", "requirement").replace("threshold", "owner"));
  process.exit(0);
}

const git = (...a) => {
  try {
    return execFileSync("git", a, { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "?";
  }
};

// results stay out of every checkout (this one, the main one, every worktree), by real path: a symlinked --out, or the
// same folder typed in other capitals, is refused too
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = resolve(opt("--out", join(homedir(), "court-side-data", "qa", stamp)));
const roots = checkoutRoots(REPO, git);
if (roots.some((c) => overlapsReal(OUT, c))) {
  console.error(`refusing --out ${OUT}: results are private and must not be inside (or contain) a checkout of this repo`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const bundleArg = parseBundleArg(opt("--bundle"));
if (bundleArg.error) {
  console.error(bundleArg.error);
  process.exit(2);
}
const BUNDLE = bundleArg.dir;
const BUNDLE_DIR = BUNDLE ?? STANDIN;
if (!existsSync(join(BUNDLE_DIR, "court.json"))) {
  console.error(BUNDLE ? `no court.json in ${BUNDLE}` : "no stand-in bundle: run  node apps/webxr/scripts/court/standin.mjs  first");
  process.exit(2);
}

/** Run a child in its own process group under a deadline; the whole group is killed on timeout (Chrome and servers too). */
function run(cmd, cmdArgs, { timeoutS = 300 } = {}) {
  return new Promise((ok) => {
    const p = children.add(spawn(cmd, cmdArgs, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], detached: true }), { group: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {
        // gone already
      }
    }, timeoutS * 1000);
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      ok({ code: signal ? null : code, stdout, stderr });
    });
  });
}

const built = { court: true, ...scanBuilt(join(WEBXR, "src/court")) };
const rel = (p) => p.replace(`${REPO}/`, "");

// ---------------- unit suites: every *.test.ts of scripts/court, plus qa's own ----------------
const ctx = { built, unit: {}, e2e: { scenarios: {} }, qa: {}, tools: {} };
const suites = [];
if (!flag("--skip-unit")) {
  const files = [
    ...readdirSync(COURT).filter((n) => n.endsWith(".test.ts")).map((n) => ({ key: n, path: join(COURT, n), args: ["--experimental-transform-types"] })),
    ...readdirSync(HERE).filter((n) => n.endsWith(".test.mjs")).map((n) => ({ key: `qa/${n}`, path: join(HERE, n), args: [] })),
  ];
  for (const f of files) {
    log(`unit ${f.key}`);
    const r = await run(process.execPath, [...f.args, "--test", "--test-reporter=tap", f.path]);
    const results = parseTap(r.stdout).filter((t) => !/\.test\.(ts|mjs)$/.test(t.name));
    ctx.unit[f.key] = { exists: true, results: results.length ? results : null, error: r.code ? r.stderr.trim().split("\n")[0] : undefined };
    const v = suiteStatus(r.code, results);
    suites.push({ id: f.key, status: v.status, measured: v.measured, threshold: "node --test: exit 0, fail 0" });
  }
}
for (const row of rows) for (const c of row.checks) if (c.kind === "unit" && !(c.file in ctx.unit)) ctx.unit[c.file] = { exists: existsSync(join(COURT, c.file)), results: null, error: flag("--skip-unit") ? "skipped (--skip-unit)" : undefined };

// ---------------- e2e: the integrator's e2e.mjs (scenario files in scripts/court/scenarios/) ----------------
const discovered = await discoverScenarios(join(COURT, "scenarios"));
const modulesMissing = (names) => (names ?? []).filter((m) => built[m] !== true);
const e2eRunOut = (suffix) => join(OUT, suffix);

/** Run scenarios through e2e.mjs (one child), optionally with a URL flag; { name: { exists, ran, notYet?, lines } }. */
async function runE2e(names, query = "", suffix = "e2e") {
  if (!names.length) return {};
  let attempt = 0;
  // a scenario that failed only with the page-load timeout (machine load) is run once more
  return runWithFlakeRetry(names, async (some) => {
    const tag = attempt++ ? `${suffix}-retry` : suffix;
    return runE2eOnce(some, query, tag);
  });
}

async function runE2eOnce(names, query, suffix) {
  const argv = [join(COURT, "e2e.mjs"), "--only", names.join(","), "--out", e2eRunOut(suffix), ...(BUNDLE ? ["--bundle", BUNDLE] : []), ...(query ? ["--query", query] : [])];
  const r = await run(process.execPath, argv, { timeoutS: 240 * names.length + 90 });
  writeFresh(join(OUT, `${suffix}.log`), `${r.stdout}\n${r.stderr}`);
  return assignE2eRun(names, r);
}

const scenarios = [];
const wanted = [...new Set(rows.flatMap((r) => r.checks.filter((c) => c.kind === "e2e").map((c) => c.scenario)))];
const runnable = [];
for (const name of wanted) {
  const d = discovered[name];
  const sc = { exists: !!d, ran: false, lines: [] };
  ctx.e2e.scenarios[name] = sc;
  if (!d) continue;
  const missing = modulesMissing(d.needs);
  if (missing.length) sc.notYet = `stub: ${missing.join(", ")}`;
  else if (flag("--skip-e2e")) sc.notYet = "skipped (--skip-e2e)";
  else runnable.push(name);
}
if (runnable.length) {
  log(`e2e ${runnable.join(",")}`);
  Object.assign(ctx.e2e.scenarios, Object.fromEntries(Object.entries(await runE2e(runnable)).map(([n, v]) => [n, { ...ctx.e2e.scenarios[n], ...v }])));
}
for (const [name, sc] of Object.entries(ctx.e2e.scenarios)) {
  const bad = sc.lines.filter((l) => !l.ok && !l.pending);
  scenarios.push({
    id: name,
    status: !sc.exists || !sc.ran ? "NOT-YET" : bad.length ? "FAIL" : "PASS",
    measured: !sc.exists ? "no scenario file in scripts/court/scenarios/ yet" : !sc.ran ? sc.notYet : bad.length ? `${bad.length} of ${sc.lines.length} checks failed: ${bad[0].what}: ${bad[0].detail.slice(0, 50)}` : `${sc.lines.length} checks ok${sc.flake ? " [infra flake (rerun clean)]" : ""}`,
    threshold: `e2e.mjs --only ${name}`,
  });
}

// ---------------- QA-owned scenarios and fallback flags ----------------
const wantQa = new Set(rows.flatMap((r) => r.checks.filter((c) => c.kind === "qa").map((c) => c.scenario)));
const fallbacks = [];
if (wantQa.has("never-public")) {
  log("qa never-public");
  try {
    const r = await QA_SCENARIOS["never-public"]();
    ctx.qa["never-public"] = { ran: true, lines: r.lines };
  } catch (e) {
    ctx.qa["never-public"] = { ran: true, lines: [{ ok: false, what: "runs", detail: String(e?.message ?? e).split("\n")[0].slice(0, 120), tags: [] }] };
  }
  const bad = ctx.qa["never-public"].lines.filter((l) => !l.ok);
  scenarios.push({ id: "qa never-public", status: bad.length ? "FAIL" : "PASS", measured: bad.length ? `${bad.length} failed: ${bad[0].what}: ${bad[0].detail.slice(0, 50)}` : `${ctx.qa["never-public"].lines.length} checks ok`, threshold: "qa/scenarios.mjs" });
}
if (wantQa.has("fallbacks") && !flag("--no-fallbacks")) {
  const coverage = {};
  for (const r of checklist.rows) coverage[r.id] = [...new Set(r.checks.filter((c) => c.kind === "e2e").map((c) => c.scenario))];
  const carried = Object.keys(JSON.parse(readFileSync(join(BUNDLE_DIR, "court.json"), "utf8")).video?.fallbacks ?? {});
  for (const fb of checklist.fallbacks) {
    log(`fallback ?${fb.flag}`);
    const r = await runFallback(fb, {
      root: REPO, built, coverage, scenarios: discovered, standinFallbacks: carried,
      runE2e: (names, query) => runE2e(names, query, `e2e-${fb.id}`),
    });
    fallbacks.push({ id: `?${fb.flag}`, status: r.status, measured: r.measured, threshold: `${fb.rows.join(" ")}${fb.headsetRows?.length ? ` (+ headset ${fb.headsetRows.join(" ")})` : ""}: ${fb.note}`.slice(0, 140) });
  }
  const failing = fallbacks.filter((f) => f.status === "FAIL");
  const pending = fallbacks.filter((f) => f.status === "NOT-YET");
  ctx.qa.fallbacks = failing.length
    ? { ran: true, lines: [{ ok: false, what: "fallback flags (P41)", detail: `failing: ${failing.map((f) => f.id).join(" ")}`, tags: ["P41"] }] }
    : pending.length
      ? { ran: false, notYet: `${fallbacks.length - pending.length}/${fallbacks.length} flags tested; not yet: ${pending.map((f) => f.id).join(" ")}` }
      : { ran: true, lines: [{ ok: true, what: "fallback flags (P41)", detail: `all ${fallbacks.length} flags load and pass their rows`, tags: ["P41"] }] };
} else if (wantQa.has("fallbacks")) ctx.qa.fallbacks = { ran: false, notYet: "skipped (--no-fallbacks)" };

// ---------------- tools in pipeline/court/ (python; run only once checklist.json wires their args) ----------------
for (const c of rows.flatMap((r) => r.checks.filter((x) => x.kind === "tool"))) {
  if (c.tool in ctx.tools) continue;
  const exists = existsSync(join(REPO, c.tool));
  ctx.tools[c.tool] = { exists };
  if (exists && c.args) {
    log(`tool ${c.tool}`);
    const r = await run("python3", ["-I", join(REPO, c.tool), ...c.args]);
    ctx.tools[c.tool] = { exists, ran: true, ok: r.code === 0, detail: (r.stdout.trim().split("\n").pop() || r.stderr.trim().split("\n")[0] || `exit ${r.code}`).slice(0, 120) };
  }
}

// ---------------- the table ----------------
const results = rows.map((r) => resolveRow(r, ctx));
const report = { rows: results, suites, scenarios, fallbacks };
const counts = summarize(results);
const headsetOpen = rows.filter((r) => r.manual && results.find((x) => x.id === r.id)?.status !== "FAIL").length;
const code = exitCode(report);

const out = [];
out.push(`Court Side QA  ${new Date().toISOString()}  ${git("rev-parse", "--abbrev-ref", "HEAD")} ${git("rev-parse", "--short", "HEAD")}  (origin/court-side ${git("rev-parse", "--short", "origin/court-side")})`);
out.push(`bundle: ${BUNDLE ?? `stand-in (${rel(STANDIN)})`}`);
out.push(`modules built: ${Object.entries(built).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
out.push(`modules still stubs: ${Object.entries(built).filter(([k, v]) => !v && k !== "lightfield").map(([k]) => k).join(", ") || "none"}`);
if (suites.length) out.push("", "Unit suites", renderTable(suites, { firstHeader: "suite", thresholdW: 30 }));
if (scenarios.length) out.push("", "Scenarios (scripts/court/scenarios/ via e2e.mjs, and qa/)", renderTable(scenarios, { firstHeader: "scenario", thresholdW: 30 }));
out.push("", "P-rows", renderTable(results));
if (fallbacks.length) out.push("", "Fallback flags (P41: each must load and pass its own rows)", renderTable(fallbacks, { firstHeader: "flag", thresholdW: 70 }));
out.push("", `PASS ${counts.PASS}   FAIL ${counts.FAIL}   NOT-YET ${counts["NOT-YET"]}   MANUAL ${counts.MANUAL}   (of ${results.length} rows; ${headsetOpen} still need a headset step: qa/HEADSET.md)`);
const fails = [...results, ...suites, ...scenarios, ...fallbacks].filter((r) => r.status === "FAIL");
if (fails.length) out.push("FAIL detail:", ...fails.map((f) => `  ${f.id}: ${f.measured}`));
out.push(`exit ${code}   results: ${OUT}`);
const text = out.join("\n");
writeFresh(join(OUT, "results.json"), JSON.stringify({ at: new Date().toISOString(), commit: git("rev-parse", "HEAD"), bundle: BUNDLE ?? "standin", counts, ...report }, null, 2));
writeFresh(join(OUT, "table.txt"), `${text}\n`);
try {
  writeFresh(latestPath(OUT), `${realpathLoose(OUT)}\n`);
} catch {
  // the pointer is a convenience
}
console.log(flag("--json") ? JSON.stringify({ counts, ...report }, null, 2) : text);
process.exit(code);
