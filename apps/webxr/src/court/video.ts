// The show stream (3.3 step 1): two WebCodecs VideoDecoders on show.h264 (one playing, one primed with the next
// jump, so a press needs no reset or seek), at most four frames decoded or in flight, each VideoFrame closed after
// the next one is uploaded through THREE.VideoFrameTexture.setFrame(); exactly one show frame per display frame, holds
// counted (P4, P5). Each stacked frame's three regions (court.video.regions: live, plate, mattes) are copied into their
// own mipmapped textures after the upload (no bleed across the atlas) and sampled trilinear: the footage spans ~820
// Quest pixels at the seat, so a ~1600-wide region would shimmer if minified without mips. Also the cinema mask (the
// lit region's feathered edge, which lifts at the hand-off) and the `?video=element` fallback (pass 1 on a <video>).
// `?show=small` and `?hz=90` are chosen when the bundle loads (format.ts chooseStream). The footage itself is drawn by
// proxies.ts from `regions`. Stream D (`handoff`) builds it; S6's webcodecs.ts and annexb.ts are the starting points.
import * as THREE from "three";
import type { CourtBundle } from "./format";

/** True once stream D has built this module. */
export const BUILT = false;

export interface ShowVideoOptions {
  /** `?video=element`: pass 1 on a <video> element with requestVideoFrameCallback (WebCodecs failed). */
  element?: boolean;
}

/** What the e2e and stats.ts read (P4, P5). */
export interface VideoStats {
  /** Display frames that showed a new show frame. */
  shown: number;
  /** Display frames that kept the previous frame because the wanted one wasn't decoded yet. */
  held: number;
  /** Show frames (stream indices) that were held. */
  heldAt: number[];
  /** Decode latency per frame, ms. */
  decodeMs: number[];
  /** Most frames decoded or in flight at once (P5: never over 4). */
  queueMax: number;
  /** Decoder resets or seeks (P5: none at a press). */
  resets: number;
  /** The show frame on the textures now (-1 before the first). */
  onScreen: number;
  errors: string[];
}

export class ShowVideo {
  /** The three regions of the show frame on screen, each its own mipmapped texture (trilinear). */
  readonly regions: { live: THREE.Texture; plate: THREE.Texture; mattes: THREE.Texture };
  readonly stats: VideoStats = { shown: 0, held: 0, heldAt: [], decodeMs: [], queueMax: 0, resets: 0, onScreen: -1, errors: [] };
  /** The video layer's opacity over the 3D (proxies.ts reads it): 1 while watching and easing, 0 once the hand-off has faded it. */
  opacity = 1;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly bundle: CourtBundle;
  private readonly options: ShowVideoOptions;

  constructor(renderer: THREE.WebGLRenderer, bundle: CourtBundle, options: ShowVideoOptions = {}) {
    this.renderer = renderer;
    this.bundle = bundle;
    this.options = options;
    const region = () => {
      const t = new THREE.Texture();
      t.colorSpace = THREE.SRGBColorSpace;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      return t;
    };
    this.regions = { live: region(), plate: region(), mattes: region() };
    this.regions.mattes.colorSpace = THREE.NoColorSpace;
  }

  /** Fetch the stream, check `isConfigSupported`, configure both decoders and decode pass 1's first frames. Stub: resolves. */
  async load(): Promise<void> {}

  /** Once per display frame, before rendering: put show frame `frame` (the clock's) on the region textures. Stub: no-op. */
  show(frame: number): void {}

  /** The next show frame the clock may jump to (ClockState.nextJump): the second decoder primes it. Stub: no-op. */
  prime(frame: number | null): void {}

  /** The cinema mask: 0 = the lit region's feathered edge as in the watch, 1 = lifted into the matched dark. Stub: no-op. */
  mask(p: number): void {}
}
