// Tests for qa/lib.mjs: the status model, the table and the exit rule of qa/run.mjs. Pure node, no browser.
//   node --test apps/webxr/scripts/court/qa/lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isLoadFlake, runWithFlakeRetry,
  judderCv, judderVerdict,
  combine, exitCode, insideDir, parseE2e, parseTap, renderTable, resolveRow, scanBuilt, summarize, tagsOf, validateChecklist,
} from "./lib.mjs";

const ctx = (over = {}) => ({
  built: { clock: true, video: false, seatmath: false },
  unit: {},
  e2e: { scenarios: {} },
  qa: {},
  tools: {},
  ...over,
});

test("tagsOf finds whole P-numbers only", () => {
  assert.deepEqual(tagsOf("opaque (P33) and P4, P44"), ["P33", "P4", "P44"]);
  assert.deepEqual(tagsOf("P4 is not P40 or XP4 or P4x"), ["P4", "P40"]);
  assert.deepEqual(tagsOf("no tags here"), []);
});

test("parseTap reads nested ok / not ok lines and skips", () => {
  const tap = ["TAP version 13", "# Subtest: a", "    ok 1 - inner one", "    not ok 2 - inner two", "ok 3 - outer", "ok 4 - later # SKIP no chrome"].join("\n");
  const r = parseTap(tap);
  assert.deepEqual(r.map((t) => [t.name, t.ok, !!t.skipped]), [
    ["inner one", true, false], ["inner two", false, false], ["outer", true, false], ["later", true, true],
  ]);
});

test("parseE2e reads the harness's PASS/FAIL lines with their tags", () => {
  const out = ["PASS smoke: opaque (P33): alpha min 255 over 326 of 326 frames read back", "FAIL room: runs: timed out after 240 s", "noise", "E2E FAIL (1 checks failed)"].join("\n");
  const r = parseE2e(out);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { scenario: "smoke", ok: true, what: "opaque (P33)", detail: "alpha min 255 over 326 of 326 frames read back", tags: ["P33"], pending: false });
  assert.equal(r[1].ok, false);
  assert.deepEqual(r[1].tags, []);
});

test("scanBuilt reads each module's BUILT flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-built-"));
  writeFileSync(join(dir, "clock.ts"), "export const BUILT = true;\n");
  writeFileSync(join(dir, "video.ts"), "/** x */\nexport const BUILT = false;\n");
  writeFileSync(join(dir, "format.ts"), "export const nothing = 1;\n");
  assert.deepEqual(scanBuilt(dir), { clock: true, video: false });
});

test("combine: any FAIL fails, else any NOT-YET holds it back, else PASS", () => {
  assert.equal(combine(["PASS", "FAIL", "NOT-YET"]), "FAIL");
  assert.equal(combine(["PASS", "NOT-YET"]), "NOT-YET");
  assert.equal(combine(["PASS", "PASS"]), "PASS");
  assert.equal(combine([]), "NOT-YET");
});

test("a row whose module is a stub is NOT-YET and names the stub", () => {
  const row = { id: "P6", threshold: "t", checks: [{ kind: "unit", file: "clock.test.ts", needs: ["video", "clock"] }] };
  const r = resolveRow(row, ctx());
  assert.equal(r.status, "NOT-YET");
  assert.match(r.measured, /stub: video/);
});

test("unit: a missing file is NOT-YET, a failing test FAILs, tagged passes PASS", () => {
  const row = { id: "P20", threshold: "t", checks: [{ kind: "unit", file: "sound.test.ts" }] };
  assert.equal(resolveRow(row, ctx()).status, "NOT-YET");
  const pass = ctx({ unit: { "sound.test.ts": { exists: true, results: [{ name: "P20 hush", ok: true }, { name: "P20 rush", ok: true }, { name: "P31 other", ok: false }] } } });
  const ok = resolveRow(row, pass);
  assert.equal(ok.status, "PASS");
  assert.match(ok.measured, /2\/2/);
  const bad = ctx({ unit: { "sound.test.ts": { exists: true, results: [{ name: "P20 hush", ok: false }, { name: "P20 rush", ok: true }] } } });
  const f = resolveRow(row, bad);
  assert.equal(f.status, "FAIL");
  assert.match(f.measured, /P20 hush/);
});

test("unit: a file with no test for this row is NOT-YET, and match picks untagged tests", () => {
  const rowTag = { id: "P6", threshold: "t", checks: [{ kind: "unit", file: "clock.test.ts" }] };
  const c = ctx({ unit: { "clock.test.ts": { exists: true, results: [{ name: "the 1 s ease lands on F", ok: true }] } } });
  const r = resolveRow(rowTag, c);
  assert.equal(r.status, "NOT-YET");
  assert.match(r.measured, /no test tagged P6/);
  const rowMatch = { id: "P6", threshold: "t", checks: [{ kind: "unit", file: "clock.test.ts", match: "ease" }] };
  assert.equal(resolveRow(rowMatch, c).status, "PASS");
});

