// `?probe=headset` without a headset: the page's record (headset.ts) from a fake source, the show-vs-wall drift it
// carries, serve.mjs's sink (headset-sink.mjs) on a temp folder, and qa/headset-summary.mjs's ten-line verdict on
// synthetic sessions (a good one, and one of each way a headset run can go wrong). headset.ts imports stats.ts by
// value, so this file resolves extensionless sibling imports itself (vite does in the app).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HeadsetRecord, HeadsetSource } from "../../src/court/headset.ts";
import { headsetDir, MAX_RECORD, takeRecord } from "../../src/court/headset-sink.mjs";
import { parse, summarize } from "./qa/headset-summary.mjs";
import type { ClockState } from "../../src/court/clock.ts";
import type { CourtBundle } from "../../src/court/format.ts";
import { standinBundle } from "./standin.mjs";

registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith(".ts")) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        // not a sibling .ts: resolve as written
      }
    }
    return next(specifier, context);
  },
});
const { HeadsetTelemetry, ShowDrift } = await import("../../src/court/headset.ts");

const clockAt = (segment: string, segmentFrame: number, ease: number | null = null): ClockState =>
  ({ frame: segmentFrame, segment, ease, speed: 1, nextEase: null, nextJump: null, armed: false, pass: 0, segmentFrame }) as ClockState;

// ---------------- the drift ----------------

test("ShowDrift: a clock keeping real time stays at 0; one stepping a 72 Hz show a frame per 120 Hz frame runs 67% ahead", () => {
  const real = new ShowDrift(72);
  const fast = new ShowDrift(72);
  let shown = 0;
  for (let i = 0; i < 1200; i++) {
    shown += 0.6;
    real.frame(clockAt("pass1", Math.floor(shown + 0.5)), 1 / 120, true);
    fast.frame(clockAt("pass1", i), 1 / 120, true);
  }
  assert.ok(Math.abs(real.total) <= 1 / 72, `${real.total}`);
  const wall = 1199 / 120;
  assert.ok(Math.abs(fast.total - wall * (120 / 72 - 1)) < 1e-6, `${fast.total}`);
  const w = fast.take();
  assert.ok(w.windowS > 9.9 && w.windowMs > 6600);
  assert.equal(fast.take().windowS, 0, "the window resets");
});

test("ShowDrift counts no jump, no freeze, no hold in See my room and no hitch", () => {
  const d = new ShowDrift(72);
  d.frame(clockAt("pass2", 100), 1 / 72, true);
  d.frame(clockAt("pass1", 0), 1 / 72, true); // the repeat: a jump
  d.frame(clockAt("freeze", 0), 1 / 72, true);
  d.frame(clockAt("freeze", 0), 5, true);
  d.frame(clockAt("pass1", 1), 1 / 72, false); // held in the room
  d.frame(clockAt("pass1", 1), 1 / 72, false);
  d.frame(clockAt("pass1", 2), 0.5, true);
  d.frame(clockAt("pass1", 40), 0.5, true); // a hitch (over 0.25 s)
  assert.equal(d.total, 0);
});

// ---------------- the page's record ----------------

function fakeSource(over: Partial<HeadsetSource> = {}): HeadsetSource {
  const { court, frames } = standinBundle() as { court: CourtBundle["court"]; frames: CourtBundle["frames"] };
  return {
    bundle: { court, frames } as unknown as CourtBundle,
    phase: () => "watching",
    inRoom: () => false,
    clock: () => clockAt("pass1", 10),
    onScreen: () => 10,
    video: () => ({ shown: 10, held: 0, heldAt: [], skipped: 0, dropped: 0, startup: 2, decodeMs: [3, 4, 5], uploadMs: [], queueMax: 3, queueMin: 1, resets: 0, switches: 0, onScreen: 10, errors: ["decoder: boom"] }),
    splats: () => 416000,
    xr: () => ({ rate: 72, supported: [72, 90, 120], requested: 72, showHz: 72, verdict: "matched" }),
    session: () => null,
    stats: () => ({ watching: {} }),
    ...over,
  };
}

