// The show stream (3.3 step 1): two WebCodecs VideoDecoders on show.h264 (one playing, one primed with the next ease
// or the resume, so a press needs no reset or seek), at most four frames decoded or in flight, each VideoFrame closed
// after the next one is uploaded through THREE.VideoFrameTexture.setFrame(); exactly one show frame per display frame,
// holds counted (P4, P5). Also the feathered edge of the lit footage region following each frame's frustum, the
// replay wipe at a pass's end, and the `?video=element` (<video>, pass 1 only) and `?show=1080` / `?hz=90` fallbacks.
// The footage itself is drawn by proxies.ts: ShowVideo uploads each frame into proxies.texture. Stream D (`handoff`) builds it; S6's
// webcodecs.ts (StreamPlayer, VideoLayer) is the starting point and annexb.ts already splits the stream.
import * as THREE from "three";
import type { CourtBundle } from "./format";
import type { Proxies } from "./proxies";

/** True once stream D has built this module. */
export const BUILT = false;

/** `?show=1080` and `?hz=90` are chosen when the bundle loads (format.ts chooseStream): `bundle.court.video` is already that stream. */
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
  /** The show frame on the texture now (-1 before the first). */
  onScreen: number;
  errors: string[];
}

export class ShowVideo {
  readonly stats: VideoStats = { shown: 0, held: 0, heldAt: [], decodeMs: [], queueMax: 0, resets: 0, onScreen: -1, errors: [] };
  private layerOpacity = 1;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly bundle: CourtBundle;
  private readonly proxies: Proxies;
  private readonly options: ShowVideoOptions;

  constructor(renderer: THREE.WebGLRenderer, bundle: CourtBundle, proxies: Proxies, options: ShowVideoOptions = {}) {
    this.renderer = renderer;
    this.bundle = bundle;
    this.proxies = proxies;
    this.options = options;
  }

  /** The video layer's opacity over the 3D: 1 while watching and easing (opaque), 0 once the hand-off has faded it. */
  get opacity(): number {
    return this.layerOpacity;
  }

  set opacity(k: number) {
    this.layerOpacity = k;
    this.proxies.setOpacity(k); // the proxies are the video layer
  }

  /** The texture the proxies project (owned by Proxies): the show frame on screen. */
  get texture(): THREE.VideoFrameTexture {
    return this.proxies.texture;
  }

  /** Fetch the stream, check `isConfigSupported`, configure both decoders and decode pass 1's first frames. Stub: resolves. */
  async load(): Promise<void> {}

  /** Once per display frame, before rendering: put show frame `frame` (the clock's) on the texture. Stub: no-op. */
  show(frame: number): void {}

  /** The segment start the clock may jump to next (the next ease's first frame, or the resume's): the second decoder primes it. Stub: no-op. */
  prime(frame: number | null): void {}

  /** Same Pixels' hook: 0 = the lit region's usual ~10% feather, 1 = widened until the window dissolves into the world. Stub: no-op. */
  feather(p: number): void {}

  /** Depth Grows' hook (the plan's name for it): 0 = the players flat on their cards, 1 = on their splat-depth proxies. */
  depth(p: number): void {
    this.proxies.depth(p);
  }

  /** The replay wipe at a pass's end: 0 = the footage as filmed, 1 = dimmed to dark. Stub: no-op. */
  wipe(p: number): void {}

  dispose(): void {}
}