test("e2e: scenario missing, crashed, tagged pass and tagged fail", () => {
  const row = { id: "P33", threshold: "t", checks: [{ kind: "e2e", scenario: "room" }] };
  assert.equal(resolveRow(row, ctx()).status, "NOT-YET");
  const lines = (l) => ctx({ e2e: { scenarios: { room: { exists: true, ran: true, lines: l } } } });
  const pass = resolveRow(row, lines([{ scenario: "room", ok: true, what: "alpha (P33)", detail: "min 255", tags: ["P33"] }]));
  assert.equal(pass.status, "PASS");
  assert.match(pass.measured, /min 255/);
  const fail = resolveRow(row, lines([{ scenario: "room", ok: false, what: "alpha (P33)", detail: "min 12", tags: ["P33"] }]));
  assert.equal(fail.status, "FAIL");
  const crash = resolveRow(row, lines([{ scenario: "room", ok: false, what: "runs", detail: "timed out", tags: [] }]));
  assert.equal(crash.status, "FAIL");
  assert.match(crash.measured, /scenario room failed/);
  const none = resolveRow(row, lines([{ scenario: "room", ok: true, what: "other (P34)", detail: "x", tags: ["P34"] }]));
  assert.equal(none.status, "NOT-YET");
});

test("e2e: the console-clean line fails only its own row, not every row of the scenario", () => {
  const rows = [
    { id: "P33", threshold: "t", checks: [{ kind: "e2e", scenario: "smoke" }] },
    { id: "P25", threshold: "t", checks: [{ kind: "e2e", scenario: "smoke" }] },
  ];
  const c = ctx({
    e2e: {
      scenarios: {
        smoke: {
          exists: true, ran: true,
          lines: [
            { scenario: "smoke", ok: true, what: "opaque (P33)", detail: "255", tags: ["P33"] },
            { scenario: "smoke", ok: false, what: "console clean (P25)", detail: "2 errors", tags: ["P25"] },
          ],
        },
      },
    },
  });
  assert.deepEqual(rows.map((r) => resolveRow(r, c).status), ["PASS", "FAIL"]);
});

test("tool: absent is NOT-YET, present without wired args is NOT-YET, a run decides", () => {
  const row = { id: "P2", threshold: "t", checks: [{ kind: "tool", tool: "pipeline/court/check_align.py", args: null }] };
  assert.equal(resolveRow(row, ctx()).status, "NOT-YET");
  const present = ctx({ tools: { "pipeline/court/check_align.py": { exists: true } } });
  const r = resolveRow(row, present);
  assert.equal(r.status, "NOT-YET");
  assert.match(r.measured, /args not wired/);
  const wired = { ...row, checks: [{ ...row.checks[0], args: ["--x"] }] };
  const ran = ctx({ tools: { "pipeline/court/check_align.py": { exists: true, ran: true, ok: false, detail: "p95 0.2 deg" } } });
  assert.equal(resolveRow(wired, ran).status, "FAIL");
});

test("qa scenarios: not-yet reason is shown, lines resolve like e2e", () => {
  const row = { id: "P36", threshold: "t", checks: [{ kind: "qa", scenario: "never-public" }] };
  const c = ctx({ qa: { "never-public": { ran: true, lines: [{ ok: true, what: "bind (P36)", detail: "refused LAN", tags: ["P36"] }] } } });
  assert.equal(resolveRow(row, c).status, "PASS");
  const ny = ctx({ qa: { "never-public": { ran: false, notYet: "serve.mjs --dev not built" } } });
  const r = resolveRow(row, ny);
  assert.equal(r.status, "NOT-YET");
  assert.match(r.measured, /--dev not built/);
});

test("pending checks hold a row at NOT-YET with their reason", () => {
  const row = { id: "P19", threshold: "t", checks: [{ kind: "pending", reason: "VAD + Whisper on the final mix has no tool yet" }] };
  const r = resolveRow(row, ctx());
  assert.equal(r.status, "NOT-YET");
  assert.match(r.measured, /VAD \+ Whisper/);
});

test("manual-only rows are MANUAL; an automated PASS keeps its headset step visible", () => {
  const manual = { id: "P37", threshold: "t", checks: [], manual: { q: "Q1", items: [36] } };
  const m = resolveRow(manual, ctx());
  assert.equal(m.status, "MANUAL");
  assert.match(m.measured, /Q1 item 36/);
  const mixed = { id: "P25", threshold: "t", checks: [{ kind: "e2e", scenario: "smoke" }], manual: { q: "Q3", items: [38] } };
  const c = ctx({ e2e: { scenarios: { smoke: { exists: true, ran: true, lines: [{ scenario: "smoke", ok: true, what: "console clean (P25)", detail: "0 errors", tags: ["P25"] }] } } } });
  const r = resolveRow(mixed, c);
  assert.equal(r.status, "PASS");
  assert.match(r.measured, /0 errors/);
  assert.match(r.measured, /\+ headset Q3 item 38/);
});

test("renderTable has the four columns, one line per row, and clips long cells", () => {
  const rows = [
    { id: "P1", status: "NOT-YET", measured: "stub: seatmath", threshold: "<= 0.10 m" },
    { id: "P25", status: "PASS", measured: "x".repeat(200), threshold: "0 errors" },
  ];
  const lines = renderTable(rows).split("\n");
  assert.match(lines[0], /^P-row\s+\|\s+status\s+\|\s+measured\s+\|\s+threshold/);
  assert.equal(lines.length, 4); // header, rule, two rows
  assert.ok(lines[3].length < 200);
  assert.match(lines[3], /\.\.\./);
});