test("the record: frame times of its window against the session's rate, the player's new errors and decode times once, the splats", () => {
  const sent: string[] = [];
  const t = new HeadsetTelemetry(fakeSource(), (b) => sent.push(b));
  for (let i = 0; i < 100; i++) t.frame(i === 50 ? 40 : 1000 / 72);
  const a: HeadsetRecord = t.record();
  assert.equal(a.v, 1);
  assert.match(a.session, /^[A-Za-z0-9-]{1,48}$/);
  assert.equal(a.frames!.interval.n, 100);
  assert.equal(a.frames!.dropped.count, 1, "the 40 ms frame is late at 72 Hz");
  assert.equal(a.splats, 416000);
  assert.deepEqual(a.video!.errors, ["decoder: boom"]);
  assert.equal(a.video!.decodeMs!.n, 3);
  assert.equal(a.phase, "watching");
  assert.ok(a.ua !== undefined, "the first record names the browser");
  const b = t.record();
  assert.equal(b.frames, null, "a new window");
  assert.deepEqual(b.video!.errors, [], "each error once");
  assert.equal(b.video!.errorCount, 1);
  assert.equal(b.video!.decodeMs, null);
  assert.equal(b.seq, a.seq + 1);
  assert.equal(b.ua, undefined);
  assert.ok(JSON.stringify(a).length < MAX_RECORD);
});

// ---------------- the sink ----------------

