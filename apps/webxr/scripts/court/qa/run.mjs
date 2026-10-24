// Court Side QA: runs every automatable P-row (P1-P44 of the plan's section 0) against the current checkout and prints
//   P-row | status | measured | threshold
// status is PASS, FAIL, NOT-YET (the implementation or its check doesn't exist yet) or MANUAL (headset only: HEADSET.md).
// Exit code 1 on any FAIL. Results are written to ~/court-side-data/qa/<time>/ (private, outside git), never the repo.
//
//   node apps/webxr/scripts/court/qa/run.mjs [--only P1,P6] [--skip-unit] [--skip-e2e] [--no-fallbacks]
//        [--bundle <court.json URL from serve.mjs>] [--out <dir outside the repo>] [--json] [--list]
//
// How rows find their results: unit tests and e2e checks name their rows by tagging P<number> in the test or check
// name ("opaque (P33)"); a row with no tagged result is NOT-YET, never a silent PASS. checklist.json has each row's
// checks, the modules a scenario needs (src/court/*.ts `BUILT`), and the fallback flags.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeShared, QA_SCENARIOS, runFallback, STANDIN } from "./scenarios.mjs";
import { exitCode, insideDir, parseE2e, parseTap, renderTable, resolveRow, scanBuilt, summarize, validateChecklist } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COURT = resolve(HERE, "..");
const WEBXR = resolve(HERE, "../../..");
const REPO = resolve(WEBXR, "../..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const log = (m) => process.stderr.write(`[qa] ${m}\n`);

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

// results stay out of every checkout (the court data rules): default ~/court-side-data/qa/<time>
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = resolve(opt("--out", join(homedir(), "court-side-data", "qa", stamp)));
const checkouts = [REPO];
const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
if (common !== "?") checkouts.push(dirname(common));
if (checkouts.some((c) => insideDir(OUT, c))) {
  console.error(`refusing --out ${OUT}: results are private and must not be inside a checkout`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const BUNDLE = opt("--bundle");
if (!BUNDLE && !existsSync(join(STANDIN, "court.json"))) {
  console.error("no stand-in bundle: run  node apps/webxr/scripts/court/standin.mjs  first");
  process.exit(2);
}

function run(cmd, cmdArgs, { timeoutS = 300 } = {}) {
  return new Promise((ok) => {
    const p = spawn(cmd, cmdArgs, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => p.kill(), timeoutS * 1000);
    p.on("close", (code) => {
      clearTimeout(timer);
      ok({ code, stdout, stderr });
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
    { key: "qa/lib.test.mjs", path: join(HERE, "lib.test.mjs"), args: [] },
  ];
  for (const f of files) {
    log(`unit ${f.key}`);
    const r = await run(process.execPath, [...f.args, "--test", "--test-reporter=tap", f.path]);
    const results = parseTap(r.stdout).filter((t) => !/\.test\.(ts|mjs)$/.test(t.name));
    ctx.unit[f.key] = { exists: true, results: results.length ? results : null, error: r.code ? r.stderr.trim().split("\n")[0] : undefined };
    const bad = results.filter((t) => !t.ok && !t.skipped).length;
    const okN = results.filter((t) => t.ok && !t.skipped).length;
    suites.push({ id: f.key, status: bad || (r.code && !results.length) ? "FAIL" : "PASS", measured: `${okN} ok, ${bad} failed`, threshold: "node --test: fail 0" });
  }
}
for (const row of rows) for (const c of row.checks) if (c.kind === "unit" && !(c.file in ctx.unit)) ctx.unit[c.file] = { exists: existsSync(join(COURT, c.file)), results: null, error: flag("--skip-unit") ? "skipped (--skip-unit)" : undefined };

// ---------------- e2e: the integrator's harness, one process for every scenario the rows use ----------------
const scenarios = [];
const e2eSrc = readFileSync(join(COURT, "e2e.mjs"), "utf8");
const known = new Set([...e2eSrc.matchAll(/^ {2}(?:async\s+)?["']?([A-Za-z_][\w-]*)["']?\s*\(ctx\)/gm)].map((m) => m[1]));
const wanted = [...new Set(rows.flatMap((r) => r.checks.filter((c) => c.kind === "e2e").map((c) => c.scenario)))];
const runnable = [];
for (const name of wanted) {
  const sc = { exists: known.has(name), ran: false, lines: [] };
  ctx.e2e.scenarios[name] = sc;
  if (!sc.exists) continue;
  const missing = (checklist.scenarios[name]?.needs ?? []).filter((m) => built[m] !== true);
  if (missing.length) sc.notYet = `stub: ${missing.join(", ")}`;
  else if (flag("--skip-e2e")) sc.notYet = "skipped (--skip-e2e)";
  else runnable.push(name);
}
if (runnable.length) {
  log(`e2e ${runnable.join(",")}`);
  const e2eArgs = [join(COURT, "e2e.mjs"), "--only", runnable.join(","), "--out", join(OUT, "e2e"), ...(BUNDLE ? ["--bundle", BUNDLE] : [])];
  const r = await run(process.execPath, e2eArgs, { timeoutS: 240 * runnable.length + 60 });
  writeFileSync(join(OUT, "e2e.log"), `${r.stdout}\n${r.stderr}`);
  const lines = parseE2e(r.stdout);
  for (const name of runnable) {
    const sc = ctx.e2e.scenarios[name];
    sc.ran = true;
    sc.lines = lines.filter((l) => l.scenario === name);
    if (!sc.lines.length) sc.lines = [{ scenario: name, ok: false, what: "runs", detail: (r.stderr.trim().split("\n")[0] ?? "no output").slice(0, 120), tags: [] }];
  }
}
for (const [name, sc] of Object.entries(ctx.e2e.scenarios)) {
  const bad = sc.lines.filter((l) => !l.ok);
  scenarios.push({
    id: name,
    status: !sc.exists || !sc.ran ? "NOT-YET" : bad.length ? "FAIL" : "PASS",
    measured: !sc.exists ? "no such scenario in e2e.mjs yet" : !sc.ran ? sc.notYet : bad.length ? `${bad.length} of ${sc.lines.length} checks failed: ${bad[0].what}` : `${sc.lines.length} checks ok`,
    threshold: `e2e.mjs --only ${name}`,
  });
}

// ---------------- QA-owned scenarios and fallback flags ----------------
const wantQa = new Set(rows.flatMap((r) => r.checks.filter((c) => c.kind === "qa").map((c) => c.scenario)));
const fallbacks = [];
const shared = {};
try {
  if (wantQa.has("never-public")) {
    log("qa never-public");
    try {
      const r = await QA_SCENARIOS["never-public"]();
      ctx.qa["never-public"] = { ran: true, lines: r.lines };
    } catch (e) {
      ctx.qa["never-public"] = { ran: true, lines: [{ ok: false, what: "runs", detail: String(e?.message ?? e).split("\n")[0].slice(0, 120), tags: [] }] };
    }
    const bad = ctx.qa["never-public"].lines.filter((l) => !l.ok);
    scenarios.push({ id: "qa never-public", status: bad.length ? "FAIL" : "PASS", measured: bad.length ? `${bad.length} failed: ${bad[0].what}` : `${ctx.qa["never-public"].lines.length} checks ok`, threshold: "qa/scenarios.mjs" });
  }
  if (wantQa.has("fallbacks") && !flag("--no-fallbacks")) {
    for (const fb of checklist.fallbacks) {
      log(`fallback ?${fb.flag}`);
      const r = await runFallback(fb, { root: REPO, built, bundle: BUNDLE, shared });
      fallbacks.push({ id: `?${fb.flag}`, status: r.status, measured: r.measured, threshold: `${fb.rows.join(" ")}: ${fb.note}`.slice(0, 120) });
    }
    const failing = fallbacks.filter((f) => f.status === "FAIL");
    const pending = fallbacks.filter((f) => f.status === "NOT-YET");
    ctx.qa.fallbacks = failing.length
      ? { ran: true, lines: [{ ok: false, what: "fallback flags (P41)", detail: `failing: ${failing.map((f) => f.id).join(" ")}`, tags: ["P41"] }] }
      : pending.length
        ? { ran: false, notYet: `${fallbacks.length - pending.length}/${fallbacks.length} flags tested; not yet: ${pending.map((f) => f.id).join(" ")}` }
        : { ran: true, lines: [{ ok: true, what: "fallback flags (P41)", detail: `all ${fallbacks.length} flags load and pass`, tags: ["P41"] }] };
  } else if (wantQa.has("fallbacks")) ctx.qa.fallbacks = { ran: false, notYet: "skipped (--no-fallbacks)" };
} finally {
  await closeShared(shared);
}

// ---------------- tools in pipeline/court/ (python; run only once checklist.json wires their args) ----------------
for (const c of rows.flatMap((r) => r.checks.filter((x) => x.kind === "tool"))) {
  if (c.tool in ctx.tools) continue;
  const exists = existsSync(join(REPO, c.tool));
  ctx.tools[c.tool] = { exists };
  if (exists && c.args) {
    log(`tool ${c.tool}`);
    const r = await run("python3", ["-I", join(REPO, c.tool), ...c.args]);
    ctx.tools[c.tool] = { exists, ran: true, ok: r.code === 0, detail: (r.stdout.trim().split("\n").pop() || r.stderr.trim().split("\n")[0] || "").slice(0, 120) };
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
out.push(`modules still stubs: ${Object.entries(built).filter(([, v]) => !v).map(([k]) => k).join(", ") || "none"}`);
if (suites.length) out.push("", "Unit suites", renderTable(suites, { firstHeader: "suite", thresholdW: 30 }));
if (scenarios.length) out.push("", "Scenarios (e2e.mjs and qa/)", renderTable(scenarios, { firstHeader: "scenario", thresholdW: 30 }));
out.push("", "P-rows", renderTable(results));
if (fallbacks.length) out.push("", "Fallback flags (P41: each must load and pass its own rows)", renderTable(fallbacks, { firstHeader: "flag", thresholdW: 70 }));
out.push("", `PASS ${counts.PASS}   FAIL ${counts.FAIL}   NOT-YET ${counts["NOT-YET"]}   MANUAL ${counts.MANUAL}   (of ${results.length} rows; ${headsetOpen} still need a headset step: qa/HEADSET.md)`);
const fails = [...results, ...suites, ...scenarios, ...fallbacks].filter((r) => r.status === "FAIL");
if (fails.length) out.push("FAIL detail:", ...fails.map((f) => `  ${f.id}: ${f.measured}`));
out.push(`exit ${code}   results: ${OUT}`);
const text = out.join("\n");
writeFileSync(join(OUT, "results.json"), JSON.stringify({ at: new Date().toISOString(), commit: git("rev-parse", "HEAD"), bundle: BUNDLE ?? "standin", counts, ...report }, null, 2));
writeFileSync(join(OUT, "table.txt"), `${text}\n`);
try {
  writeFileSync(join(dirname(OUT), "latest.txt"), `${OUT}\n`);
} catch {
  // the pointer is a convenience
}
console.log(flag("--json") ? JSON.stringify({ counts, ...report }, null, 2) : text);
process.exit(code);
