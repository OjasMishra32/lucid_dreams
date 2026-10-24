import * as THREE from "three";

// WebCodecs streaming video: baked H.264 (Annex B, an access unit delimiter before every frame, no B-frames, an IDR
// with SPS/PPS at every 2 s segment start; make_streams.py), demuxed here, decoded by VideoDecoder with at most four
// frames decoded or in flight, and shown through THREE.VideoFrameTexture, exactly one new frame per display frame.

export const FPS = 72;
export const EASE_FROM_FRAME = 216; // the ease segment starts on main-stream frame 216 (3.0 s) and slows to a stop

// Vite serves these from src; literal URLs so the bundler can see them
const URLS = {
  "1440": new URL("./assets/wc-1440.h264", import.meta.url).href,
  "1440-ease": new URL("./assets/wc-1440-ease.h264", import.meta.url).href,
  "1080": new URL("./assets/wc-1080.h264", import.meta.url).href,
  "1080-ease": new URL("./assets/wc-1080-ease.h264", import.meta.url).href,
};

export type AccessUnit = { data: Uint8Array; key: boolean };
export type Stream = { name: string; url: string; bytes: number; units: AccessUnit[]; keys: number };

/** Splits an Annex B byte stream into access units at each access unit delimiter (NAL type 9). */
export function splitAnnexB(bytes: Uint8Array): AccessUnit[] {
  const units: AccessUnit[] = [];
  let auStart = -1;
  let key = false;
  const n = bytes.length;
  for (let i = 0; i + 3 < n; i++) {
    // no start code can begin at i, i+1 or i+2 unless bytes[i+2] is 0 or 1
    if (bytes[i + 2] > 1) {
      i += 2;
      continue;
    }
    if (bytes[i] !== 0 || bytes[i + 1] !== 0 || bytes[i + 2] !== 1) continue;
    const start = i > 0 && bytes[i - 1] === 0 ? i - 1 : i; // a four-byte start code
    const type = bytes[i + 3] & 0x1f;
    if (type === 9) {
      if (auStart >= 0) units.push({ data: bytes.subarray(auStart, start), key });
      auStart = start;
      key = false;
    } else if (type === 5) key = true;
    i += 3;
  }
  if (auStart >= 0) units.push({ data: bytes.subarray(auStart), key });
  return units;
}

