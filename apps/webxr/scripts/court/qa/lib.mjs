// The pure half of qa/run.mjs: the status model, parsing of the test runners' output, the table and the exit rule.
// No I/O besides scanBuilt (reads src/court/*.ts); everything else takes plain objects, so lib.test.mjs needs no browser.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

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

/** The rows a line names in parenthesised groups only: "(P33)", "(P4, P44)". A bare "P33" in free text ("P33 not measured") names nothing. */
export function tagsInParens(text) {
  const out = [];
  for (const g of String(text).matchAll(/\((P\d{1,2}(?:\s*[,/&]\s*P\d{1,2})*)\)/g)) out.push(...tagsOf(g[1]));
  return out;
}

/** e2e.mjs's "PASS <scenario>: <what>: <detail>" lines. */
export function parseE2e(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^(PASS|FAIL) (\S+): (.+?): (.*)$/);
    // a check's name can hold colons ("arrival: opaque again (P33)"), so name and detail can't be split reliably:
    // the tags come from the parenthesised groups of the whole line (never a bare P33 in a detail); the placeholder
    // marker is the harness's exact ": not written yet"
    if (m) out.push({ scenario: m[2], ok: m[1] === "PASS", what: m[3], detail: m[4], tags: tagsInParens(line.slice(m[1].length + m[2].length + 2)), pending: m[1] === "FAIL" && /: not written yet\b/.test(line) });
  }
  return out;
}

/** e2e.mjs's "SKIP <scenario>: <why>" (the whole scenario) and "SKIP <scenario> (the rest): <why>" lines. */
export function parseE2eSkips(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^SKIP (\S+?)( \(the rest\))?: (.*)$/);
    if (m) out.push({ scenario: m[1], rest: !!m[2], reason: m[3] });
  }
  return out;
}

/**
 * What one e2e.mjs child run says about each scenario it was asked for: { name: { exists, ran, notYet?, lines } }.
 * A scenario e2e skipped is not run (its reason is kept); one that never printed its closing "console clean" line did
 * not finish (a crash, a kill, a timeout) and FAILs, whatever PASS lines it printed before. A child that did not end cleanly (an exit
 * but 0, 1 or 3, "E2E RUN FAILED", no summary line) FAILs every scenario that did not skip; so does exit 1 with no
 * failing line at all.
 */
export function assignE2eRun(names, { stdout = "", stderr = "", code }) {
  const lines = parseE2e(stdout);
  const skips = parseE2eSkips(stdout);
  // e2e.mjs ends with one summary line, then exits 0 (all passed), 1 (a check failed) or 3 (all skipped): anything
  // else (a kill, a crash, exit 2), a missing summary, or exit 1 with no real failing check means the run is not trustworthy
  const completed = /^E2E (OK|FAIL|NOTHING CHECKED)/m.test(stdout) && !/E2E RUN FAILED/.test(`${stdout}\n${stderr}`);
  const badRun = !(code === 0 || code === 1 || code === 3) || !completed;
  const oddExit = code === 1 && !lines.some((l) => !l.ok); // a placeholder FAIL counts: e2e exits 1 for it
  const reason = `child exit ${code ?? "killed"}${stderr.trim() ? `: ${stderr.trim().split("\n")[0].slice(0, 80)}` : ""}`;
  const out = {};
  for (const name of names) {
    const mine = lines.filter((l) => l.scenario === name);
    const skipWhole = skips.find((k) => k.scenario === name && !k.rest);
    if (skipWhole && !mine.length) {
      out[name] = { exists: true, ran: false, notYet: skipWhole.reason, lines: [] };
      continue;
    }
    const finished = mine.some((l) => /^console clean/.test(l.what));
    const extra = !finished || badRun || oddExit ? [{ scenario: name, ok: false, what: "runs", detail: !finished ? `did not finish (${reason})` : badRun ? `the run did not end cleanly (${reason})` : `${reason}, no failing check`, tags: [], pending: false }] : [];
    out[name] = { exists: true, ran: true, lines: [...mine, ...extra] };
  }
  return out;
}

/** The scenario files in scripts/court/scenarios: { name: { owner, needs } }, read by importing each one. */
export async function discoverScenarios(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".mjs")).sort()) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    out[basename(f, ".mjs")] = { owner: mod.owner ?? "?", needs: mod.needs ?? [] };
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
  // court.ts reports the light field as `light`; the scenarios' `needs` use that name
  if ("lightfield" in built) built.light = built.lightfield;
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

/** "over 326 of 326 frames read back": every frame measured, and at least one. */
function measuredAll(detail) {
  const m = String(detail).match(/over (\d+) of (\d+) frames/);
  return !m || (m[1] === m[2] && Number(m[1]) > 0);
}