test("the sink appends each record as one JSON line per session; refuses bad ids, bad JSON, oversize bodies, and keeps nothing without a folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "court-headset-"));
  try {
    const rec = (session: string, seq: number) => Buffer.from(JSON.stringify({ v: 1, session, seq }));
    assert.equal(takeRecord(dir, rec("20261024T1446-abc123", 0)).status, 204);
    assert.equal(takeRecord(dir, rec("20261024T1446-abc123", 1)).status, 204);
    const lines = readFileSync(join(dir, "20261024T1446-abc123.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.seq), [0, 1]);
    assert.ok(lines.every((l) => typeof l.receivedAt === "string"));
    assert.equal(takeRecord(dir, rec("../escape", 0)).status, 400);
    assert.equal(takeRecord(dir, rec("a/b", 0)).status, 400);
    assert.equal(takeRecord(dir, Buffer.from("not json")).status, 400);
    assert.equal(takeRecord(dir, Buffer.from("[1,2]")).status, 400);
    assert.equal(takeRecord(dir, Buffer.alloc(MAX_RECORD + 1, 32)).status, 413);
    assert.equal(takeRecord(null, rec("x", 0)).status, 503);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(headsetDir(null, {}), null, "no folder named in the repo");
  assert.equal(headsetDir(null, { COURT_DATA: "/data" }), "/data/qa/headset");
  assert.equal(headsetDir("/elsewhere", { COURT_DATA: "/data" }), "/elsewhere");
});

// ---------------- the verdict ----------------

/** A synthetic session: `n` records 2 s apart in the headset, each `edit`ed. */
function session(n: number, edit: (r: Record<string, any>, i: number) => void = () => {}) {
  const out: Record<string, any>[] = [];
  for (let i = 0; i < n; i++) {
    const r: Record<string, any> = {
      v: 1, session: "s1", seq: i, t: 2 * i, at: "", ...(i === 0 ? { ua: "Mozilla/5.0 (X11; Linux x86_64; Quest 3S) OculusBrowser/40.0 Chrome/132" } : {}),
      xr: { presenting: true, frameRate: 72, supportedFrameRates: [72, 80, 90, 120], requested: 72, verdict: "matched", showHz: 72, enabledFeatures: ["local-floor", "anchors", "hand-tracking", "bounded-floor"], environmentBlendMode: "alpha-blend", visibilityState: "visible" },
      decode: { configs: [{ stream: "in use", codec: "avc1.640033", width: 1536, height: 2160, supported: true }, { stream: "hz90", codec: "avc1.640034", width: 1536, height: 2160, supported: true }] },
      frames: { interval: { p50: 13.9, p95: 14.2, p99: 14.6, max: 15, mean: 13.9, n: 144 }, dropped: { count: 0, pct: 0 }, hz: 72 },
      drift: { totalMs: 2, windowMs: 0.5, windowS: 2 },
      phase: i < 3 ? "arrival" : "watching", showFrame: 144 * i, onScreen: 144 * i, segment: "pass1", splats: 416000,
      heap: { used: 300e6, total: 400e6, limit: 4e9 }, video: { shown: 144 * i, held: 0, dropped: 0, skipped: 0, resets: 0, startup: 2, switches: 0, queueMin: 1, queueMax: 3, errors: [], errorCount: 0, decodeMs: null },
      console: [], consoleDropped: 0,
    };
    edit(r, i);
    out.push(r);
  }
  return out;
}

const judge = (records: Record<string, any>[], bad = 0) => {
  const out = summarize(records, bad, "s1");
  assert.equal(out.lines.length, 10, out.lines.join("\n"));
  return out;
};

test("summary: a good Quest session is OK on every line, in ten lines", () => {
  const { lines, status } = judge(session(30));
  assert.equal(status, "OK", lines.join("\n"));
  assert.match(lines[0], /30 records over 58 s, 30 in the headset; Quest Browser/);
  assert.match(lines[1], /^OK session: 72 Hz .*matched/);
  assert.match(lines[2], /^OK features: granted local-floor, anchors, hand-tracking, bounded-floor; blend alpha-blend/);
  assert.match(lines[4], /^OK frame budget: .*dropped 0 of 4320/);
  assert.match(lines[5], /^OK real time: the show is 0.14 frames ahead/);
  assert.match(lines[6], /phases: arrival > watching/);
  assert.match(lines[9], /^VERDICT OK/);
});

test("summary: a 120 Hz headset stepping a frame per frame FAILs real time; a rate the show isn't baked for FAILs the session", () => {
  const { lines, status } = judge(session(10, (r) => Object.assign(r.xr, { frameRate: 120, requested: null, verdict: "mismatch" }) && (r.drift = { totalMs: 1333 * (r.seq + 1), windowMs: 1333, windowS: 2 })));
  assert.equal(status, "FAIL");
  assert.match(lines[1], /^FAIL session: 120 Hz/);
  assert.match(lines[5], /^FAIL real time: the show is \d+\.\d+ frames ahead/);
  assert.match(lines[9], /realtime FAIL/);
});

test("summary: dropped frames, decode failures, a missing local-floor and console errors each FAIL their line", () => {
  const drops = judge(session(5, (r) => (r.frames.dropped = { count: 20, pct: 13.9 })));
  assert.match(drops.lines[4], /^FAIL frame budget: .*dropped 100 of 720 \(13\.89%\)/);
  const someDrops = judge(session(5, (r, i) => (r.frames.dropped = { count: i === 0 ? 15 : 0, pct: 0 })));
  assert.match(someDrops.lines[4], /^WARN frame budget/);
  const decode = judge(session(3, (r) => (r.decode.configs[0].supported = false)));
  assert.match(decode.lines[3], /^FAIL decode: in use avc1.640033 1536x2160 NO/);
  const decodeErr = judge(session(3, (r, i) => i === 2 && Object.assign(r.video, { errors: ["decoder playing closed itself; replaced"], errorCount: 1 })));
  assert.match(decodeErr.lines[3], /^FAIL decode: .*1 errors \(first: decoder playing closed itself/);
  const floor = judge(session(3, (r) => (r.xr.enabledFeatures = ["anchors"])));
  assert.match(floor.lines[2], /^FAIL features: .*missing local-floor, hand-tracking, bounded-floor/);
  const optional = judge(session(3, (r) => (r.xr.enabledFeatures = ["local-floor", "hand-tracking"])));
  assert.match(optional.lines[2], /^WARN features: .*missing anchors, bounded-floor/);
  const con = judge(session(3, (r, i) => i === 1 && r.console.push({ level: "error", msg: "Court Side frame: TypeError: x is undefined", t: 3 })));
  assert.match(con.lines[8], /^FAIL console: 1 errors, 0 warnings; first: Court Side frame: TypeError/);
  for (const out of [drops, decode, decodeErr, floor, con]) assert.equal(out.status, "FAIL");
});

test("summary: a session that never entered the headset, an empty file and a half-written last line", () => {
  const outside = judge(session(4, (r) => (r.xr.presenting = false)));
  assert.equal(outside.status, "FAIL");
  assert.match(outside.lines[1], /never entered immersive-ar/);
  const empty = judge([]);
  assert.equal(empty.status, "FAIL");
  const text = session(4).map((r) => JSON.stringify(r)).join("\n") + '\n{"v":1,"session":"s1","seq":4,"t":';
  const { records, bad } = parse(text);
  assert.equal(records.length, 4);
  assert.equal(bad, 1);
  assert.match(judge(records, bad).lines[0], /1 unreadable lines/);
});
