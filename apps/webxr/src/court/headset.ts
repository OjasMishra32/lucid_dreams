// `?probe=headset` (dev only: court.ts loads this only under import.meta.env.DEV, so no build carries it): what the real
// headset is doing, without adb or developer mode. Every 2 s the page POSTs one JSON record to serve.mjs --dev
// (/__court/headset, same origin, so it rides a tunnel too), which appends it to
// ~/court-side-data/qa/headset/<session>.jsonl; `node apps/webxr/scripts/court/qa/headset-summary.mjs <file>` reads it.
// Each record: the XR session (frameRate, supportedFrameRates, enabled features, environmentBlendMode, visibility),
// what VideoDecoder.isConfigSupported says of each stream, the frame times of the last 2 s (p50/p95/p99, dropped
// against the session's rate), the show's drift against the wall clock, the phase, the show frame on screen, the
// splats drawn, the JS heap when the browser has performance.memory, the video player's counters and every console
// error and warning since the last record. Stream C (`core`).
import type { ClockState } from "./clock";
import type { CourtBundle } from "./format";
import type { XrRate } from "./rate";
import { dropped, summarize, type Interval } from "./stats";
import type { VideoStats } from "./video";

/** Where the records go (serve.mjs --dev). */
export const HEADSET_PATH = "/__court/headset";
/** Seconds between records. */
export const HEADSET_EVERY_S = 2;
/** Console lines kept per record (the rest are counted). */
const CONSOLE_MAX = 40;

/** What court.ts hands the telemetry: getters only, read when a record is made (and the drift every frame). */
export interface HeadsetSource {
  bundle: CourtBundle;
  phase(): string;
  inRoom(): boolean;
  clock(): ClockState | null;
  /** The show frame on the video texture (-1 none). */
  onScreen(): number;
  /** The video player's counters (video.ts). */
  video(): VideoStats | null;
  /** Splats Spark drew last (SparkRenderer.activeSplats). */
  splats(): number;
  xr(): XrRate;
  session(): XRSession | null;
  /** stats.ts FrameStats.report(): the whole session, per phase. */
  stats(): unknown;
}

/**
 * The show against the wall clock: while the clock plays a segment (not the freeze, not held in See my room), every
 * display frame's show frames advanced, at the stream's displayHz, against the frame's real interval. A show that
 * keeps real time stays within a frame of 0; one stepping a 72 Hz show a frame per 120 Hz frame runs 67% ahead.
 */
export class ShowDrift {
  /** Show seconds minus wall seconds, summed over the counted frames. */
  total = 0;
  /** The same over the frames since the last take(). */
  window = 0;
  /** Wall seconds counted since the last take(). */
  windowWall = 0;
  private last: { segment: string; ease: number | null; segmentFrame: number } | null = null;
  private readonly hz: number;

  constructor(displayHz: number) {
    this.hz = displayHz;
  }

  /** One display frame: the clock's state after it, the frame's real interval (s), and whether the clock was playing. */
  frame(clock: ClockState | null, intervalS: number, playing: boolean): void {
    const prev = this.last;
    if (!clock || !playing || clock.segment === "freeze") {
      this.last = null;
      return;
    }
    this.last = { segment: clock.segment, ease: clock.ease, segmentFrame: clock.segmentFrame };
    if (!prev || prev.segment !== clock.segment || prev.ease !== clock.ease || intervalS <= 0 || intervalS > 0.25) return; // a jump, a pause or a hitch
    const d = (clock.segmentFrame - prev.segmentFrame) / this.hz - intervalS;
    this.total += d;
    this.window += d;
    this.windowWall += intervalS;
  }

  take(): { totalMs: number; windowMs: number; windowS: number } {
    const out = { totalMs: round(this.total * 1000), windowMs: round(this.window * 1000), windowS: round(this.windowWall, 3) };
    this.window = 0;
    this.windowWall = 0;
    return out;
  }
}