test("summarize counts and exitCode is non-zero on any FAIL anywhere, never on NOT-YET or MANUAL", () => {
  const rows = [{ status: "PASS" }, { status: "NOT-YET" }, { status: "NOT-YET" }, { status: "MANUAL" }];
  assert.deepEqual(summarize(rows), { PASS: 1, FAIL: 0, "NOT-YET": 2, MANUAL: 1 });
  assert.equal(exitCode({ rows, suites: [], fallbacks: [] }), 0);
  assert.equal(exitCode({ rows: [...rows, { status: "FAIL" }], suites: [], fallbacks: [] }), 1);
  assert.equal(exitCode({ rows, suites: [{ status: "FAIL" }], fallbacks: [] }), 1);
  assert.equal(exitCode({ rows, suites: [], fallbacks: [{ status: "FAIL" }] }), 1);
  assert.equal(exitCode({ rows, suites: [], fallbacks: [], scenarios: [{ status: "FAIL" }] }), 1);
});

test("insideDir keeps results out of the repo", () => {
  assert.ok(insideDir("/a/b/c", "/a/b"));
  assert.ok(insideDir("/a/b", "/a/b"));
  assert.ok(!insideDir("/a/bc", "/a/b"));
  assert.ok(!insideDir("/x", "/a/b"));
});

test("validateChecklist: every P1-P44 once, with the required fields, no broadcast-derived leftovers", () => {
  const good = Array.from({ length: 44 }, (_, i) => ({
    id: `P${i + 1}`, group: "g", requirement: "r", how: "h", threshold: "t", owner: "C", checks: [],
  }));
  assert.deepEqual(validateChecklist({ rows: good }), []);
  const bad = good.slice(1);
  assert.match(validateChecklist({ rows: bad }).join("\n"), /missing P1/);
  const dup = [...good, good[0]];
  assert.match(validateChecklist({ rows: dup }).join("\n"), /twice/);
  const noOwner = good.map((r) => (r.id === "P3" ? { ...r, owner: "" } : r));
  assert.match(validateChecklist({ rows: noOwner }).join("\n"), /P3.*owner/);
  const leaked = good.map((r) => (r.id === "P5" ? { ...r, requirement: "seen in /Users/me/court-side-data/x frame 4321" } : r));
  assert.match(validateChecklist({ rows: leaked }).join("\n"), /P5.*private/);
  const badKind = good.map((r) => (r.id === "P7" ? { ...r, checks: [{ kind: "wat" }] } : r));
  assert.match(validateChecklist({ rows: badKind }).join("\n"), /P7.*kind/);
  assert.ok(mkdirSync); // keep the import used
});

// ---- round 2: review findings (each test names its finding) ----
import { ChildRegistry, assignE2eRun, checkoutRoots, discoverScenarios as discover, judgeFallback, judgeRowLines, leaksBundle, overlapsReal, parseBundleArg, parseE2eSkips, realpathLoose, suiteStatus, withDeadline } from "./lib.mjs";
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { dirname, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { flagImplemented, runFallback, traversalPaths } from "./scenarios.mjs";

const HERE_DIR = dirname(fileURLToPath(import.meta.url));

test("[1] suiteStatus: a nonzero exit is FAIL even when every parsed test passed", () => {
  const ok = [{ name: "a", ok: true }, { name: "b", ok: true }];
  assert.equal(suiteStatus(0, ok).status, "PASS");
  assert.equal(suiteStatus(1, ok).status, "FAIL");
  assert.equal(suiteStatus(null, ok).status, "FAIL");
  assert.match(suiteStatus(1, ok).measured, /exit 1/);
  assert.equal(suiteStatus(0, []).status, "FAIL");
  assert.equal(suiteStatus(0, [{ name: "a", ok: true }, { name: "b", ok: false }]).status, "FAIL");
});

test("[2] discoverScenarios imports the real scenario files and reads each one's needs", async () => {
  const found = await discover(resolvePath(HERE_DIR, "../scenarios"));
  const onDisk = readdirSync(resolvePath(HERE_DIR, "../scenarios")).filter((n) => n.endsWith(".mjs")).map((n) => n.replace(/\.mjs$/, "")).sort();
  assert.deepEqual(Object.keys(found).sort(), onDisk);
  assert.ok(onDisk.includes("smoke"));
  for (const v of Object.values(found)) assert.ok(Array.isArray(v.needs));
  assert.deepEqual(found.smoke.needs, []);
});

test("[2] scanBuilt: court.ts's `light` is the lightfield file's flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-built2-"));
  writeFileSync(join(dir, "lightfield.ts"), "export const BUILT = true;\n");
  assert.equal(scanBuilt(dir).light, true);
});

test("[3] parseBundleArg: a folder is accepted and resolved, a URL is refused", () => {
  assert.deepEqual(parseBundleArg(undefined), { dir: null });
  assert.equal(parseBundleArg("some/dir").dir, resolvePath("some/dir"));
  assert.match(parseBundleArg("http://127.0.0.1:5185/bundle/court.json").error, /folder.*not a URL/);
  assert.match(parseBundleArg("https://x/y").error, /not a URL/);
});

test("[4] assignE2eRun: a child that died leaves its unfinished scenarios FAILed, whatever PASS lines came first", () => {
  const stdout = ["PASS smoke: opaque (P33): alpha min 255 over 326 of 326 frames read back", "PASS smoke: console clean (P25): 0 errors, 0 warnings", "PASS layers: a (P43): fine"].join("\n");
  const r = assignE2eRun(["smoke", "layers"], { stdout, stderr: "boom", code: null });
  assert.equal(r.layers.lines.at(-1).ok, false);
  assert.match(r.layers.lines.at(-1).detail, /did not finish.*killed/);
  const row = { id: "P43", threshold: "t", checks: [{ kind: "e2e", scenario: "layers" }] };
  assert.equal(resolveRow(row, ctx({ e2e: { scenarios: { layers: { exists: true, ...r.layers } } } })).status, "FAIL");
  const crash = assignE2eRun(["smoke"], { stdout: "", stderr: "E2E RUN FAILED: Error: nope", code: 1 });
  assert.equal(crash.smoke.lines[0].ok, false);
});

