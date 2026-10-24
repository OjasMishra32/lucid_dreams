// video.ts: the two-decoder show player under node, with fake decoders (no WebCodecs): one show frame per display
// frame (P4), at most four frames decoded or in flight and never an empty queue once running (P5), each frame
// closed only after the next is uploaded, the primed decoder taking a jump with 0 held frames and no reset, the
// freeze held without decoding, and an unprimed jump counted as a seek.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./ts-resolve.mjs";
import type { DecoderLike, VideoEnv } from "../../src/court/video.ts";
import type { CourtBundle, ShowSegments } from "../../src/court/format.ts";

const { ShowVideo, runEnd } = await import("../../src/court/video.ts");

const HZ = 72;
// pass1 [0, 59], pass2 [60, 159], ease 0 [160, 189] entered from 100, ease 1 [190, 209] from 110, resume [210, 259]
const SEGMENTS: ShowSegments = {
  pass1: [0, 59],
  pass2: [60, 159],
  resume: [210, 259],
  eases: [
    { start: 100, frames: [160, 189], seconds: 30 / HZ },
    { start: 110, frames: [190, 209], seconds: 20 / HZ },
  ],
};
const N = 260;
const KEYS = new Set([0, 60, 160, 190, 210]);

/** Frames the fake decoders made, so the test can see which were closed. */
class FakeFrame {
  closed = false;
  constructor(readonly timestamp: number) {}
  close() {
    assert.ok(!this.closed, `frame ${this.timestamp} closed twice`);
    this.closed = true;
  }
}

/** A decoder that outputs each chunk `delay` pump() calls after it was given (0 = on the next microtask flush). */
class FakeDecoder implements DecoderLike {
  state: CodecState = "unconfigured";
  queue: { timestamp: number; key: boolean; age: number }[] = [];
  configs = 0;
  resets = 0;
  needKey = true;
  constructor(readonly output: (f: VideoFrame) => void, readonly world: World) {
    world.decoders.push(this);
  }
  configure() {
    this.state = "configured";
    this.configs++;
    this.needKey = true;
  }
  decode(chunk: EncodedVideoChunk) {
    const c = chunk as unknown as { timestamp: number; type: string };
    if (this.needKey) assert.equal(c.type, "key", "after configure or flush the first chunk must be a key frame");
    this.needKey = false;
    this.queue.push({ timestamp: c.timestamp, key: c.type === "key", age: 0 });
  }
  async flush() {
    this.drain(true);
    this.needKey = true;
  }
  reset() {
    this.resets++;
    this.queue = [];
  }
  close() {
    this.state = "closed";
  }
  /** Emit every chunk old enough (or all of them). */
  drain(all = false) {
    while (this.queue.length && (all || this.queue[0].age >= this.world.delay)) {
      const c = this.queue.shift()!;
      const f = new FakeFrame(c.timestamp);
      this.world.frames.push(f);
      this.output(f as unknown as VideoFrame);
    }
    for (const c of this.queue) c.age++;
  }
}

interface World {
  decoders: FakeDecoder[];
  frames: FakeFrame[];
  delay: number;
}