const round = (v: number, digits = 2) => Number(v.toFixed(digits));

/** A console line or page error, cut short. */
export function line(level: string, args: unknown[]): { level: string; msg: string } {
  const msg = args
    .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : (() => {
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })()))
    .join(" ");
  return { level, msg: msg.slice(0, 400) };
}

/** One record, as serve.mjs appends it and headset-summary.mjs reads it. */
export interface HeadsetRecord {
  v: 1;
  session: string;
  seq: number;
  /** Seconds since the page started the telemetry. */
  t: number;
  at: string;
  ua?: string;
  xr: {
    presenting: boolean;
    frameRate: number | null;
    supportedFrameRates: number[];
    requested: number | null;
    verdict: string;
    showHz: number;
    enabledFeatures: string[] | null;
    environmentBlendMode: string | null;
    visibilityState: string | null;
  };
  decode: { configs: { stream: string; codec: string; width: number; height: number; supported: boolean | null }[] } | null;
  frames: { interval: Interval; dropped: { count: number; pct: number }; hz: number } | null;
  phases: unknown;
  drift: { totalMs: number; windowMs: number; windowS: number };
  phase: string;
  showFrame: number;
  onScreen: number;
  segment: string | null;
  splats: number;
  heap: { used: number; total: number; limit: number } | null;
  /** The player's counters so far, its errors and decode latency since the last record. */
  video: {
    shown: number; held: number; dropped: number; skipped: number; resets: number; startup: number; switches: number; queueMin: number | null; queueMax: number;
    errors: string[]; errorCount: number; decodeMs: Interval | null;
  } | null;
  console: { level: string; msg: string; t: number }[];
  consoleDropped: number;
}

/** The streams the bundle names, for isConfigSupported (the one in use, `?show=small`'s, `?hz=90`'s). */
function streams(bundle: CourtBundle): { stream: string; codec: string; width: number; height: number }[] {
  const v = bundle.court.video;
  const out = [{ stream: "in use", codec: v.codec, width: v.width, height: v.height }];
  const f = v.fallbacks;
  if (f?.small) out.push({ stream: "small", codec: f.small.codec, width: f.small.width, height: f.small.height });
  if (f?.hz90) out.push({ stream: "hz90", codec: f.hz90.codec, width: f.hz90.width, height: f.hz90.height });
  return out;
}