test("[4] assignE2eRun: finished scenarios keep their lines, skips are not-yet, exit 1 with no failing check fails", () => {
  const done = ["PASS smoke: x (P33): ok", "FAIL smoke: console clean (P25): 2 errors", "E2E FAIL (1 checks failed)"].join("\n");
  const r = assignE2eRun(["smoke"], { stdout: done, code: 1 });
  assert.equal(r.smoke.ran, true);
  assert.equal(r.smoke.lines.length, 2);
  const skipped = assignE2eRun(["layers"], { stdout: "SKIP layers: waiting on video (BUILT false; owner D)", code: 3 });
  assert.equal(skipped.layers.ran, false);
  assert.match(skipped.layers.notYet, /waiting on video/);
  const odd = assignE2eRun(["smoke"], { stdout: "PASS smoke: console clean (P25): ok\nE2E FAIL (0 checks failed)", code: 1 });
  assert.equal(odd.smoke.lines.at(-1).ok, false, "exit 1 but nothing failed");
  assert.equal(parseE2eSkips("SKIP a: b").length, 1);
});

test("[5] leaksBundle: a large leaked court.json or frames.json is a leak; vite's html shell and a package.json are not", () => {
  const bigCourt = JSON.stringify({ version: 1, court: { x: 1 }, video: { file: "v" }, pad: "x".repeat(50000) });
  assert.equal(leaksBundle({ status: 200, type: "application/json", body: bigCourt }), true);
  assert.equal(leaksBundle({ status: 200, type: "text/html", body: bigCourt }), true, "court keys count whatever the content type");
  const bigFrames = JSON.stringify(Array.from({ length: 5000 }, (_, i) => ({ src: i, interp: false, q: [0, 0, 0, 1], f: 1 })));
  assert.ok(bigFrames.length > 4000);
  assert.equal(leaksBundle({ status: 200, type: "application/json", body: bigFrames }), true);
  const shell = `<!doctype html><html><head></head><body>${"x".repeat(20000)}</body></html>`;
  assert.equal(leaksBundle({ status: 200, type: "text/html; charset=utf-8", body: shell }), false);
  assert.equal(leaksBundle({ status: 200, type: "application/json", body: '{"name":"@lucid/webxr","version":"1.0.0"}' }), false, "version alone is not court.json");
  assert.equal(leaksBundle({ status: 404, type: "text/plain", body: bigCourt }), false);
  assert.equal(leaksBundle({ status: 200, type: "text/plain", body: `x ${"y".repeat(9000)} CANARY-1` }, { tokens: ["CANARY-1"] }), true);
  assert.equal(leaksBundle({ status: 200, type: "application/octet-stream", body: "\u0000\u0000\u0001" }), false);
  assert.equal(leaksBundle({ status: 200, type: "application/octet-stream", body: "\u0000\u0000\u0001" }, { strict: true }), true, "strict: any 200 that is not the shell is something real");
  assert.equal(leaksBundle({ status: 200, type: "text/html", body: shell }, { strict: true }), false);
});

test("[5] traversalPaths climb out of the bundle folder and land on the canary", () => {
  const bundle = "/r/apps/webxr/scripts/court/out/standin";
  const canary = "/r/apps/webxr/scripts/court/out/qa-canary-1.txt";
  const paths = traversalPaths(bundle, canary);
  assert.equal(paths.length, 9);
  for (const p of paths) {
    const decoded = decodeURIComponent(p).slice("/bundle".length);
    assert.equal(resolvePath(bundle, `.${decoded}`), canary);
  }
});

function fb(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "qa-fb-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "court.ts"), 'if (params.get("hz") === "90") {}\nif (params.get("def") === "body") {}\n');
  return { root: dir, fb: { id: "x", flag: "hz=90", rows: ["P4", "P6", "P25"], needs: [], detect: { in: ["src/court.ts"], pattern: '"hz"\\)\\s*===\\s*"90"' }, ...over } };
}
const SCEN = { smoke: { needs: [] }, cadence: { needs: [] }, ease: { needs: [] } };
const line = (scenario, what, detail, ok = true) => ({ scenario, ok, what, detail, tags: [what.match(/P\d+/)?.[0]].filter(Boolean), pending: false });

test("[6] runFallback drives the flag's own rows: hz=90 with only smoke's P25 is NOT-YET, never PASS", async () => {
  const { root, fb: f } = fb();
  const asked = [];
  const r = await runFallback(f, {
    root, built: {}, coverage: { P4: ["cadence"], P6: ["ease"], P25: ["smoke"] }, scenarios: SCEN, standinFallbacks: null,
    runE2e: async (names, query) => {
      asked.push({ names, query });
      return { smoke: { exists: true, ran: true, lines: [line("smoke", "console clean (P25)", "0 errors")] }, cadence: { exists: true, ran: false, notYet: "x", lines: [] }, ease: { exists: true, ran: false, notYet: "x", lines: [] } };
    },
  });
  assert.equal(r.status, "NOT-YET");
  assert.match(r.measured, /P4 not yet/);
  assert.match(r.measured, /P6 not yet/);
  assert.equal(asked[0].query, "hz=90");
  assert.deepEqual(asked[0].names.sort(), ["cadence", "ease", "smoke"]);
});