export async function loadStream(name: keyof typeof URLS): Promise<Stream> {
  const url = URLS[name];
  const res = await fetch(url);
  if (!res.ok) throw new Error(`stream ${name}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const units = splitAnnexB(bytes);
  if (!units.length || !units[0].key) throw new Error(`stream ${name}: no access units, or the first is not an IDR`);
  return { name, url, bytes: bytes.byteLength, units, keys: units.filter((u) => u.key).length };
}

// ---------------- what the decoder says it can do ----------------

export type Candidate = { label: string; codec: string; width: number; height: number; stream: "1440" | "1080" };
// 1440p72 needs level 5.2 (5.1 tops out near 68 fps at 1440p); 5.1 is tried with the same 5.2 bitstream, which many
// decoders accept; 1080p72 fits level 5.0
export const CANDIDATES: Candidate[] = [
  { label: "1440p 5.2", codec: "avc1.640034", width: 2560, height: 1440, stream: "1440" },
  { label: "1440p 5.1", codec: "avc1.640033", width: 2560, height: 1440, stream: "1440" },
  { label: "1080p 5.0", codec: "avc1.640032", width: 1920, height: 1080, stream: "1080" },
];
export type Probe = Candidate & { supported: boolean | null; hardware: boolean | null; error?: string };

export const configOf = (c: Candidate, hardwareAcceleration: HardwareAcceleration = "no-preference"): VideoDecoderConfig => ({
  codec: c.codec, codedWidth: c.width, codedHeight: c.height, hardwareAcceleration, optimizeForLatency: true,
});

export async function probeDecoders(): Promise<Probe[]> {
  if (typeof VideoDecoder === "undefined") return CANDIDATES.map((c) => ({ ...c, supported: null, hardware: null, error: "no VideoDecoder" }));
  return Promise.all(
    CANDIDATES.map(async (c) => {
      try {
        const any = await VideoDecoder.isConfigSupported(configOf(c));
        const hw = await VideoDecoder.isConfigSupported(configOf(c, "prefer-hardware"));
        return { ...c, supported: !!any.supported, hardware: !!hw.supported };
      } catch (e) {
        return { ...c, supported: false, hardware: null, error: String(e).slice(0, 120) };
      }
    }),
  );
}

// ---------------- one decoder ----------------

export type Decoded = { frame: VideoFrame; index: number };

/** One VideoDecoder over one stream, kept at most `limit` frames ahead (decoded and waiting, plus in the decoder). */
export class StreamPlayer {
  readonly decoder: VideoDecoder;
  readonly ready: Decoded[] = [];
  decodeMs: number[] = []; // the page points this at the current phase's list
  readonly errors: string[] = [];
  readonly created = performance.now();
  firstOutputMs: number | null = null;
  maxOutstanding = 0;
  limit: number;
  limitRaised = false; // the decoder needed more than `limit` chunks in flight before it gave a frame back
  paused = false;
  private next = 0;
  private submitted = 0;
  private outputs = 0;
  private lastOutputAt = performance.now();
  private closed = false;
  private flushed = false;
  private sentAt = new Map<number, number>();

  constructor(readonly stream: Stream, config: VideoDecoderConfig, readonly loop: boolean, limit = 4) {
    this.limit = limit;
    this.decoder = new VideoDecoder({
      output: (frame) => this.onOutput(frame),
      error: (e) => this.errors.push(String(e).slice(0, 160)),
    });
    this.decoder.configure(config);
    this.pump();
  }

  get outstanding() {
    return this.submitted - this.outputs;
  }

  /** The decoder closed itself after an error (see `errors`). */
  get failed() {
    return !this.closed && this.decoder.state === "closed";
  }

  /** A segment that is not looped has shown its last frame (which then stays up: the freeze). */
  get ended() {
    return !this.loop && this.next >= this.stream.units.length && this.outstanding === 0 && this.ready.length === 0;
  }

  pump() {
    if (this.closed || this.paused || this.decoder.state !== "configured") return;
    const n = this.stream.units.length;
    while (this.ready.length + this.outstanding < this.limit && (this.loop || this.next < n)) {
      const unit = this.stream.units[this.next % n];
      const timestamp = Math.round((this.next * 1e6) / FPS);
      this.sentAt.set(timestamp, performance.now());
      try {
        this.decoder.decode(new EncodedVideoChunk({ type: unit.key ? "key" : "delta", timestamp, data: unit.data }));
      } catch (e) {
        this.errors.push(String(e).slice(0, 160));
        this.closed = true;
        return;
      }
      this.next++;
      this.submitted++;
      this.maxOutstanding = Math.max(this.maxOutstanding, this.outstanding);
    }
    // a hardware decoder may hold a segment's last frames until it is told there are no more
    if (!this.loop && !this.flushed && this.next >= n) {
      this.flushed = true;
      this.decoder.flush().catch((e: unknown) => {
        if (!this.closed) this.errors.push(`flush: ${String(e).slice(0, 120)}`);
      });
    }
  }

  private onOutput(frame: VideoFrame) {
    const now = performance.now();
    this.outputs++;
    this.lastOutputAt = now;
    if (this.closed) {
      frame.close();
      return;
    }
    const sent = this.sentAt.get(frame.timestamp);
    if (sent !== undefined) {
      this.decodeMs.push(now - sent);
      this.sentAt.delete(frame.timestamp);
    }
    if (this.firstOutputMs === null) this.firstOutputMs = now - this.created;
    this.ready.push({ frame, index: Math.round((frame.timestamp * FPS) / 1e6) });
    this.pump();
  }

  /** The next decoded frame, or null when none is ready yet. */
  take(): Decoded | null {
    const d = this.ready.shift() ?? null;
    const quiet = this.firstOutputMs === null ? 1500 : 250; // a hardware decoder's first frame can take a while
    if (!d && !this.paused && this.decoder.state === "configured" && this.outstanding >= this.limit && performance.now() - this.lastOutputAt > quiet) {
      // full, and nothing back: a decoder that holds more than `limit` chunks before it outputs would deadlock here,
      // so allow one more (and report it)
      this.limit++;
      this.limitRaised = true;
      this.lastOutputAt = performance.now();
    }
    this.pump();
    return d;
  }

  close() {
    this.closed = true;
    this.ready.splice(0).forEach((d) => d.frame.close());
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}

// ---------------- the layer the frames go on ----------------

export type LayerStats = {
  displayFrames: number; // display frames while a stream was the layer's source
  shown: number; // new video frames shown
  held: number; // display frames that kept the previous frame because the next was not decoded yet
  late: number; // frames that were not decoded in time for their display frame (each causes one or more holds)
  startup: number; // display frames before the first frame of a stream arrived
  readyMin: number; // fewest decoded frames waiting when a frame was taken
  uploadMs: number[]; // CPU ms of the texture upload (renderer.initTexture with the VideoFrame)
  heldAt: number[]; // display-frame numbers (within the phase) that were held
};

const freshStats = (): LayerStats => ({ displayFrames: 0, shown: 0, held: 0, late: 0, startup: 0, readyMin: Infinity, uploadMs: [], heldAt: [] });

/** One VideoFrameTexture fed from a StreamPlayer: one new frame per display frame, the previous closed after the upload. */
export class VideoLayer {
  readonly texture = new THREE.VideoFrameTexture();
  source: StreamPlayer | null = null;
  stats = freshStats();
  lastIndex = -1;
  lastSource: StreamPlayer | null = null; // the stream the frame on show came from
  private current: VideoFrame | null = null;
  private waiting = false;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false; // the proxies' UVs are flipped instead: no flip on upload
    this.texture.generateMipmaps = false;
  }

  resetStats() {
    const s = this.stats;
    this.stats = freshStats();
    return s;
  }

  /** Once per display frame, before rendering. */
  tick() {
    const src = this.source;
    if (!src) return;
    const s = this.stats;
    s.displayFrames++;
    if (this.current) s.readyMin = Math.min(s.readyMin, src.ready.length);
    const next = src.take();
    if (!next) {
      if (src.ended || src.failed) return; // a segment's last frame stays up by design; a failure is in src.errors
      if (!this.current) s.startup++;
      else {
        s.held++;
        s.heldAt.push(s.displayFrames);
        this.waiting = true;
      }
      return;
    }
    if (this.waiting) s.late++;
    this.waiting = false;
    const t = performance.now();
    try {
      this.texture.setFrame(next.frame);
      this.renderer.initTexture(this.texture); // uploads now, so the previous frame can be closed
    } catch (e) {
      next.frame.close();
      if (this.current) this.texture.setFrame(this.current);
      src.errors.push(`upload: ${String(e).slice(0, 120)}`);
      this.source = null;
      return;
    }
    s.uploadMs.push(performance.now() - t);
    this.current?.close();
    this.current = next.frame;
    this.lastIndex = next.index;
    this.lastSource = src;
    s.shown++;
  }

  release() {
    this.source = null;
    this.waiting = false;
  }

  dispose() {
    this.release();
    this.current?.close();
    this.current = null;
  }
}

/** A flat 16:9 quad with flipped V (the texture is uploaded without a flip). */
export function videoQuad(width: number, map: THREE.Texture, veil: boolean): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(width, (width * 9) / 16);
  const uv = geometry.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - uv.getY(k));
  // the window sits behind the players and depth-tests like the set; the veil is drawn last, over everything but the
  // HUD (the video layer over a 3D scene that is already drawn underneath)
  const material = new THREE.MeshBasicMaterial({ map, toneMapped: false, transparent: veil, depthTest: !veil, depthWrite: !veil });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = veil ? 6 : 0;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}
