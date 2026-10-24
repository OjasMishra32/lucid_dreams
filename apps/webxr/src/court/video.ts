// The show stream (3.3 step 1): two WebCodecs VideoDecoders on show.h264 (one playing, one primed with the clock's
// next jump: the next ease, the repeat or the resume, so a press needs no reset or seek), at most four frames decoded
// or in flight per decoder, each VideoFrame closed only after the next one is uploaded through
// THREE.VideoFrameTexture.setFrame(); exactly one show frame per display frame at its display time: a frame not decoded
// in time holds the previous one (counted, P4) and is dropped once late, never shown late. A run decodes to its
// segment's end (pass 1 on through pass 2; an ease stops on F), so the freeze decodes nothing. Each stacked frame's
// three regions (court.video.regions: live, plate, mattes) are copied into their own mipmapped textures after the
// upload (no bleed across the atlas) and sampled trilinear: the footage spans ~820 Quest pixels at the seat, so a
// ~1600-wide region would shimmer if minified without mips. Also the video layer's state the proxies draw with: its
// opacity over the 3D, the cinema mask (the lit region's feathered edge, which lifts at the hand-off) and the replay
// wipe at a pass's end; and the `?video=element` fallback (pass 1 on a <video>). `?show=small` and `?hz=90` are chosen
// when the bundle loads (format.ts chooseStream). The footage itself is drawn by proxies.ts from `regions`. Stream D
// (`handoff`) builds it; S6's webcodecs.ts was the starting point. The decoders come through VideoEnv, so
// video.test.ts runs it under node with fakes.
import * as THREE from "three";
import { splitAnnexB, spsCodec, type AccessUnit } from "./annexb";
import type { CourtBundle, Region, ShowSegments } from "./format";

/** True once stream D has built this module. */
export const BUILT = true;

/** Frames decoded and waiting plus in flight, per decoder (P5: never over 4). */
export const QUEUE = 4;
/** The primed decoder decodes this far ahead of its jump target: ready at the switch, with two display frames of decode latency to spare. */
export const PRIME_QUEUE = 3;
/** The replay wipe between pass 1 and pass 2 (3.2: the window dims 9.1-9.5 s): down over the pass's end, up over the next start, seconds. */
export const WIPE_S = 0.2;
/** The window dims before the show's end (the resume's last frames, before A's next cut), seconds. */
export const END_DIM_S = 0.5;

/** The parts of WebCodecs' VideoDecoder the player uses (video.test.ts passes a fake). */
export interface DecoderLike {
  readonly state: CodecState;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  flush(): Promise<void>;
  close(): void;
}

/** Where the decoders and the bytes come from (the browser's by default). */
export interface VideoEnv {
  decoder(output: (frame: VideoFrame) => void, error: (e: unknown) => void): DecoderLike;
  chunk(init: EncodedVideoChunkInit): EncodedVideoChunk;
  supported(config: VideoDecoderConfig): Promise<boolean>;
  bytes(url: string): Promise<Uint8Array>;
  now(): number;
}

