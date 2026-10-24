// Tests for qa/lib.mjs: the status model, the table and the exit rule of qa/run.mjs. Pure node, no browser.
//   node --test apps/webxr/scripts/court/qa/lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
  assert.deepEqual(r[0], { scenario: "smoke", ok: true, what: "opaque (P33)", detail: "alpha min 255 over 326 of 326 frames read back", tags: ["P33"] });
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
  const leaked = good.map((r) => (r.id === "P5" ? { ...r, requirement: "seen in /Users/me/court-side-data/x frame 1602" } : r));
  assert.match(validateChecklist({ rows: leaked }).join("\n"), /P5.*private/);
  const badKind = good.map((r) => (r.id === "P7" ? { ...r, checks: [{ kind: "wat" }] } : r));
  assert.match(validateChecklist({ rows: badKind }).join("\n"), /P7.*kind/);
  assert.ok(mkdirSync); // keep the import used
});
