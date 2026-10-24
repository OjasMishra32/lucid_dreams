// The pure half of qa/run.mjs: the status model, parsing of the test runners' output, the table and the exit rule.
// No I/O besides scanBuilt (reads src/court/*.ts); everything else takes plain objects, so lib.test.mjs needs no browser.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

export const PASS = "PASS";
export const FAIL = "FAIL";
export const NOT_YET = "NOT-YET";
export const MANUAL = "MANUAL";

const TAG = /(?<![A-Za-z0-9])P(\d{1,2})(?![A-Za-z0-9])/g;

/** The P-rows a label names ("opaque (P33)", "P4, P44"): whole P-numbers only. */
export function tagsOf(text) {
  return [...String(text).matchAll(TAG)].map((m) => `P${m[1]}`);
}

/** node --test --test-reporter=tap: every "ok n - name" / "not ok n - name" line at any depth. */
export function parseTap(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^\s*(not )?ok \d+ - (.*)$/);
    if (!m) continue;
    const skipped = /#\s*(SKIP|TODO)\b/i.test(m[2]);
    out.push({ name: m[2].replace(/\s+#\s*(SKIP|TODO).*$/i, "").trim(), ok: !m[1], skipped });
  }
  return out;
}

/** e2e.mjs's "PASS <scenario>: <what>: <detail>" lines. */
export function parseE2e(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^(PASS|FAIL) (\S+): (.+?): (.*)$/);
    if (m) out.push({ scenario: m[2], ok: m[1] === "PASS", what: m[3], detail: m[4], tags: tagsOf(m[3]) });
  }
  return out;
}

/** { module: BUILT } for every `export const BUILT = ...` in a folder of .ts files (module = file name). */
export function scanBuilt(dir) {
  const built = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const m = readFileSync(join(dir, f), "utf8").match(/export const BUILT\s*=\s*(true|false)/);
    if (m) built[basename(f, ".ts")] = m[1] === "true";
  }
  return built;
}

/** FAIL beats NOT-YET beats PASS; nothing to combine is NOT-YET. */
export function combine(statuses) {
  if (!statuses.length) return NOT_YET;
  if (statuses.includes(FAIL)) return FAIL;
  if (statuses.includes(NOT_YET)) return NOT_YET;
  return PASS;
}

const short = (s, n = 120) => (String(s).length > n ? `${String(s).slice(0, n - 3)}...` : String(s));

/** Judge a list of tagged result lines for one row. `lines` are { ok, what, detail, tags }. */
function judgeLines(lines, id, where) {
  const crash = lines.find((l) => !l.ok && l.tags.length === 0);
  if (crash) return { status: FAIL, measured: `${where} failed: ${crash.what}: ${short(crash.detail, 80)}` };
  const mine = lines.filter((l) => l.tags.includes(id));
  if (!mine.length) return { status: NOT_YET, measured: `no check tagged ${id} in ${where}` };
  const bad = mine.filter((l) => !l.ok);
  const detail = (bad.length ? bad : mine).map((l) => l.detail).join("; ");
  return { status: bad.length ? FAIL : PASS, measured: short(detail) };
}

function stubs(check, ctx) {
  return (check.needs ?? []).filter((m) => ctx.built?.[m] !== true);
}

export function resolveCheck(check, row, ctx) {
  const missing = stubs(check, ctx);
  if (missing.length) return { status: NOT_YET, measured: `stub: ${missing.join(", ")}` };
  if (check.kind === "unit") {
    const u = ctx.unit?.[check.file];
    if (!u?.exists) return { status: NOT_YET, measured: `no ${check.file} yet` };
    if (!u.results) return { status: NOT_YET, measured: `not run${u.error ? `: ${short(u.error, 60)}` : ""}` };
    const pool = u.results.filter((t) => !t.skipped);
    const re = check.match ? new RegExp(check.match, "i") : null;
    const mine = pool.filter((t) => (re ? re.test(t.name) : tagsOf(t.name).includes(row.id)));
    if (!mine.length) return { status: NOT_YET, measured: re ? `no test matching /${check.match}/ in ${check.file}` : `no test tagged ${row.id} in ${check.file}` };
    const bad = mine.filter((t) => !t.ok);
    return bad.length
      ? { status: FAIL, measured: `${mine.length - bad.length}/${mine.length} ok; failing: ${short(bad.map((t) => t.name).join(" | "), 100)}` }
      : { status: PASS, measured: `${mine.length}/${mine.length} tests ok (${check.file})` };
  }
  if (check.kind === "e2e" || check.kind === "qa") {
    const sc = check.kind === "e2e" ? ctx.e2e?.scenarios?.[check.scenario] : ctx.qa?.[check.scenario];
    const label = `${check.kind === "e2e" ? "scenario" : "qa scenario"} ${check.scenario}`;
    if (check.kind === "e2e" && !sc?.exists) return { status: NOT_YET, measured: `no e2e scenario "${check.scenario}" yet` };
    if (!sc?.ran) return { status: NOT_YET, measured: sc?.notYet ?? `${label} not run` };
    return judgeLines(sc.lines ?? [], row.id, label);
  }
  if (check.kind === "pending") return { status: NOT_YET, measured: short(check.reason ?? "no check implemented yet", 90) };
  if (check.kind === "tool") {
    const t = ctx.tools?.[check.tool];
    if (!t?.exists) return { status: NOT_YET, measured: `no ${check.tool} yet` };
    if (!check.args) return { status: NOT_YET, measured: `${basename(check.tool)} present; args not wired in checklist.json` };
    if (!t.ran) return { status: NOT_YET, measured: "tool not run" };
    return { status: t.ok ? PASS : FAIL, measured: short(t.detail ?? (t.ok ? "ok" : "failed")) };
  }
  return { status: FAIL, measured: `unknown check kind ${check.kind}` };
}