function setup(delay = 0) {
  const world: World = { decoders: [], frames: [], delay };
  // a fake Annex B stream: an access unit delimiter, then an IDR or a P slice, per show frame
  const bytes = new Uint8Array(Array.from({ length: N }, (_, i) => [0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, KEYS.has(i) ? 0x65 : 0x41, 0x88, i & 255]).flat());
  const env: VideoEnv = {
    decoder: (output) => new FakeDecoder(output, world),
    chunk: (init) => init as unknown as EncodedVideoChunk,
    supported: async () => true,
    bytes: async () => bytes,
    now: () => 0,
  };
  const uploads: { index: number; frame: FakeFrame }[] = [];
  /** The renderer: initTexture uploads the show frame; each region is blitted into its own target. */
  const blits: { target: unknown; xr: boolean }[] = [];
  let bound: unknown = "the XR framebuffer";
  const renderer = {
    xr: { enabled: true },
    capabilities: { getMaxAnisotropy: () => 16 },
    getRenderTarget: () => bound,
    setRenderTarget: (t: unknown) => void (bound = t),
    render: () => void blits.push({ target: bound, xr: renderer.xr.enabled }),
    initTexture: (t: { image: unknown }) => {
      const f = t.image as FakeFrame;
      const index = Math.round((f.timestamp * HZ) / 1e6);
      assert.ok(!f.closed, `frame ${index} uploaded after it was closed`);
      // the previous frame stays open until this one is up
      if (uploads.length) assert.ok(!uploads[uploads.length - 1].frame.closed, "the previous frame was closed before the next upload");
      uploads.push({ index, frame: f });
    },
  };
  const bundle = {
    base: "/",
    court: {
      video: {
        file: "video/show.h264", codec: "avc1.640033", width: 1536, height: 2160, displayHz: HZ, segments: SEGMENTS,
        regions: { live: [0, 0, 1536, 864], plate: [0, 864, 1536, 864], mattes: [0, 1728, 1536, 432] }, fallbacks: {},
      },
    },
    frames: Array.from({ length: N }, () => ({ src: 0, interp: false, q: [0, 0, 0, 1], f: 1 })),
    cards: Array.from({ length: N }, () => ({ cards: [] })),
    file: (p: string) => p,
  } as unknown as CourtBundle;
  const video = new ShowVideo(renderer as never, bundle, { env });
  /** One display frame: the decoders run between frames (as they do on a real device), then show(). */
  const display = (frame: number, prime: number | null = null) => {
    for (const d of world.decoders) d.drain();
    video.show(frame);
    video.prime(prime);
  };
  /** Let the decoders run for n display frames before the watch starts (the arrival's 2.5 s). */
  const warm = (n = 8) => {
    for (let k = 0; k < n; k++) for (const d of world.decoders) d.drain();
  };
  return { world, video, uploads, display, warm, blits, renderer, bound: () => bound };
}

test("runEnd: a run decodes to its segment's end, pass 1 on through pass 2, an ease stops on F", () => {
  assert.equal(runEnd(SEGMENTS, 0, N), 159);
  assert.equal(runEnd(SEGMENTS, 70, N), 159);
  assert.equal(runEnd(SEGMENTS, 160, N), 189);
  assert.equal(runEnd(SEGMENTS, 190, N), 209);
  assert.equal(runEnd(SEGMENTS, 210, N), 259);
});

test("pass 1 into pass 2: one new frame per display frame, queue 1-4, nothing held, nothing skipped", async () => {
  const { video, uploads, display } = setup();
  await video.load();
  for (let i = 0; i <= 159; i++) display(i);
  assert.deepEqual(uploads.map((u) => u.index), Array.from({ length: 160 }, (_, i) => i));
  const s = video.stats;
  assert.equal(s.held, 0);
  assert.equal(s.skipped, 0);
  assert.equal(s.resets, 0);
  assert.ok(s.queueMax <= 4, `queue max ${s.queueMax}`);
  assert.ok(s.queueMin >= 1, `queue min ${s.queueMin}`);
  // every frame but the one on screen is closed
  assert.ok(uploads.slice(0, -1).every((u) => u.frame.closed));
  assert.ok(!uploads[uploads.length - 1].frame.closed);
});