test("[6] runFallback: every row checked and passing is PASS; one failing row is FAIL; def=body's P11 has no e2e check, so NOT-YET", async () => {
  const { root, fb: f } = fb();
  const all = async () => ({
    smoke: { exists: true, ran: true, lines: [line("smoke", "console clean (P25)", "0 errors")] },
    cadence: { exists: true, ran: true, lines: [line("cadence", "no held frames (P4)", "0 held")] },
    ease: { exists: true, ran: true, lines: [line("ease", "lands on F (P6)", "0 frames off"), line("ease", "console clean (P25)", "ok")] },
  });
  const deps = { root, built: {}, coverage: { P4: ["cadence"], P6: ["ease"], P25: ["smoke"] }, scenarios: SCEN, standinFallbacks: null, runE2e: all };
  assert.equal((await runFallback(f, deps)).status, "PASS");
  const failing = async () => ({ ...(await all()), cadence: { exists: true, ran: true, lines: [line("cadence", "no held frames (P4)", "3 held", false)] } });
  assert.equal((await runFallback(f, { ...deps, runE2e: failing })).status, "FAIL");
  const body = fb({ flag: "def=body", rows: ["P11", "P25"], detect: { in: ["src/court.ts"], pattern: '"def"\\)\\s*===\\s*"body"' } });
  const r = await runFallback(body.fb, { root: body.root, built: {}, coverage: { P25: ["smoke"] }, scenarios: SCEN, standinFallbacks: null, runE2e: async () => ({ smoke: { exists: true, ran: true, lines: [line("smoke", "console clean (P25)", "0 errors")] } }) });
  assert.equal(r.status, "NOT-YET");
  assert.match(r.measured, /P11 not yet/);
});

test("[6] runFallback: a flag the code doesn't read, a stub module and a missing stand-in stream are NOT-YET without running e2e", async () => {
  const { root, fb: f } = fb();
  const never = async () => assert.fail("e2e must not run");
  const base = { root, built: {}, coverage: {}, scenarios: SCEN, standinFallbacks: [], runE2e: never };
  assert.match((await runFallback({ ...f, detect: { in: ["src/court.ts"], pattern: "nothing-like-this" } }, base)).measured, /not read by the code/);
  assert.match((await runFallback({ ...f, needs: ["video"] }, base)).measured, /stub: video/);
  assert.match((await runFallback({ ...f, standinStream: "hz90" }, { ...base, built: { video: true } })).measured, /no "hz90" stream/);
  assert.equal(flagImplemented(root, f.detect), true);
});

test("[7] overlapsReal: a symlinked --out into a checkout is refused; a sibling and a non-existent child are judged by real path", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "qa-real-")));
  const repo = join(base, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  mkdirSync(join(base, "elsewhere"));
  symlinkSync(join(repo, "sub"), join(base, "link"));
  assert.equal(overlapsReal(join(base, "link"), repo), true);
  assert.equal(overlapsReal(join(base, "link", "not-made-yet", "x"), repo), true);
  assert.equal(overlapsReal(join(base, "elsewhere", "out"), repo), false);
  assert.equal(overlapsReal(base, repo), true, "a folder that contains the checkout is refused too");
  assert.equal(realpathLoose(join(base, "link", "a", "b")), join(repo, "sub", "a", "b"));
});

test("[7] overlapsReal: the same folder in other capitals on a case-insensitive disk is the same folder", { skip: process.platform !== "darwin" }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "qa-case-")));
  mkdirSync(join(base, "RepoDir"));
  assert.equal(overlapsReal(join(base, "repodir", "out"), join(base, "RepoDir")), true);
});

test("[7] checkoutRoots includes every worktree git lists", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "qa-wt-")));
  mkdirSync(join(base, "main", ".git"), { recursive: true });
  mkdirSync(join(base, "wt1"));
  mkdirSync(join(base, "wt2"));
  const git = (...a) => (a[0] === "rev-parse" ? join(base, "main", ".git") : `worktree ${join(base, "main")}\n\nworktree ${join(base, "wt1")}\n\nworktree ${join(base, "wt2")}\nHEAD abc\n`);
  const roots = checkoutRoots(join(base, "wt1"), git);
  for (const d of ["main", "wt1", "wt2"]) assert.ok(roots.includes(join(base, d)), d);
});

test("[8] withDeadline rejects a stalled promise and clears its timer", async () => {
  const never = new Promise(() => {});
  await assert.rejects(withDeadline(never, 30, "scenario x"), /scenario x timed out/);
  assert.equal(await withDeadline(Promise.resolve(7), 1000, "fast"), 7);
});

test("[8] ChildRegistry.killAll kills a child and its process group", async () => {
  const reg = new ChildRegistry();
  const child = reg.add(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true }), { group: true });
  assert.equal(reg.children.size, 1);
  const exited = new Promise((ok) => child.once("exit", (code, sig) => ok(sig)));
  reg.killAll();
  assert.equal(await exited, "SIGKILL");
  assert.equal(reg.children.size, 0);
});

