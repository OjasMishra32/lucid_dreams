// The verdict on one `?probe=headset` session (src/court/headset.ts records, appended by serve.mjs --dev), in ten lines:
//   node apps/webxr/scripts/court/qa/headset-summary.mjs <session>.jsonl [--json]
// Real time OK? Frame budget OK? Decode errors? Features granted? Exit 0 when nothing FAILs, 1 when something does,
// 2 on a file it can't read. Works on a file still being written (run it again for the latest). Stream C (`core`).
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/** The features court.ts asks for: local-floor is required, the rest have fallbacks (the play area, no persistence, no drawn hands). */
export const FEATURES = ["local-floor", "anchors", "hand-tracking", "bounded-floor"];
/** Dropped frames (intervals over 1.5 display periods) a session may have: OK up to this share, WARN up to the next. */
export const DROPPED_OK = 1;
export const DROPPED_WARN = 5;
/** The show may run this many display frames off the wall clock (summed over the watch) before real time FAILs. */
export const DRIFT_FRAMES = 2;

/** The records in a .jsonl text (lines that don't parse, a half-written last line say, are counted, not fatal). */
export function parse(text) {
  const records = [];
  let bad = 0;
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    try {
      const r = JSON.parse(l);
      if (r && typeof r === "object" && r.v === 1) records.push(r);
      else bad++;
    } catch {
      bad++;
    }
  }
  records.sort((a, b) => a.seq - b.seq);
  return { records, bad };
}

const pct = (n, d) => (d ? (100 * n) / d : 0);
const mb = (b) => `${(b / 1048576).toFixed(0)} MB`;
const worst = (a, b) => (a === "FAIL" || b === "FAIL" ? "FAIL" : a === "WARN" || b === "WARN" ? "WARN" : "OK");