function manualText(m) {
  const items = m.items ?? [];
  return `${m.q} item${items.length === 1 ? "" : "s"} ${items.join(", ")}`;
}

/** One checklist row against everything gathered: { id, status, measured, threshold }. */
export function resolveRow(row, ctx) {
  const checks = row.checks ?? [];
  if (!checks.length) return { id: row.id, status: MANUAL, measured: row.manual ? manualText(row.manual) : "manual", threshold: row.threshold };
  const results = checks.map((c) => resolveCheck(c, row, ctx));
  const status = combine(results.map((r) => r.status));
  let measured = results.map((r) => r.measured).join(" | ");
  if (row.manual && status === PASS) measured += ` (+ headset ${manualText(row.manual)})`;
  return { id: row.id, status, measured, threshold: row.threshold };
}

export function summarize(rows) {
  const n = { [PASS]: 0, [FAIL]: 0, [NOT_YET]: 0, [MANUAL]: 0 };
  for (const r of rows) n[r.status] = (n[r.status] ?? 0) + 1;
  return n;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/** The P-row | status | measured | threshold table as plain text. */
export function renderTable(rows, { firstHeader = "P-row", measuredW = 62, thresholdW = 46 } = {}) {
  const idW = Math.max(firstHeader.length, ...rows.map((r) => String(r.id).length));
  const stW = 7;
  const cell = (s, w) => clip(String(s ?? ""), w).padEnd(w);
  const line = (a, b, c, d) => `${cell(a, idW)} | ${cell(b, stW)} | ${cell(c, measuredW)} | ${clip(String(d ?? ""), thresholdW)}`.trimEnd();
  const rule = `${"-".repeat(idW)}-+-${"-".repeat(stW)}-+-${"-".repeat(measuredW)}-+-${"-".repeat(Math.min(thresholdW, 20))}`;
  return [line(firstHeader, "status", "measured", "threshold"), rule, ...rows.map((r) => line(r.id, r.status, r.measured, r.threshold))].join("\n");
}

/** Non-zero on any FAIL: a row, a unit suite, a fallback flag or an e2e/qa scenario that broke. NOT-YET and MANUAL never fail. */
export function exitCode(report) {
  const all = [...(report.rows ?? []), ...(report.suites ?? []), ...(report.fallbacks ?? []), ...(report.scenarios ?? [])];
  return all.some((r) => r.status === FAIL) ? 1 : 0;
}

/** child is parent or inside it. */
export function insideDir(child, parent) {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

const KINDS = new Set(["unit", "e2e", "qa", "tool", "pending"]);
const PRIVATE = [
  [/\/Users\//, "a home path"],
  [/court-side-data|\$L\/|\/blue\//, "a private data path"],
  [/\b(frames?|src)\s*#?\d{3,}/i, "a frame index"],
  [/\b[ABCF]\d{3,4}\b/, "a frame label with an index"],
];

/** Problems with checklist.json (empty = fine): every P1-P44 once, required fields, known kinds, nothing private. */
export function validateChecklist(list) {
  const problems = [];
  const seen = new Set();
  for (const row of list.rows ?? []) {
    const id = row.id;
    if (seen.has(id)) problems.push(`${id} appears twice`);
    seen.add(id);
    for (const f of ["group", "requirement", "how", "threshold", "owner"]) if (!row[f] || typeof row[f] !== "string") problems.push(`${id}: missing ${f}`);
    for (const c of row.checks ?? []) if (!KINDS.has(c.kind)) problems.push(`${id}: unknown check kind "${c.kind}"`);
    const text = JSON.stringify(row);
    for (const [re, what] of PRIVATE) if (re.test(text)) problems.push(`${id}: looks like it holds ${what} (private data stays out of git)`);
  }
  for (let i = 1; i <= 44; i++) if (!seen.has(`P${i}`)) problems.push(`missing P${i}`);
  return problems;
}