/** The verdict of the tagged lines for one row: FAIL on a real failed check, NOT-YET on a placeholder, else PASS. */
export function judgeRowLines(lines, id) {
  const mine = lines.filter((l) => l.tags.includes(id));
  if (!mine.length) return { status: NOT_YET, measured: `no check tagged ${id}` };
  const failed = mine.filter((l) => (!l.ok && !l.pending) || (l.ok && !measuredAll(l.detail)));
  if (failed.length) return { status: FAIL, measured: short(failed.map((l) => (l.ok ? `${l.detail} (not every frame measured)` : l.detail)).join("; ")) };
  const pending = mine.filter((l) => l.pending);
  if (pending.length) return { status: NOT_YET, measured: short(pending.map((l) => l.detail).join("; ")) };
  return { status: PASS, measured: short(mine.map((l) => l.detail).join("; ")) };
}

/** Judge a scenario's lines for one row: an unfinished or crashed scenario fails; otherwise the row's tagged lines. */
function judgeLines(lines, id, where) {
  const crash = lines.find((l) => !l.ok && !l.pending && l.tags.length === 0);
  if (crash) return { status: FAIL, measured: `${where} failed: ${crash.what}: ${short(crash.detail, 80)}` };
  const r = judgeRowLines(lines, id);
  return r.status === NOT_YET && /^no check tagged/.test(r.measured) ? { status: NOT_YET, measured: `${r.measured} in ${where}` } : r;
}

/**
 * A fallback flag against its own rows. `runs` is what assignE2eRun returned for the scenarios run with the flag;
 * `coverage` maps each row to the scenarios that check it (checklist.json). A row is judged only on lines from its own
 * scenarios: a smoke check of the watch phase is not the room check of all nine phases. PASS only when every row has a
 * passing tagged check from its own scenario and none failed; a crash or a failed check is FAIL; a row that has no
 * scenario, or whose scenario didn't run or has no tagged check, holds the flag at NOT-YET (never PASS).
 */
export function judgeFallback(rows, runs, coverage = {}) {
  const crash = Object.values(runs).filter((r) => r.ran).flatMap((r) => r.lines).find((l) => !l.ok && !l.pending && l.tags.length === 0);
  if (crash) return { status: FAIL, measured: `${crash.scenario}: ${crash.what}: ${short(crash.detail, 80)}` };
  const per = rows.map((id) => {
    const names = coverage[id] ?? [];
    if (!names.length) return { id, status: NOT_YET, measured: "no e2e scenario checks this row yet" };
    const ran = names.filter((n) => runs[n]?.ran);
    if (!ran.length) return { id, status: NOT_YET, measured: `${names.join("/")}: ${runs[names[0]]?.notYet ?? "not run"}` };
    // a real FAIL tagged with this row fails it whichever scenario printed it (a P25 FAIL in `room`, say)
    const anywhere = Object.values(runs).filter((r) => r.ran).flatMap((r) => r.lines).filter((l) => l.tags.includes(id) && !l.ok && !l.pending);
    if (anywhere.length) return { id, status: FAIL, measured: short(anywhere.map((l) => `${l.scenario}: ${l.detail}`).join("; ")) };
    return { id, ...judgeRowLines(ran.flatMap((n) => runs[n].lines), id) };
  });
  const status = combine(per.map((p) => p.status));
  const measured = per.map((p) => (p.status === PASS ? `${p.id} ok` : p.status === FAIL ? `${p.id} FAIL: ${p.measured}` : `${p.id} not yet: ${p.measured}`)).join("; ");
  return { status, measured: short(measured, 200) };
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

/** A unit suite passes only if node --test exited 0 and ran at least one test; any nonzero exit (or kill) is a FAIL. */
export function suiteStatus(code, results) {
  const bad = results.filter((t) => !t.ok && !t.skipped).length;
  const ran = results.filter((t) => !t.skipped).length;
  if (code !== 0) return { status: FAIL, measured: `exit ${code ?? "killed"}; ${ran - bad} ok, ${bad} failed` };
  if (!ran) return { status: FAIL, measured: "no tests ran" };
  return { status: bad ? FAIL : PASS, measured: `${ran - bad} ok, ${bad} failed` };
}

const COURT_KEYS = ["court", "video", "freeze", "seat", "audio", "camera"];

/**
 * Did this HTTP response serve something that must stay private: a court bundle file, or a file escaped from the bundle
 * folder? res = { status, type, body } with the WHOLE body (never truncated, so a large leaked court.json or frames.json
 * is judged like a small one). Not a leak: anything but a 200, and vite's index.html (--dev answers 200 text/html for
 * any unknown path). A leak is a 200 whose body is court.json (two or more of its sections), frames.json (an array of
 * { src, q, f } entries) or carries one of `tokens` (a canary planted in the folder escaped from); with `strict`
 * (for paths that can only be bundle files) also any other 200 that is not that html shell.
 */
export function leaksBundle(res, { tokens = [], strict = false } = {}) {
  if (!res || res.status !== 200) return false;
  const body = String(res.body ?? "");
  if (tokens.some((t) => t && body.includes(t))) return true;
  try {
    const j = JSON.parse(body);
    if (j && typeof j === "object" && !Array.isArray(j) && COURT_KEYS.filter((k) => k in j).length >= 2) return true;
    if (Array.isArray(j) && j.length && typeof j[0] === "object" && j[0] && ("src" in j[0] || "q" in j[0])) return true;
  } catch {
    // not JSON
  }
  const shell = /html/i.test(res.type ?? "") || /^\s*<(!doctype|html)/i.test(body.slice(0, 200));
  return strict && !shell;
}

/** realpath of a path that may not exist yet: the deepest existing ancestor's on-disk spelling plus the rest. */
export function realpathLoose(p) {
  let cur = resolve(p);
  const rest = [];
  while (!existsSync(cur) && dirname(cur) !== cur) {
    rest.unshift(basename(cur));
    cur = dirname(cur);
  }
  return join(realpathSync.native(cur), ...rest);
}

/** a is b or inside it, or b is inside a, after realpath on both sides (symlinks, and capitals on a case-insensitive disk). */
export function overlapsReal(a, b) {
  const x = realpathLoose(a);
  const y = realpathLoose(b);
  const within = (c, p) => c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
  return within(x, y) || within(y, x);
}

/** --bundle takes a folder (what e2e.mjs and serve.mjs take): { dir } (absolute, or null for the stand-in) or { error }. */
export function parseBundleArg(arg) {
  if (arg == null) return { dir: null };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return { error: `--bundle takes a folder with court.json (as e2e.mjs and serve.mjs do), not a URL: ${arg}` };
  return { dir: resolve(arg) };
}

/** Every checkout of the repo: this one, the main one and every worktree, as real paths. */
export function checkoutRoots(repo, git) {
  const roots = new Set([realpathLoose(repo)]);
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common !== "?") roots.add(realpathLoose(dirname(common)));
  for (const line of git("worktree", "list", "--porcelain").split("\n")) if (line.startsWith("worktree ") && existsSync(line.slice(9))) roots.add(realpathLoose(line.slice(9)));
  return [...roots];
}