/** The ten verdict lines and the overall status ("OK", "WARN", "FAIL"). */
export function summarize(records, bad = 0, name = "") {
  const lines = [];
  const status = {};
  if (!records.length) {
    const out = [`headset ${name}: no records${bad ? ` (${bad} unreadable lines)` : ""}`, "FAIL: nothing to judge: was the page opened with ?probe=headset through serve.mjs --dev?"];
    while (out.length < 10) out.push("-");
    return { lines: out, status: "FAIL" };
  }
  const first = records[0];
  const last = records[records.length - 1];
  const live = records.filter((r) => r.xr?.presenting);
  const showHz = last.xr?.showHz || 72;
  const ua = records.find((r) => r.ua)?.ua ?? "";
  const quest = /OculusBrowser|Quest/i.test(ua);
  lines.push(`headset ${name || first.session}: ${records.length} records over ${(last.t - first.t).toFixed(0)} s, ${live.length} in the headset${bad ? `, ${bad} unreadable lines` : ""}; ${quest ? "Quest Browser" : ua ? "not a Quest browser" : "browser unknown"}`);

  // the session and its rate
  const xr = (live.at(-1) ?? last).xr ?? {};
  const rateStatus = !live.length ? "FAIL" : xr.verdict === "matched" ? "OK" : xr.verdict === "unknown" ? "WARN" : xr.verdict === "hz90" ? "WARN" : "FAIL";
  status.rate = rateStatus;
  lines.push(`${rateStatus} session: ${live.length ? `${xr.frameRate ?? "?"} Hz (offered ${xr.supportedFrameRates?.join(", ") || "none"}; asked ${xr.requested ?? "nothing"}), show ${showHz} Hz: ${xr.verdict}` : "never entered immersive-ar"}`);

  // features and blend mode
  const granted = new Set(live.flatMap((r) => r.xr?.enabledFeatures ?? []));
  const missing = FEATURES.filter((f) => !granted.has(f));
  const known = live.some((r) => Array.isArray(r.xr?.enabledFeatures) && r.xr.enabledFeatures.length);
  const featStatus = !live.length ? "FAIL" : !known ? "WARN" : missing.includes("local-floor") ? "FAIL" : missing.length ? "WARN" : "OK";
  status.features = featStatus;
  const blend = [...new Set(live.map((r) => r.xr?.environmentBlendMode).filter(Boolean))].join("/") || "unknown";
  lines.push(`${featStatus} features: ${known ? `granted ${[...granted].join(", ") || "none"}${missing.length ? `; missing ${missing.join(", ")}` : ""}` : "not reported by the browser"}; blend ${blend}${blend.includes("alpha-blend") ? " (drawn opaque: passthrough only where we clear it)" : ""}`);

  // decoding
  const configs = records.find((r) => r.decode?.configs)?.decode.configs ?? [];
  const inUse = configs.find((c) => c.stream === "in use");
  const v = [...records].reverse().find((r) => r.video)?.video;
  const errors = records.flatMap((r) => r.video?.errors ?? []);
  const errorCount = v?.errorCount ?? errors.length;
  const decStatus = inUse?.supported === false || errorCount > 0 ? "FAIL" : !inUse || inUse.supported === null || !v ? "WARN" : v.held > 0 || v.skipped > 0 || v.resets > 0 ? "WARN" : "OK";
  status.decode = decStatus;
  const support = configs.map((c) => `${c.stream} ${c.codec} ${c.width}x${c.height} ${c.supported === null ? "?" : c.supported ? "yes" : "NO"}`).join("; ") || "not checked";
  lines.push(`${decStatus} decode: ${support}; ${v ? `shown ${v.shown}, held ${v.held}, skipped ${v.skipped}, resets ${v.resets}, ${errorCount} errors${errors[0] ? ` (first: ${errors[0].slice(0, 70)})` : ""}` : "no player counters"}`);

  // the frame budget, while in the headset
  const framed = live.filter((r) => r.frames?.interval?.n);
  const n = framed.reduce((s, r) => s + r.frames.interval.n, 0);
  const drops = framed.reduce((s, r) => s + r.frames.dropped.count, 0);
  const p95 = Math.max(0, ...framed.map((r) => r.frames.interval.p95));
  const p99 = Math.max(0, ...framed.map((r) => r.frames.interval.p99));
  const p50s = framed.map((r) => r.frames.interval.p50).sort((a, b) => a - b);
  const p50 = p50s.length ? p50s[(p50s.length - 1) >> 1] : 0;
  const share = pct(drops, n);
  const budgetStatus = !n ? "FAIL" : share <= DROPPED_OK ? "OK" : share <= DROPPED_WARN ? "WARN" : "FAIL";
  status.budget = budgetStatus;
  const hz = framed.at(-1)?.frames.hz ?? showHz;
  lines.push(`${budgetStatus} frame budget: ${n ? `p50 ${p50} ms, worst 2 s p95 ${p95} ms / p99 ${p99} ms (period ${(1000 / hz).toFixed(1)} ms); dropped ${drops} of ${n} (${share.toFixed(2)}%)` : "no frames in the headset"}`);

  // real time
  const watched = records.filter((r) => r.drift?.windowS > 0);
  const totalMs = last.drift?.totalMs ?? 0;
  const frameMs = 1000 / showHz;
  const rateMsPerS = Math.max(0, ...watched.map((r) => Math.abs(r.drift.windowMs) / r.drift.windowS));
  const rtStatus = !watched.length ? "WARN" : Math.abs(totalMs) <= DRIFT_FRAMES * frameMs ? "OK" : "FAIL";
  status.realtime = rtStatus;
  const watchS = watched.reduce((s, r) => s + r.drift.windowS, 0);
  lines.push(`${rtStatus} real time: ${watched.length ? `the show is ${(totalMs / frameMs).toFixed(2)} frames ${totalMs >= 0 ? "ahead of" : "behind"} the wall clock after ${watchS.toFixed(0)} s of play (worst 2 s: ${rateMsPerS.toFixed(1)} ms/s)` : "the show never played"}`);

  // phases and the picture
  const phases = [];
  for (const r of records) if (r.phase && phases.at(-1) !== r.phase) phases.push(r.phase);
  const shownMax = Math.max(-1, ...records.map((r) => r.onScreen ?? -1));
  lines.push(`phases: ${phases.join(" > ") || "none"}; last show frame ${last.showFrame} (${last.segment ?? "-"}), on screen ${last.onScreen}, furthest on screen ${shownMax}`);

  // splats and memory
  const splats = Math.max(0, ...records.map((r) => r.splats ?? 0));
  const heaps = records.filter((r) => r.heap);
  const heap = heaps.length ? Math.max(...heaps.map((r) => r.heap.used)) : null;
  const limit = heaps.at(-1)?.heap.limit ?? null;
  const memStatus = heap !== null && limit && heap > 0.8 * limit ? "WARN" : "OK";
  status.memory = memStatus;
  lines.push(`${memStatus} load: up to ${splats.toLocaleString("en-US")} splats drawn; JS heap ${heap === null ? "not reported" : `up to ${mb(heap)}${limit ? ` of ${mb(limit)}` : ""}`}`);

  // the console
  const msgs = records.flatMap((r) => r.console ?? []);
  const errs = msgs.filter((m) => m.level === "error");
  const warns = msgs.filter((m) => m.level === "warn");
  const lost = records.reduce((s, r) => s + (r.consoleDropped ?? 0), 0);
  const conStatus = errs.length ? "FAIL" : warns.length ? "WARN" : "OK";
  status.console = conStatus;
  lines.push(`${conStatus} console: ${errs.length} errors, ${warns.length} warnings${lost ? ` (+${lost} not kept)` : ""}${(errs[0] ?? warns[0]) ? `; first: ${(errs[0] ?? warns[0]).msg.slice(0, 90)}` : ""}`);

  const overall = Object.values(status).reduce(worst, "OK");
  const flagged = Object.entries(status).filter(([, s]) => s !== "OK").map(([k, s]) => `${k} ${s}`);
  lines.push(`VERDICT ${overall}${flagged.length ? `: ${flagged.join(", ")}` : ": real time, frame budget, decode, features and console all OK"}`);
  return { lines, status: overall };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node apps/webxr/scripts/court/qa/headset-summary.mjs <session>.jsonl [--json]");
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`can't read ${file}: ${e.message}`);
    process.exit(2);
  }
  const { records, bad } = parse(text);
  const { lines, status } = summarize(records, bad, basename(file, ".jsonl"));
  if (process.argv.includes("--json")) console.log(JSON.stringify({ status, lines }, null, 2));
  else console.log(lines.join("\n"));
  process.exit(status === "FAIL" ? 1 : 0);
}