/** The telemetry: court.ts calls frame() once per display frame; records go out every HEADSET_EVERY_S on their own. */
export class HeadsetTelemetry {
  private readonly src: HeadsetSource;
  private readonly send: (body: string) => void;
  private readonly session = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${Math.random().toString(36).slice(2, 8)}`;
  private readonly started = performance.now();
  private readonly drift: ShowDrift;
  private intervals: number[] = [];
  private consoleLines: { level: string; msg: string; t: number }[] = [];
  private consoleDropped = 0;
  private seq = 0;
  private decode: HeadsetRecord["decode"] = null;
  /** How far into the player's error and decode-time lists the last record read. */
  private videoErrors = 0;
  private videoDecodes = 0;

  constructor(src: HeadsetSource, send?: (body: string) => void) {
    this.src = src;
    this.send = send ?? ((body) => void fetch(HEADSET_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {}));
    this.drift = new ShowDrift(src.bundle.court.video.displayHz);
  }

  /** Hook the console and page errors, check the decoders, and start posting. */
  start(): void {
    for (const level of ["error", "warn"] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        this.note(level, args);
        original(...args);
      };
    }
    addEventListener("error", (e) => this.note("error", [e.error ?? e.message]));
    addEventListener("unhandledrejection", (e) => this.note("error", ["unhandled rejection:", e.reason]));
    void this.checkDecoders();
    setInterval(() => this.post(), HEADSET_EVERY_S * 1000);
    this.post();
  }

  /** Once per display frame, after the clock stepped: the frame's real interval (ms). */
  frame(intervalMs: number): void {
    if (intervalMs > 0) this.intervals.push(intervalMs);
    const phase = this.src.phase();
    const playing = (phase === "watching" || phase === "easing" || phase === "resume") && (!this.src.inRoom() || phase === "resume");
    this.drift.frame(this.src.clock(), intervalMs / 1000, playing);
  }

  /** The record of the last HEADSET_EVERY_S (and resets the window). */
  record(): HeadsetRecord {
    const xr = this.src.xr();
    const s = this.src.session();
    const hz = xr.rate ?? xr.showHz;
    const clock = this.src.clock();
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    const rec: HeadsetRecord = {
      v: 1,
      session: this.session,
      seq: this.seq++,
      t: round((performance.now() - this.started) / 1000, 3),
      at: new Date().toISOString(),
      ...(this.seq === 1 ? { ua: navigator.userAgent } : {}),
      xr: {
        presenting: !!s,
        frameRate: s?.frameRate ?? null,
        supportedFrameRates: s?.supportedFrameRates ? Array.from(s.supportedFrameRates) : [],
        requested: xr.requested,
        verdict: xr.verdict,
        showHz: xr.showHz,
        enabledFeatures: s ? (Array.from((s as unknown as { enabledFeatures?: string[] }).enabledFeatures ?? []) as string[]) : null,
        environmentBlendMode: s?.environmentBlendMode ?? null,
        visibilityState: s?.visibilityState ?? null,
      },
      decode: this.decode,
      frames: this.intervals.length ? { interval: summarize(this.intervals), dropped: dropped(this.intervals, hz), hz } : null,
      phases: this.src.stats(),
      drift: this.drift.take(),
      phase: this.src.phase(),
      showFrame: clock?.frame ?? -1,
      onScreen: this.src.onScreen(),
      segment: clock?.segment ?? null,
      splats: this.src.splats(),
      heap: mem ? { used: mem.usedJSHeapSize, total: mem.totalJSHeapSize, limit: mem.jsHeapSizeLimit } : null,
      video: this.videoPart(),
      console: this.consoleLines,
      consoleDropped: this.consoleDropped,
    };
    this.intervals = [];
    this.consoleLines = [];
    this.consoleDropped = 0;
    return rec;
  }

  private videoPart(): HeadsetRecord["video"] {
    const v = this.src.video();
    if (!v) return null;
    const errors = v.errors.slice(this.videoErrors, this.videoErrors + CONSOLE_MAX);
    const decodes = v.decodeMs.slice(this.videoDecodes);
    this.videoErrors = v.errors.length;
    this.videoDecodes = v.decodeMs.length;
    return {
      shown: v.shown, held: v.held, dropped: v.dropped, skipped: v.skipped, resets: v.resets, startup: v.startup, switches: v.switches,
      queueMin: Number.isFinite(v.queueMin) ? v.queueMin : null, queueMax: v.queueMax, errors, errorCount: v.errors.length, decodeMs: decodes.length ? summarize(decodes) : null,
    };
  }

  private post(): void {
    try {
      this.send(JSON.stringify(this.record()));
    } catch {
      // a record that can't be made or sent is skipped; the next one carries on
    }
  }

  private note(level: string, args: unknown[]): void {
    if (this.consoleLines.length >= CONSOLE_MAX) {
      this.consoleDropped++;
      return;
    }
    this.consoleLines.push({ ...line(level, args), t: round((performance.now() - this.started) / 1000, 3) });
  }

  private async checkDecoders(): Promise<void> {
    const configs = [];
    for (const c of streams(this.src.bundle)) {
      let supported: boolean | null = null;
      try {
        if (typeof VideoDecoder !== "undefined")
          supported = !!(await VideoDecoder.isConfigSupported({ codec: c.codec, codedWidth: c.width, codedHeight: c.height, optimizeForLatency: true })).supported;
      } catch {
        supported = false;
      }
      configs.push({ ...c, supported });
    }
    this.decode = { configs };
  }
}