const browserEnv = (): VideoEnv => ({
  decoder: (output, error) => new VideoDecoder({ output, error: (e) => error(e) }),
  chunk: (init) => new EncodedVideoChunk(init),
  supported: async (config) => typeof VideoDecoder !== "undefined" && !!(await VideoDecoder.isConfigSupported(config)).supported,
  bytes: async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`show stream ${url}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  now: () => performance.now(),
});

/** `?show=small` and `?hz=90` are chosen when the bundle loads (format.ts chooseStream): `bundle.court.video` is already that stream. */
export interface ShowVideoOptions {
  /** `?video=element`: pass 1 on a <video> element with requestVideoFrameCallback (WebCodecs failed). */
  element?: boolean;
  /** The decoders and fetch (tests). */
  env?: VideoEnv;
}

/** What the e2e and stats.ts read (P4, P5). */
export interface VideoStats {
  /** Display frames that showed a new show frame. */
  shown: number;
  /** Display frames that kept the previous frame because the wanted one wasn't decoded yet. */
  held: number;
  /** Show frames (stream indices) that were held. */
  heldAt: number[];
  /** Show frames the clock stepped over (it steps round(dt x displayHz); P4 wants none). */
  skipped: number;
  /** Decoded frames closed unshown: late after a hold, or decoded past a jump. */
  dropped: number;
  /** Display frames before the first frame of the show was decoded. */
  startup: number;
  /** Decode latency per frame (submit to output), ms. */
  decodeMs: number[];
  /** CPU ms of each upload (texture and region copies). */
  uploadMs: number[];
  /** Most frames decoded or in flight at once on one decoder (P5: never over 4). */
  queueMax: number;
  /** Fewest frames decoded and waiting when a frame was taken, once running (P5: never empty, so >= 1). */
  queueMin: number;
  /** Seeks: jumps nothing was primed for (P5: none at a press). */
  resets: number;
  /** Decoder switches to the primed one (each press, repeat and resume). */
  switches: number;
  /** The show frame on the texture now (-1 before the first). */
  onScreen: number;
  errors: string[];
}

/** The last show frame a run starting at `start` decodes to: its segment's end; pass 1 runs on through pass 2. */
export function runEnd(seg: ShowSegments, start: number, frames: number): number {
  const inside = (r: [number, number]) => start >= r[0] && start <= r[1];
  if (inside(seg.pass1)) return seg.pass2[0] === seg.pass1[1] + 1 ? seg.pass2[1] : seg.pass1[1];
  if (inside(seg.pass2)) return seg.pass2[1];
  for (const e of seg.eases) if (inside(e.frames)) return e.frames[1];
  if (inside(seg.resume)) return seg.resume[1];
  return frames - 1;
}

interface Pending {
  index: number;
  stale: boolean;
  sentAt: number;
}

/** One decoder fed one contiguous run of show frames, at most `limit` decoded-and-waiting plus in flight. */
class Track {
  readonly ready: { index: number; frame: VideoFrame }[] = [];
  /** The show frame this run was started for (-1: idle). */
  target = -1;
  private readonly decoder: DecoderLike;
  private pending: Pending[] = [];
  private next = 0;
  private end = -1;
  private flushed = true;

  constructor(
    private readonly env: VideoEnv,
    private readonly units: AccessUnit[],
    private readonly hz: number,
    config: VideoDecoderConfig,
    public limit: number,
    private readonly stats: VideoStats,
    private readonly onReady: () => void = () => {},
  ) {
    this.decoder = env.decoder(
      (frame) => this.onOutput(frame),
      (e) => stats.errors.push(`decoder: ${String(e).slice(0, 160)}`),
    );
    this.decoder.configure(config);
  }

  /** Frames decoded and waiting plus in flight in the decoder (a dropped run's frames still coming out count too). */
  get queue(): number {
    return this.ready.length + this.pending.length;
  }

  /** The decoder closed itself after an error. */
  get failed(): boolean {
    return this.decoder.state === "closed";
  }

  /** True when this run can still show `frame` (it is ahead of what was taken, and within the run). */
  serves(frame: number): boolean {
    if (this.failed || this.target < 0 || frame > this.end) return false;
    const first = this.ready[0]?.index ?? this.pending.find((p) => !p.stale)?.index ?? this.next;
    return frame >= first;
  }

  /** Start a run for `frame` (from the IDR at or before it) to `end`; whatever the old run had is dropped. */
  run(frame: number, end: number): void {
    this.idle();
    let key = Math.min(frame, this.units.length - 1);
    while (key > 0 && !this.units[key].key) key--;
    this.target = frame;
    this.next = key;
    this.end = Math.min(end, this.units.length - 1);
    this.flushed = false;
    this.pump();
  }

  /** Drop the run: close the waiting frames, ignore the ones still in the decoder. */
  idle(): void {
    for (const r of this.ready.splice(0)) {
      r.frame.close();
      this.stats.dropped++;
    }
    for (const p of this.pending) p.stale = true;
    this.target = -1;
    this.end = -1;
  }

  pump(): void {
    if (this.decoder.state !== "configured") return;
    while (this.target >= 0 && this.queue < this.limit && this.next <= this.end) {
      const unit = this.units[this.next];
      const timestamp = Math.round((this.next * 1e6) / this.hz);
      try {
        this.decoder.decode(this.env.chunk({ type: unit.key ? "key" : "delta", timestamp, data: unit.data }));
      } catch (e) {
        this.stats.errors.push(`decode ${this.next}: ${String(e).slice(0, 160)}`);
        this.idle();
        return;
      }
      this.pending.push({ index: this.next, stale: false, sentAt: this.env.now() });
      this.next++;
      this.stats.queueMax = Math.max(this.stats.queueMax, this.queue);
    }
    // a hardware decoder may hold a run's last frames until it is told there are no more
    if (this.target >= 0 && !this.flushed && this.next > this.end) {
      this.flushed = true;
      this.decoder.flush().catch((e: unknown) => {
        if (this.decoder.state !== "closed") this.stats.errors.push(`flush: ${String(e).slice(0, 120)}`);
      });
    }
  }

  private onOutput(frame: VideoFrame): void {
    const index = Math.round((frame.timestamp * this.hz) / 1e6);
    // -bf 0: frames come out in the order they went in, one per chunk
    let k = this.pending.findIndex((p) => Math.round((p.index * 1e6) / this.hz) === frame.timestamp);
    if (k < 0) k = 0;
    const [p] = this.pending.splice(k, 1);
    if (!p || p.stale || index !== p.index) {
      frame.close();
      if (p && !p.stale) this.stats.dropped++;
    } else {
      this.stats.decodeMs.push(this.env.now() - p.sentAt);
      if (index < this.target) {
        frame.close(); // decoded from the IDR before the run's first frame
        this.stats.dropped++;
      } else {
        this.ready.push({ index, frame });
        this.onReady();
      }
    }
    this.pump();
  }

  /** The decoded frame for `frame` (frames before it are closed as late), or null when it isn't decoded yet. */
  take(frame: number): VideoFrame | null {
    while (this.ready.length && this.ready[0].index < frame) {
      this.ready.shift()!.frame.close();
      this.stats.dropped++;
    }
    const got = this.ready[0]?.index === frame ? this.ready.shift()!.frame : null;
    this.pump();
    return got;
  }

  close(): void {
    this.idle();
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}

const BLIT_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
// the frame is uploaded without a flip (row 0 = the frame's top); targets are written bottom-up, as three samples them
const BLIT_FRAG = /* glsl */ `
  uniform sampler2D uMap; uniform vec4 uRect; varying vec2 vUv;
  void main() { gl_FragColor = texture2D(uMap, vec2(uRect.x + vUv.x * uRect.z, uRect.y + (1.0 - vUv.y) * uRect.w)); }`;

type RegionName = "live" | "plate" | "mattes";

export class ShowVideo {
  /**
   * The three regions of the show frame on screen, each its own mipmapped texture (trilinear). Raw bytes: the colour
   * space is NoColorSpace and proxies.ts decodes sRGB itself, so the light field multiplies in linear light exactly.
   */
  readonly regions: { live: THREE.Texture; plate: THREE.Texture; mattes: THREE.Texture };
  readonly stats: VideoStats = {
    shown: 0, held: 0, heldAt: [], skipped: 0, dropped: 0, startup: 0, decodeMs: [], uploadMs: [], queueMax: 0,
    queueMin: Infinity, resets: 0, switches: 0, onScreen: -1, errors: [],
  };
  private readonly renderer: THREE.WebGLRenderer;
  private readonly bundle: CourtBundle;
  private readonly options: ShowVideoOptions;
  private readonly env: VideoEnv;
  /** The whole stacked frame, uploaded as it is (raw, no flip, no mips): the regions are copied out of it. */
  private readonly frameTexture = new THREE.VideoFrameTexture();
  private readonly targets: Record<RegionName, THREE.WebGLRenderTarget>;
  private readonly blitScene = new THREE.Scene();
  private readonly blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly blitMaterial: THREE.ShaderMaterial;
  private readonly listeners: (() => void)[] = [];
  private layerOpacity = 1;
  private maskP = 0;
  private wipeAuto = 0;
  private wipeOverride = 0;
  private tracks: [Track, Track] | null = null;
  /** Makes a decoder track (load sets it; a track whose decoder closed itself is replaced with a new one). */
  private makeTrack: ((limit: number) => Track) | null = null;
  private current: VideoFrame | null = null;
  private element: HTMLVideoElement | null = null;

  constructor(renderer: THREE.WebGLRenderer, bundle: CourtBundle, options: ShowVideoOptions = {}) {
    this.renderer = renderer;
    this.bundle = bundle;
    this.options = options;
    this.env = options.env ?? browserEnv();
    const t = this.frameTexture;
    t.colorSpace = THREE.NoColorSpace; // decoded bytes are already sRGB: kept raw end to end
    t.flipY = false;
    t.generateMipmaps = false;
    t.minFilter = t.magFilter = THREE.NearestFilter;
    const aniso = Math.min(8, renderer?.capabilities?.getMaxAnisotropy() ?? 1);
    const target = ([, , w, h]: Region, anisotropy: number) => {
      const rt = new THREE.WebGLRenderTarget(w, h, {
        generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, colorSpace: THREE.NoColorSpace,
      });
      rt.texture.anisotropy = anisotropy;
      return rt;
    };
    const r = bundle.court.video.regions;
    // the matte atlas is sampled at a clamped lod per tile (proxies.ts), never anisotropic
    this.targets = { live: target(r.live, aniso), plate: target(r.plate, aniso), mattes: target(r.mattes, 1) };
    this.regions = { live: this.targets.live.texture, plate: this.targets.plate.texture, mattes: this.targets.mattes.texture };
    this.blitMaterial = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.frameTexture }, uRect: { value: new THREE.Vector4() } },
      vertexShader: BLIT_VERT,
      fragmentShader: BLIT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const blit = new THREE.Mesh(tri, this.blitMaterial);
    blit.frustumCulled = false;
    this.blitScene.add(blit);
  }

  /** The video layer's opacity over the 3D (proxies.ts reads it): 1 while watching and easing, 0 once the hand-off has faded it. */
  get opacity(): number {
    return this.layerOpacity;
  }

  set opacity(k: number) {
    this.layerOpacity = Math.min(1, Math.max(0, k));
    this.changed();
  }

  /** The cinema mask now (mask(p)'s p): 0 = the watch's feathered edge, 1 = lifted. */
  get maskLevel(): number {
    return this.maskP;
  }

  /** The replay wipe now: 0 = the footage as filmed, 1 = dimmed to dark. */
  get wipeLevel(): number {
    return Math.max(this.wipeAuto, this.wipeOverride);
  }

  /** Called whenever opacity, the mask, the wipe or the frame on the textures change (proxies.ts keeps its layers in step). */
  listen(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** Fetch the stream, check it and `isConfigSupported`, configure both decoders and decode pass 1's first frames. */
  async load(): Promise<void> {
    const v = this.bundle.court.video;
    if (this.options.element) return this.loadElement();
    const config: VideoDecoderConfig = { codec: v.codec, codedWidth: v.width, codedHeight: v.height, optimizeForLatency: true };
    if (!(await this.env.supported(config))) {
      const msg = `this browser can't decode ${v.codec} at ${v.width}x${v.height}`;
      if (v.fallbacks.element) {
        console.warn(`Court Side: ${msg}; playing pass 1 on a <video> (?video=element)`);
        return this.loadElement();
      }
      throw new Error(msg);
    }
    const bytes = await this.env.bytes(this.bundle.file(v.file));
    const units = splitAnnexB(bytes);
    const frames = this.bundle.frames.length;
    if (units.length < frames) throw new Error(`${v.file}: ${units.length} access units for ${frames} show frames`);
    const seg = v.segments;
    const starts = [seg.pass1[0], seg.pass2[0], seg.resume[0], ...seg.eases.map((e) => e.frames[0])];
    const notKey = starts.filter((i) => !units[i]?.key);
    if (notKey.length) throw new Error(`${v.file}: no IDR at segment start ${notKey.join(", ")}`);
    const sps = spsCodec(bytes);
    if (sps && sps.codec.slice(0, 7) !== v.codec.slice(0, 7))
      this.stats.errors.push(`${v.file}: the stream's SPS says ${sps.codec}, court.json says ${v.codec}`);
    const hz = v.displayHz;
    this.makeTrack = (limit) => new Track(this.env, units, hz, config, limit, this.stats, () => this.first());
    this.tracks = [this.makeTrack(QUEUE), this.makeTrack(PRIME_QUEUE)];
    this.tracks[0].run(seg.pass1[0], runEnd(seg, seg.pass1[0], frames));
  }

  /** Once per display frame, before rendering: put show frame `frame` (the clock's) on the region textures. */
  show(frame: number): void {
    this.applyWipe(frame);
    if (this.element) return this.showElement(frame);
    if (!this.tracks || frame === this.stats.onScreen) return; // the freeze (or a zero step) holds by design
    this.replaceFailed();
    let [playing, spare] = this.tracks;
    const seg = this.bundle.court.video.segments;
    if (!playing.serves(frame)) {
      // the primed decoder takes the jump, even when the clock stepped onto its second frame
      if (spare.serves(frame)) {
        this.tracks = [spare, playing];
        [playing, spare] = this.tracks;
        playing.limit = QUEUE;
        spare.limit = PRIME_QUEUE;
        spare.idle();
        this.stats.switches++;
      } else {
        if (this.stats.onScreen >= 0) this.stats.resets++;
        playing.run(frame, runEnd(seg, frame, this.bundle.frames.length));
      }
    } else if (this.stats.onScreen >= 0 && frame > this.stats.onScreen + 1 && playing.target <= this.stats.onScreen) this.stats.skipped += frame - this.stats.onScreen - 1;
    const waiting = playing.ready.length;
    const next = playing.take(frame);
    if (!next) {
      if (this.stats.onScreen < 0) this.stats.startup++;
      else {
        this.stats.held++;
        this.stats.heldAt.push(frame);
      }
      return;
    }
    if (this.stats.onScreen >= 0) this.stats.queueMin = Math.min(this.stats.queueMin, waiting);
    this.upload(next, frame);
  }

  /** The show frame the clock may jump to next (ClockState.nextJump: the next ease's first frame, the repeat, the resume): the second decoder primes it. */
  prime(frame: number | null): void {
    if (!this.tracks || frame === null) return;
    this.replaceFailed();
    const [playing, spare] = this.tracks;
    if (spare.target === frame || playing.serves(frame)) return;
    spare.run(frame, runEnd(this.bundle.court.video.segments, frame, this.bundle.frames.length));
  }

  /**
   * The show's first frame goes up as soon as it is decoded (during the arrival, before the session draws), so the
   * watch's first display frame shows it without a hold (P5) and the arrival's lights come up on it. Never inside the
   * headset's session: there only show() uploads, inside the frame.
   */
  private first(): void {
    if (this.stats.onScreen >= 0 || !this.tracks || this.renderer?.xr?.isPresenting) return;
    const start = this.bundle.court.video.segments.pass1[0];
    const playing = this.tracks[0];
    if (playing.target !== start || playing.ready[0]?.index !== start) return;
    const frame = playing.take(start);
    if (frame) this.upload(frame, start);
  }

  /** A decoder that closed itself (a decode error, or the browser reclaiming it) never outputs again: swap in a new one. */
  private replaceFailed(): void {
    if (!this.tracks || !this.makeTrack) return;
    const [playing, spare] = this.tracks;
    for (const [i, t] of [[0, playing], [1, spare]] as const)
      if (t.failed) {
        t.close();
        this.tracks[i] = this.makeTrack(i === 0 ? QUEUE : PRIME_QUEUE);
        this.stats.errors.push(`decoder ${i === 0 ? "playing" : "primed"} closed itself; replaced`);
      }
  }

  /** The cinema mask: 0 = the lit region's feathered edge as in the watch, 1 = lifted into the matched dark. */
  mask(p: number): void {
    this.maskP = Math.min(1, Math.max(0, p));
    this.changed();
  }

  /** The replay wipe, on top of the automatic one at the passes' ends: 0 = the footage as filmed, 1 = dimmed to dark. */
  wipe(p: number): void {
    this.wipeOverride = p;
    this.changed();
  }

  dispose(): void {
    this.tracks?.forEach((t) => t.close());
    this.tracks = null;
    this.current?.close();
    this.current = null;
    if (this.element) {
      this.element.pause();
      this.element.removeAttribute("src");
      this.element = null;
    }
    for (const t of Object.values(this.targets)) t.dispose();
    this.blitMaterial.dispose();
    this.frameTexture.dispose();
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** Upload the stacked frame, copy each region into its own mipmapped texture, then close the frame it replaces. */
  private upload(frame: VideoFrame, index: number): void {
    const t = this.env.now();
    const r = this.renderer;
    const xrOn = r.xr.enabled;
    const prev = r.getRenderTarget();
    try {
      this.frameTexture.setFrame(frame);
      r.initTexture(this.frameTexture); // uploads now
      const { width: W, height: H, regions } = this.bundle.court.video;
      r.xr.enabled = false; // an offscreen pass: three would swap in the XR camera otherwise
      for (const name of ["live", "plate", "mattes"] as const) {
        const [x, y, w, h] = regions[name];
        (this.blitMaterial.uniforms.uRect.value as THREE.Vector4).set(x / W, y / H, w / W, h / H);
        r.setRenderTarget(this.targets[name]);
        r.render(this.blitScene, this.blitCamera); // three makes the target's mipmaps after the render
      }
    } catch (e) {
      frame.close();
      this.stats.errors.push(`upload ${index}: ${String(e).slice(0, 120)}`);
      return;
    } finally {
      r.setRenderTarget(prev);
      r.xr.enabled = xrOn;
    }
    this.stats.uploadMs.push(this.env.now() - t);
    this.current?.close();
    this.current = frame;
    this.stats.onScreen = index;
    this.stats.shown++;
    this.changed();
  }

  /** The automatic replay wipe: pass 1's last WIPE_S down, pass 2's first WIPE_S up, pass 2's last WIPE_S down (it repeats), the resume's last END_DIM_S down. */
  private applyWipe(frame: number): void {
    const v = this.bundle.court.video;
    const seg = v.segments;
    const n = Math.max(1, Math.round(WIPE_S * v.displayHz));
    const end = Math.max(1, Math.round(END_DIM_S * v.displayHz));
    const down = (last: number, len: number) => Math.min(1, Math.max(0, (frame - (last - len)) / len));
    const up = (first: number) => Math.min(1, Math.max(0, 1 - (frame - first) / n));
    let w = 0;
    if (frame >= seg.pass1[0] && frame <= seg.pass1[1]) w = down(seg.pass1[1], n);
    else if (frame >= seg.pass2[0] && frame <= seg.pass2[1]) w = Math.max(up(seg.pass2[0]), down(seg.pass2[1], n));
    else if (frame >= seg.resume[0] && frame <= seg.resume[1]) w = down(seg.resume[1], end);
    if (w !== this.wipeAuto) {
      this.wipeAuto = w;
      this.changed();
    }
  }

  // ---------------- ?video=element: pass 1 on a <video> (WebCodecs failed) ----------------

  private async loadElement(): Promise<void> {
    const v = this.bundle.court.video;
    if (!v.fallbacks.element) throw new Error("?video=element: the bundle has no video.fallbacks.element");
    const el = document.createElement("video");
    el.src = this.bundle.file(v.fallbacks.element);
    el.muted = true;
    el.playsInline = true;
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    await new Promise<void>((ok, fail) => {
      el.addEventListener("loadeddata", () => ok(), { once: true });
      el.addEventListener("error", () => fail(new Error(`?video=element: ${v.fallbacks.element} did not load`)), { once: true });
    });
    this.element = el;
  }

  /** Pass 1 only: the element plays at 1x from the first pass-1 frame shown; each display frame uploads what it shows. */
  private showElement(frame: number): void {
    const el = this.element!;
    const seg = this.bundle.court.video.segments;
    if (frame < seg.pass1[0] || frame > seg.pass1[1]) return; // the element carries pass 1 only
    if (el.paused) void el.play().catch((e: unknown) => this.stats.errors.push(`element play: ${String(e).slice(0, 120)}`));
    if (el.readyState < 2) {
      this.stats.held++;
      this.stats.heldAt.push(frame);
      return;
    }
    const index = Math.min(seg.pass1[1], seg.pass1[0] + Math.round(el.currentTime * this.bundle.court.video.displayHz));
    if (index === this.stats.onScreen) return;
    this.upload(new VideoFrame(el, { timestamp: Math.round((index * 1e6) / this.bundle.court.video.displayHz) }), index);
  }
}