test("a press: the primed decoder takes the ease with 0 held frames and no reset, lands on F and holds it", async () => {
  const { world, video, uploads, display } = setup();
  await video.load();
  for (let i = 0; i <= 100; i++) display(i, i >= 60 ? 160 : null); // pass 2 primes ease 0
  for (let i = 160; i <= 189; i++) display(i, 210); // the ease, priming the resume
  for (let k = 0; k < 50; k++) display(189, 210); // the freeze
  const s = video.stats;
  assert.equal(s.held, 0, `held at ${s.heldAt}`);
  assert.equal(s.resets, 0);
  assert.equal(uploads[uploads.length - 1].index, 189);
  assert.equal(uploads.filter((u) => u.index === 189).length, 1, "F uploaded once, then held without new uploads");
  // while frozen, nothing past F is decoded on the playing decoder
  assert.ok(!world.frames.some((f) => Math.round((f.timestamp * HZ) / 1e6) > 189 && Math.round((f.timestamp * HZ) / 1e6) < 210), "no frames past F decoded");
  // the resume: primed, no hold
  for (let i = 210; i <= 259; i++) display(i);
  assert.equal(video.stats.held, 0);
  assert.equal(video.stats.resets, 0);
  assert.equal(world.decoders.length, 2, "two decoders, never a third");
  assert.ok(world.decoders.every((d) => d.configs === 1 && d.resets === 0), "each configured once, never reset");
  assert.ok(video.stats.queueMax <= 4);
});

test("a slow decoder (2 display frames of latency) still never holds with the 4-frame queue, primed jumps included", async () => {
  const { video, display, warm } = setup(2);
  await video.load();
  warm();
  for (let i = 0; i <= 100; i++) display(i, i >= 60 ? 160 : null);
  for (let i = 160; i <= 189; i++) display(i, 210);
  for (let k = 0; k < 20; k++) display(189, 210);
  for (let i = 210; i <= 259; i++) display(i);
  assert.equal(video.stats.held, 0, `held at ${video.stats.heldAt}`);
  assert.ok(video.stats.queueMax <= 4);
});

test("a decoder that can't keep up holds the previous frame, counts it, and drops the late one to stay on time", async () => {
  const { video, uploads, display, warm } = setup(6);
  await video.load();
  warm();
  for (let i = 0; i <= 40; i++) display(i);
  const s = video.stats;
  assert.ok(s.held > 0, "holds are counted");
  assert.equal(s.heldAt.length, s.held);
  // shown frames only ever move forward
  for (let k = 1; k < uploads.length; k++) assert.ok(uploads[k].index > uploads[k - 1].index);
});

test("an unprimed jump (restart) is a seek: counted, then it plays on", async () => {
  const { video, uploads, display } = setup();
  await video.load();
  for (let i = 0; i <= 80; i++) display(i);
  for (let i = 0; i <= 20; i++) display(i); // back to pass 1 with nothing primed
  assert.equal(video.stats.resets, 1);
  assert.equal(uploads[uploads.length - 1].index, 20);
});

test("a clock step of two frames skips one and says so", async () => {
  const { video, display } = setup();
  await video.load();
  for (let i = 0; i <= 30; i++) display(i);
  display(32);
  assert.equal(video.stats.skipped, 1);
  assert.equal(video.stats.onScreen, 32);
});

test("every repeat of pass 2 is primed, not just the first: no seek on the second repeat", async () => {
  const { video, display } = setup();
  await video.load();
  for (let i = 0; i <= 159; i++) display(i, i >= 100 ? 60 : null); // to pass 2's end, the repeat primed
  for (let i = 60; i <= 159; i++) display(i, i >= 100 ? 60 : null); // the first repeat
  for (let i = 60; i <= 80; i++) display(i); // the second
  assert.equal(video.stats.resets, 0, "no seek");
  assert.equal(video.stats.held, 0, `held at ${video.stats.heldAt}`);
  assert.equal(video.stats.switches, 2);
});

test("a clock step of two frames onto a jump still takes the primed decoder", async () => {
  const { video, display } = setup();
  await video.load();
  for (let i = 0; i <= 100; i++) display(i, i >= 60 ? 160 : null);
  display(161, 210); // stepped over the ease's first frame
  assert.equal(video.stats.resets, 0);
  assert.equal(video.stats.switches, 1);
  assert.equal(video.stats.onScreen, 161);
});