/** Every child the QA run starts, so none outlives it (a hung scenario, an interrupt, an exit). */
export class ChildRegistry {
  constructor() {
    this.children = new Set();
  }
  add(child, { group = false } = {}) {
    const entry = { child, group };
    this.children.add(entry);
    // a group stays until killAll: its leader exiting leaves descendants in the group, and kill(-pgid) still reaches them
    if (!group) child.once("exit", () => this.children.delete(entry));
    return child;
  }
  killAll() {
    for (const { child, group } of this.children) {
      try {
        process.kill(group ? -child.pid : child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    this.children.clear();
  }
}

/** Reject after ms (and clear the timer either way): nothing waits on a stalled page forever. */
export function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, fail) => (timer = setTimeout(() => fail(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms)))]).finally(() => clearTimeout(timer));
}

/**
 * Write a file under a fresh random name (O_EXCL, never following a link) and rename it into place: a symlink at `path`
 * is replaced, not written through, so an output folder can never be used to overwrite some other file.
 */
export function writeFresh(path, data) {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Where the "latest run" pointer goes: beside the run folder's real location, never beside a symlink's spelling. */
export function latestPath(out) {
  return join(dirname(realpathLoose(out)), "latest.txt");
}

// P4 judges DISPLAY judder (held, doubled or unevenly spaced frames), not the action's real speed changes. The metric is
// the detrended CV of the per-display-frame motion: each frame's motion divided by the median of the 9 frames around it,
// then std / mean of those ratios; the bar is <= 0.15 over pass 1 and pass 2. The raw CV is reported beside it as info.
// smooth_metrics.py (named in the plan) doesn't exist; the reference is court-spikes/smooth/py/analyze.py judder_summary
// plus this detrend. No measurement source feeds it yet, so P4 stays NOT-YET (checklist.json).
export const JUDDER_BAR = 0.15;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const cv = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return mean > 0 ? sd / mean : Infinity;
};

/** { detrended, raw, n }: `motion` is the frame-to-frame motion per display frame; frames whose local median is 0 are skipped. */
export function judderCv(motion, window = 9) {
  const half = (window - 1) / 2;
  const ratios = [];
  for (let i = 0; i < motion.length; i++) {
    const m = median(motion.slice(Math.max(0, i - half), Math.min(motion.length, i + half + 1)));
    if (m > 0) ratios.push(motion[i] / m);
  }
  return { detrended: ratios.length ? cv(ratios) : Infinity, raw: motion.length ? cv(motion) : Infinity, n: ratios.length };
}

/** The P4 verdict for one pass-1 + pass-2 motion series: PASS when the detrended CV <= 0.15. */
export function judderVerdict(motion) {
  const { detrended, raw, n } = judderCv(motion);
  const measured = `detrended CV ${detrended.toFixed(3)} (bar <= ${JUDDER_BAR}); raw CV ${raw.toFixed(3)} (info only), ${n} frames`;
  return { status: n > 0 && detrended <= JUDDER_BAR ? PASS : FAIL, measured };
}
