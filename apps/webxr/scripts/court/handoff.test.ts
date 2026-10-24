// handoff.ts: the chosen direction (3.3a, House Lights' pool on Same Pixels' timing) as pure beats of time from F,
// and what handoff(t, parts) / handback(t, parts) hand every part (recording fakes, no DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACK_BEATS, BEATS, HANDBACK_END, HANDOFF_END, handback, handbackBeats, handoff, handoffBeats, type HandoffParts,
} from "../../src/court/handoff.ts";

const HZ = 72;
const close = (a: number, b: number, eps = 1e-9, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} vs ${b}`);
/** Seconds at every display frame from a, up to b. */
const frames = (a: number, b: number) => Array.from({ length: Math.floor((b - a) * HZ + 1e-9) + 1 }, (_, k) => a + k / HZ);
/** The largest change of f between two display frames over [a, b]. */
const maxStep = (f: (t: number) => number, a: number, b: number) => {
  let m = 0;
  const ts = frames(a, b);
  for (let k = 1; k < ts.length; k++) m = Math.max(m, Math.abs(f(ts[k]) - f(ts[k - 1])));
  return m;
};
/** smootherstep's steepest slope is 15/8 per unit: a beat over d seconds changes at most this much per display frame. */
const stepBar = (d: number) => 1.875 / (d * HZ) + 1e-9;
const monotone = (f: (t: number) => number, a: number, b: number, sign: 1 | -1, what: string) => {
  let prev = f(a);
  for (const t of frames(a, b)) {
    assert.ok(sign * (f(t) - prev) >= -1e-15, `${what} monotone at ${t}`);
    prev = f(t);
  }
};

type Call = [string, ...unknown[]];
/** Records every call a part receives, in order. */
function recorder() {
  const calls: Call[] = [];
  const fn = (name: string) => (...a: unknown[]) => void calls.push([name, ...a]);
  const video = {
    _opacity: 1,
    set opacity(k: number) {
      calls.push(["video.opacity", k]);
      this._opacity = k;
    },
    get opacity() {
      return this._opacity;
    },
    mask: fn("video.mask"),
  };
  const parts = {
    video,
    proxies: { dim: fn("proxies.dim"), reality: fn("proxies.reality") },
    world: { open: fn("world.open") },
    freeze: { reveal: fn("freeze.reveal") },
    sound: { timeStop: fn("sound.timeStop"), release: fn("sound.release") },
    light: { set: fn("light.set") },
  };
  return { calls, parts: parts as unknown as HandoffParts };
}
const last = (calls: Call[], name: string) => [...calls].reverse().find((c) => c[0] === name);
const lastNum = (calls: Call[], name: string) => Number(last(calls, name)![1]);

test("the beats are the plan's (3.3): splats up from F - 0.45, mask F + 0.1..3.1 (the window opens over 3 s, P44), video F + 0.15..1.15, pool 1..4, stands 3..5", () => {
  assert.deepEqual(BEATS, { splatsUp: [-0.45, 0.3], maskLifts: [0.1, 3.1], videoFades: [0.15, 1.15], poolGrows: [1.0, 4.0], standsRise: [3.0, 5.0] });
  assert.equal(HANDOFF_END, 5.0);
  assert.deepEqual(BACK_BEATS, { videoReturns: [-0.1, 1.2], maskCloses: [1.2, 1.8] });
  assert.equal(HANDBACK_END, 1.8);
});

test("the video layer fades over F + 0.15 .. F + 1.15 s (P10: 1.0 s), smootherstep, never a step", () => {
  for (const t of frames(-0.5, 0.15)) close(handoffBeats(t).video, 1, 0, `opaque at ${t}`);
  for (const t of frames(1.15, 6)) close(handoffBeats(t).video, 0, 0, `gone at ${t}`);
  close(handoffBeats(0.65).video, 0.5, 1e-12, "half way at the middle");
  assert.ok(maxStep((t) => handoffBeats(t).video, 0, 1.3) <= stepBar(1.0), "per-frame change within smootherstep's slope");
  monotone((t) => handoffBeats(t).video, 0, 1.3, -1, "video");
});

test("the splats come up F - 0.45 .. F + 0.3 under the picture; the mask lifts F + 0.1 .. 3.1; the world opens with the pool", () => {
  const at = (t: number) => handoffBeats(t);
  close(at(-0.45).reveal, 0, 0, "nothing drawn before");
  close(at(0.3).reveal, 1, 0, "drawn by F + 0.3");
  for (const t of frames(-0.45, 0.15)) close(at(t).video, 1, 0, "the picture stays opaque while they come up");
  assert.ok(at(0.15).reveal > 0.8, "mostly up before the fade starts");
  close(at(0.1).mask, 0, 0, "the watch's edge before");
  close(at(3.1).mask, 1, 0, "lifted");
  close(at(1.0).open, 0, 0, "the world waits for the pool");
  close(at(4.0).open, 1, 0, "open as the pool leaves it");
  assert.ok(maxStep((t) => at(t).reveal, -0.6, 0.4) <= stepBar(0.75));
  assert.ok(maxStep((t) => at(t).mask, 0, 3.3) <= stepBar(3.0));
  assert.ok(maxStep((t) => at(t).open, 0.9, 4.2) <= stepBar(3.0));
  monotone((t) => at(t).reveal, -0.6, 0.4, 1, "reveal");
  monotone((t) => at(t).mask, 0, 1.2, 1, "mask");
});

test("handoff(t, parts) hands every part its beat; the light field gets the hand-off's own time from F, never before F", () => {
  const { calls, parts } = recorder();
  handoff(0.65, parts);
  const b = handoffBeats(0.65);
  close(lastNum(calls, "video.opacity"), b.video, 1e-12);
  close(lastNum(calls, "video.mask"), b.mask, 1e-12);
  close(lastNum(calls, "freeze.reveal"), b.reveal, 1e-12);
  close(lastNum(calls, "world.open"), b.open, 1e-12);
  assert.deepEqual(last(calls, "light.set"), ["light.set", "handoff", 0.65]);
  assert.ok(!calls.some((c) => c[0] === "light.set" && c[1] !== "handoff"), "only the hand-off beat");
  // during the ease (court.ts calls it from F - 0.45 s) the ease's light and hush are court.ts's own
  const ease = recorder();
  for (const t of frames(-0.45, -1e-9)) handoff(t, ease.parts);
  assert.ok(!ease.calls.some((c) => c[0] === "light.set" || c[0].startsWith("sound.")), "no light or sound before F");
  close(lastNum(ease.calls, "video.opacity"), 1, 0);
  assert.ok(lastNum(ease.calls, "freeze.reveal") > 0.5, "the splats are mostly up by F");
});

test("a rushed fade (the head rose) never rushes the light: the field takes its own time from F when court.ts gives one", () => {
  const { calls, parts } = recorder();
  handoff(0.9, parts, 0.4);
  close(lastNum(calls, "video.opacity"), handoffBeats(0.9).video, 1e-12, "the picture at the rushed time");
  assert.deepEqual(last(calls, "light.set"), ["light.set", "handoff", 0.4]);
  const before = recorder();
  handoff(0.9, before.parts, -0.1);
  assert.ok(!before.calls.some((c) => c[0] === "light.set"), "a light time before F is the ease's");
});

test("the time stop's hush holds at 1 through the hand-off and the hand-back: it lifts only on the resume (sound.ts)", () => {
  const { calls, parts } = recorder();
  for (const t of frames(-0.45, HANDOFF_END + 0.5)) handoff(t, parts);
  for (const t of frames(BACK_BEATS.videoReturns[0], HANDBACK_END + 0.5)) handback(t, parts);
  const hush = calls.filter((c) => c[0] === "sound.timeStop");
  assert.ok(hush.length > 0, "held from F");
  assert.ok(hush.every((c) => c[1] === 1), "never below 1");
  assert.ok(!calls.some((c) => c[0] === "sound.release"), "never released here");
});

test("handoff(HANDOFF_END) lands every part where the open world wants it (See my room mid-ease jumps straight there)", () => {
  const { calls, parts } = recorder();
  handoff(HANDOFF_END, parts);
  close(parts.video.opacity, 0, 0);
  close(lastNum(calls, "video.mask"), 1, 0);
  close(lastNum(calls, "freeze.reveal"), 1, 0);
  close(lastNum(calls, "world.open"), 1, 0);
  assert.deepEqual(last(calls, "light.set"), ["light.set", "handoff", HANDOFF_END]);
  // and a whole run frame by frame is deterministic: the same t gives the same calls
  const a = recorder();
  const b = recorder();
  for (const t of frames(-0.45, HANDOFF_END)) handoff(t, a.parts);
  for (const t of frames(-0.45, HANDOFF_END)) handoff(t, b.parts);
  assert.deepEqual(a.calls, b.calls);
});

test("the hand-back: the picture returns from 0.1 s before the sit ends over 1.3 s, then the mask closes and the 3D goes under it", () => {
  const at = (t: number) => handbackBeats(t);
  close(at(-0.1).video, 0, 0, "3D only before");
  close(at(1.2).video, 1, 0, "picture back");
  assert.ok(maxStep((t) => at(t).video, -0.2, 1.3) <= stepBar(1.3));
  monotone((t) => at(t).video, -0.2, 1.3, 1, "video");
  close(at(1.2).mask, 1, 0, "mask still lifted while the picture returns");
  close(at(1.8).mask, 0, 0, "mask closed: the watch's edge");
  assert.ok(maxStep((t) => at(t).mask, 1.1, 1.9) <= stepBar(0.6));
  // the splats and the open world stay up until the picture covers them, then go down with the mask
  for (const t of frames(-0.1, 1.2)) {
    close(at(t).reveal, 1, 0, "drawn under the returning picture");
    close(at(t).open, 1, 0, "open under the returning picture");
  }
  close(at(1.8).reveal, 0, 0, "gone before play");
  close(at(1.8).open, 0, 0, "the watch's look before play");
  const { calls, parts } = recorder();
  handback(0.55, parts);
  close(parts.video.opacity, at(0.55).video, 1e-12);
  close(lastNum(calls, "video.mask"), 1, 0);
  assert.ok(!calls.some((c) => c[0] === "light.set"), "the light is court.ts's return beat, never set here");
});

test("only the video layer's opacity ever changes: never splat opacity (P10)", () => {
  const { calls, parts } = recorder();
  for (const t of frames(-0.45, HANDOFF_END)) handoff(t, parts);
  for (const t of frames(-0.1, HANDBACK_END)) handback(t, parts);
  assert.ok(!calls.some((c) => /opacity/i.test(c[0]) && c[0] !== "video.opacity"));
});