test("[9] a capture with no frames, or frames not all measured, never passes", () => {
  const mk = (detail) => [{ scenario: "smoke", ok: true, what: "opaque (P33)", detail, tags: ["P33"], pending: false }];
  assert.equal(judgeRowLines(mk("alpha min 255 over 326 of 326 frames read back"), "P33").status, "PASS");
  assert.equal(judgeRowLines(mk("alpha min 255 over 300 of 326 frames read back"), "P33").status, "FAIL");
  assert.equal(judgeRowLines(mk("alpha min Infinity over 0 of 0 frames read back"), "P33").status, "FAIL");
  assert.equal(judgeFallback(["P33"], {}, { P33: ["room"] }).status, "NOT-YET", "nothing ran, so nothing passed");
  assert.equal(judgeFallback(["P33"], { smoke: { ran: true, lines: mk("alpha min 255 over 10 of 12 frames read back") } }, { P33: ["smoke"] }).status, "FAIL");
});

test("[6] a row is judged only on its own scenarios: smoke's watch-phase P33 does not stand in for the room check", () => {
  const smokeOnly = { smoke: { ran: true, lines: [{ scenario: "smoke", ok: true, what: "opaque (P33)", detail: "alpha min 255 over 10 of 10 frames read back", tags: ["P33"], pending: false }] }, room: { ran: false, notYet: "stub: world", lines: [] } };
  const v = judgeFallback(["P33"], smokeOnly, { P33: ["room"] });
  assert.equal(v.status, "NOT-YET");
  assert.match(v.measured, /stub: world/);
  assert.equal(judgeFallback(["P33"], smokeOnly, { P33: ["smoke"] }).status, "PASS");
  assert.equal(judgeFallback(["P11"], smokeOnly, {}).status, "NOT-YET");
});

// ---- round 3 ----
import { createServer } from "node:http";
import { readFileSync as readFile, existsSync as exists, lstatSync, writeFileSync as writeFile } from "node:fs";
import { latestPath, writeFresh } from "./lib.mjs";
import { makeSandbox, probeLeaks } from "./scenarios.mjs";

test("[r3-1] a check name with colons keeps its P tags (tags come from the whole line)", () => {
  const l = parseE2e("PASS room: arrival: opaque again (P33): alpha min 255")[0];
  assert.deepEqual(l.tags, ["P33"]);
  assert.equal(l.scenario, "room");
  assert.deepEqual(parseE2e("PASS room: watching: out in 0.6 s (P34): 43 frames")[0].tags, ["P34"]);
});

test("[r3-2] only the harness's own 'not written yet' marker is pending; a real exception is not", () => {
  assert.equal(parseE2e("FAIL smoke: runs: TypeError: method not implemented")[0].pending, false);
  assert.equal(parseE2e("FAIL smoke: runs: feature is not built yet (stream D)")[0].pending, false);
  assert.equal(parseE2e("FAIL room: the edge opens the room (P35): not written yet (stream E): walk the head")[0].pending, true);
  const row = { id: "P25", threshold: "t", checks: [{ kind: "e2e", scenario: "smoke" }] };
  const lines = parseE2e("FAIL smoke: runs: method not implemented\nFAIL smoke: console clean (P25): 1 errors");
  assert.equal(resolveRow(row, ctx({ e2e: { scenarios: { smoke: { exists: true, ran: true, lines } } } })).status, "FAIL");
});

test("[r3-3] any exit but 0, 1 or 3, a missing summary, or exit 1 with only a placeholder FAIL and no summary, fails the run", () => {
  const body = "PASS smoke: x (P33): ok\nPASS smoke: console clean (P25): 0 errors, 0 warnings";
  const clean = `${body}\nE2E OK (reports in x)`;
  assert.equal(assignE2eRun(["smoke"], { stdout: clean, code: 0 }).smoke.lines.every((l) => l.ok), true);
  for (const code of [null, 2, 137]) assert.equal(assignE2eRun(["smoke"], { stdout: clean, code }).smoke.lines.some((l) => !l.ok), true, `exit ${code}`);
  assert.equal(assignE2eRun(["smoke"], { stdout: body, code: 0 }).smoke.lines.some((l) => !l.ok), true, "no summary line");
  const placeholder = "FAIL room: the edge (P35): not written yet (stream E): x\nPASS room: console clean (P25): ok";
  assert.equal(assignE2eRun(["room"], { stdout: `${placeholder}\nE2E FAIL (1 checks failed; reports in x)`, code: 1 }).room.lines.some((l) => !l.ok && !l.pending), false, "a placeholder alone is a clean exit 1");
  assert.equal(assignE2eRun(["room"], { stdout: placeholder, stderr: "E2E RUN FAILED: Error: x", code: 1 }).room.lines.some((l) => !l.ok && !l.pending), true, "a crash after a placeholder");
});

test("[r3-4] a FAIL tagged with a row fails that row whichever scenario printed it", () => {
  const runs = {
    smoke: { ran: true, lines: [{ scenario: "smoke", ok: true, what: "console clean (P25)", detail: "0 errors", tags: ["P25"], pending: false }] },
    room: { ran: true, lines: [{ scenario: "room", ok: false, what: "console clean (P25)", detail: "3 errors", tags: ["P25"], pending: false }] },
  };
  const v = judgeFallback(["P25"], runs, { P25: ["smoke"] });
  assert.equal(v.status, "FAIL");
  assert.match(v.measured, /room: 3 errors/);
});