test("a decoder that closes itself (an error, the browser reclaiming it) is replaced: one seek, then it plays on", async () => {
  const { world, video, display } = setup();
  await video.load();
  for (let i = 0; i <= 12; i++) display(i);
  const playing = world.decoders.find((d) => d.queue.length > 0) ?? world.decoders[0];
  playing.state = "closed";
  playing.queue = [];
  for (let i = 13; i <= 40; i++) display(i);
  assert.ok(video.stats.resets <= 1, `${video.stats.resets} seeks`);
  assert.equal(video.stats.onScreen, 40, "playing again");
  assert.ok(video.stats.held <= 2, `held ${video.stats.held}`);
});

test("each upload copies live, plate and mattes into their own mipmapped textures, off the XR framebuffer", async () => {
  const { video, display, warm, blits, renderer, bound } = setup();
  const { live, plate, mattes } = video.regions;
  assert.ok(live !== plate && plate !== mattes && live !== mattes, "three textures");
  for (const t of [live, plate, mattes]) assert.equal(t.minFilter, 1008 /* LinearMipmapLinearFilter */, "trilinear");
  await video.load();
  warm();
  display(0);
  assert.equal(video.stats.onScreen, 0);
  assert.equal(blits.length, 3, "one copy per region");
  assert.ok(blits.every((b) => !b.xr), "XR off during the copies (three would swap in the XR camera)");
  assert.equal(renderer.xr.enabled, true, "and back on after");
  assert.equal(bound(), "the XR framebuffer", "the render target is restored");
  const targets = new Set(blits.map((b) => (b.target as { texture: unknown }).texture));
  assert.deepEqual(targets, new Set([live, plate, mattes]));
  display(0);
  assert.equal(blits.length, 3, "a held frame copies nothing");
});

test("the layer's state: opacity and the mask (0 = the watch's edge, 1 = lifted) reach whoever listens, the wipe follows the passes", async () => {
  const { video, display, warm } = setup();
  const heard: number[] = [];
  video.listen(() => heard.push(video.opacity));
  assert.equal(video.opacity, 1);
  assert.equal(video.maskLevel, 0, "the watch's edge");
  video.opacity = 0.25;
  video.mask(0.5);
  assert.equal(video.opacity, 0.25);
  assert.equal(video.maskLevel, 0.5);
  assert.deepEqual(heard, [0.25, 0.25]);
  await video.load();
  warm();
  for (let f = 0; f <= 59; f++) display(f);
  assert.ok(video.wipeLevel > 0.9, "pass 1's last frames dim (the replay wipe)");
  display(60);
  assert.ok(video.wipeLevel > 0.9, "pass 2's first frames come up from dark");
  for (let f = 61; f <= 100; f++) display(f);
  assert.equal(video.wipeLevel, 0, "as filmed mid pass 2");
});

test("the show's first frame is on the textures as soon as it decodes (the arrival): the watch's first display frame shows it without a hold", async () => {
  const { video, warm, display, uploads } = setup();
  let heard = 0;
  video.listen(() => heard++);
  await video.load();
  warm(2);
  assert.equal(video.stats.onScreen, 0, "up before any show()");
  assert.equal(uploads.length, 1);
  assert.ok(heard >= 1, "the proxies hear of it (they project it with its own camera and cards)");
  display(0);
  display(1);
  assert.equal(video.stats.startup, 0);
  assert.equal(video.stats.held, 0);
  assert.deepEqual(uploads.map((u) => u.index), [0, 1]);
});

test("in the headset nothing is uploaded from the decoder's callback: only show() uploads, inside the frame", async () => {
  const { video, warm, display, uploads, renderer } = setup();
  (renderer.xr as { isPresenting?: boolean }).isPresenting = true;
  await video.load();
  warm(2);
  assert.equal(uploads.length, 0);
  display(0);
  assert.equal(video.stats.onScreen, 0);
});