test("[r3-5] killAll reaches a group's descendants after its leader has exited", async () => {
  const reg = new ChildRegistry();
  const leader = reg.add(spawn("sh", ["-c", "sleep 60 & echo $!"], { stdio: ["ignore", "pipe", "ignore"], detached: true }), { group: true });
  let out = "";
  leader.stdout.on("data", (d) => (out += d));
  await new Promise((ok) => leader.once("exit", ok));
  const grandchild = Number(out.trim());
  assert.ok(grandchild > 0);
  process.kill(grandchild, 0); // still alive after the leader exited
  reg.killAll();
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(grandchild, 0), /ESRCH/);
});

test("[r3-6] writeFresh replaces a symlink instead of writing through it", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-wf-"));
  const victim = join(dir, "victim.txt");
  writeFile(victim, "keep");
  symlinkSync(victim, join(dir, "results.json"));
  writeFresh(join(dir, "results.json"), "new");
  assert.equal(readFile(victim, "utf8"), "keep");
  assert.equal(readFile(join(dir, "results.json"), "utf8"), "new");
  assert.equal(lstatSync(join(dir, "results.json")).isSymbolicLink(), false);
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
});

test("[r3-7] latestPath is beside the run folder's real location, not its symlinked spelling", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "qa-lp-")));
  mkdirSync(join(base, "real", "runs"), { recursive: true });
  mkdirSync(join(base, "other"));
  symlinkSync(join(base, "real", "runs"), join(base, "other", "link"));
  assert.equal(latestPath(join(base, "other", "link", "t1")), join(base, "real", "runs", "latest.txt"));
});

/** A bundle handler shaped like serve.mjs's: the URL parser first, then decode, then read under the bundle folder. */
function handler(bundleDir, { contain }) {
  return createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!path.startsWith("/bundle/")) return res.writeHead(404).end();
    const file = resolvePath(bundleDir, `.${path.slice("/bundle".length)}`);
    if (contain && !(file === bundleDir || file.startsWith(`${bundleDir}/`))) return res.writeHead(404).end();
    try {
      res.writeHead(200, { "content-type": "text/plain" }).end(readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
}
const listen = (s) => new Promise((ok) => s.listen(0, "127.0.0.1", () => ok(s.address().port)));

test("[r3-8] the P36 probes reach a handler's own containment: a handler without it is caught, one with it is not, and %2e%2e/ is normalised away", async () => {
  const sb = makeSandbox();
  const token = "QA-CANARY-test";
  writeFile(sb.canary, token);
  const bundle = realpathSync(sb.bundle);
  const paths = traversalPaths(bundle, join(realpathSync(sb.tmp), "canary.txt"));
  const broken = handler(bundle, { contain: false });
  const good = handler(bundle, { contain: true });
  const [pb, pg] = [await listen(broken), await listen(good)];
  try {
    assert.ok((await probeLeaks(pb, paths, token)).length > 0, "a handler with no containment check serves the canary");
    assert.deepEqual(await probeLeaks(pg, paths, token), []);
    const old = ["/bundle/%2e%2e/canary.txt", "/bundle/%2e%2e/%2e%2e/canary.txt"];
    assert.deepEqual(await probeLeaks(pb, old, token), [], "the URL parser collapses these before the handler: they prove nothing");
  } finally {
    broken.close();
    good.close();
    rmSync(sb.tmp, { recursive: true, force: true });
  }
});

test("[r3-9] the P36 sandbox (bundle and canary) is in the temp folder, not in any checkout", () => {
  const sb = makeSandbox();
  try {
    const roots = checkoutRoots(resolvePath(HERE_DIR, "../../../../.."), (...a) => {
      try {
        return execFileSync("git", a, { cwd: HERE_DIR, encoding: "utf8" }).trim();
      } catch {
        return "?";
      }
    });
    for (const p of [sb.bundle, sb.canary, sb.dist]) for (const r of roots) assert.equal(overlapsReal(p, r), false, `${p} overlaps ${r}`);
    assert.ok(exists(join(sb.bundle, "court.json")));
    assert.equal(dirname(sb.canary), sb.tmp, "the canary sits one level above the bundle folder");
  } finally {
    rmSync(sb.tmp, { recursive: true, force: true });
  }
});

test("[P4] judder is the detrended CV: a slow speed change with even cadence passes, a doubled or held frame pattern fails", () => {
  // 1.0x easing down to 0.6x over 300 display frames: the action slows, the cadence is perfect
  const slowing = Array.from({ length: 300 }, (_, i) => 1 - 0.4 * (i / 299));
  const ok = judderCv(slowing);
  assert.ok(ok.raw > 0.05, "the raw CV sees the speed change");
  assert.ok(ok.detrended < 0.02, `detrended ${ok.detrended}`);
  assert.equal(judderVerdict(slowing).status, "PASS");
  // a frame shown twice, then the next one advancing double, every 10th frame
  const doubled = slowing.map((m, i) => (i % 10 === 5 ? 2 * m : m));
  assert.ok(judderCv(doubled).detrended > 0.15);
  assert.equal(judderVerdict(doubled).status, "FAIL");
  // held frames (no motion) every 10th frame
  const held = slowing.map((m, i) => (i % 10 === 5 ? 0 : m));
  assert.equal(judderVerdict(held).status, "FAIL");
  assert.match(judderVerdict(slowing).measured, /raw CV .* \(info only\)/);
  assert.equal(judderVerdict([]).status, "FAIL", "no motion measured is not a pass");
});

test("[r4-tags] only parenthesised (Pnn) groups tag a line: a bare P33 in a detail never satisfies P33", () => {
  const vacuous = parseE2e("PASS smoke: view logged: 1280x720, P33 not measured")[0];
  assert.deepEqual(vacuous.tags, []);
  const row = { id: "P33", threshold: "t", checks: [{ kind: "e2e", scenario: "smoke" }] };
  const c = ctx({ e2e: { scenarios: { smoke: { exists: true, ran: true, lines: [vacuous] } } } });
  assert.equal(resolveRow(row, c).status, "NOT-YET");
  assert.deepEqual(parseE2e("PASS room: opaque (P33): alpha 255, P33 held over 10 of 10 frames")[0].tags, ["P33"]);
  assert.deepEqual(parseE2e("PASS cadence: no held frames (P4, P44): 0")[0].tags, ["P4", "P44"]);
  assert.deepEqual(parseE2e("PASS x: see P33 (as P8 says): ok")[0].tags, []);
  assert.deepEqual(parseE2e("PASS x: (see P33): ok")[0].tags, []);
  assert.deepEqual(parseE2e("PASS room: arrival: opaque again (P33): 255")[0].tags, ["P33"]);
});

test("[r5-tags] a Pnn: prefix at the very start of the check name tags the line; mid-line P33 still does not", () => {
  assert.deepEqual(parseE2e("PASS handoff: P8: same pixels per eye at the seat: 0.04 deg")[0].tags, ["P8"]);
  assert.deepEqual(parseE2e("FAIL room: P35: the edge opens the room: not written yet (stream E)")[0].tags, ["P35"]);
  assert.equal(parseE2e("FAIL room: P35: the edge opens the room: not written yet (stream E)")[0].pending, true);
  assert.deepEqual(parseE2e("PASS room: watching: P35: edge: ok")[0].tags, [], "a phase prefix is not the start of the name");
  assert.deepEqual(parseE2e("PASS smoke: view logged: 1280x720, P33 not measured")[0].tags, []);
  assert.deepEqual(parseE2e("PASS smoke: opaque (P33): 255, P33 not measured")[0].tags, ["P33"]);
  assert.deepEqual(parseE2e("PASS cadence: P4, P5: ok")[0].tags, ["P4", "P5"]);
});

const timeoutLines = (extra = []) => [
  { scenario: "smoke", ok: false, what: "runs", detail: "page.waitForFunction: Timeout 60000ms exceeded.", tags: [], pending: false },
  { scenario: "smoke", ok: false, what: "console clean (P25)", detail: "2 errors: HTTP 504 ...", tags: ["P25"], pending: false },
  ...extra,
];
const cleanLines = [
  { scenario: "smoke", ok: true, what: "opaque (P33)", detail: "alpha min 255 over 326 of 326 frames read back", tags: ["P33"], pending: false },
  { scenario: "smoke", ok: true, what: "console clean (P25)", detail: "0 errors, 0 warnings", tags: ["P25"], pending: false },
];

test("[r5-flake] isLoadFlake: only the page-load timeout (plus the console errors it causes) is a flake", () => {
  assert.equal(isLoadFlake(timeoutLines()), true);
  assert.equal(isLoadFlake(timeoutLines().slice(0, 1)), true);
  assert.equal(isLoadFlake([...timeoutLines(), { scenario: "smoke", ok: false, what: "opaque (P33)", detail: "alpha min 12", tags: ["P33"], pending: false }]), false);
  assert.equal(isLoadFlake([{ scenario: "smoke", ok: false, what: "runs", detail: "the page could not load the bundle: Failed to fetch", tags: [], pending: false }]), false);
  assert.equal(isLoadFlake(cleanLines), false);
});

test("[r5-flake] a load timeout is rerun once: clean is the row's real status plus the flake note, a second timeout is FAIL", async () => {
  const ran = (lines) => ({ exists: true, ran: true, lines });
  const calls = [];
  const clean = await runWithFlakeRetry(["smoke"], async (names) => {
    calls.push(names);
    return { smoke: ran(calls.length === 1 ? timeoutLines() : cleanLines) };
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ["smoke"], "only the flaked scenario is rerun");
  assert.equal(clean.smoke.flake, true);
  const row = { id: "P25", threshold: "t", checks: [{ kind: "e2e", scenario: "smoke" }] };
  const r = resolveRow(row, ctx({ e2e: { scenarios: { smoke: clean.smoke } } }));
  assert.equal(r.status, "PASS");
  assert.match(r.measured, /infra flake \(rerun clean\)/);
  const again = await runWithFlakeRetry(["smoke"], async () => ({ smoke: ran(timeoutLines()) }));
  assert.equal(again.smoke.flake, false);
  assert.equal(resolveRow(row, ctx({ e2e: { scenarios: { smoke: again.smoke } } })).status, "FAIL");
  // a real failure is never rerun
  let n = 0;
  await runWithFlakeRetry(["smoke"], async () => (n++, { smoke: ran([{ scenario: "smoke", ok: false, what: "opaque (P33)", detail: "alpha min 12", tags: ["P33"], pending: false }]) }));
  assert.equal(n, 1);
  // a fallback judged on a flaked-clean run says so
  const v = judgeFallback(["P25"], { smoke: clean.smoke }, { P25: ["smoke"] });
  assert.equal(v.status, "PASS");
  assert.match(v.measured, /infra flake \(rerun clean\)/);
});
