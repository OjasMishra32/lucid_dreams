// The court bundle format: the types of court.json, video/frames.json and video/cards.json, a validator that names every
// bad field in plain words, and loadCourt (fetch + validate). DOM-free and dependency-free (it runs under node --test and
// in the page alike), so it is also the reference for a Unity or visionOS reader: README.md beside this file documents
// it with a worked example. Owned by the integrator; a change here is a contract change for every stream.
//
// Conventions used by every field below:
// - Court space: metres; origin at centre court on the floor; +Y up; +X toward the basket the play attacks; +Z to the
//   right when facing +X (right-handed). Every position in the bundle is in court space unless it says otherwise.
// - Show frames: the baked stream's frames, 0-based; show frame i is displayed at t = i / video.displayHz.
// - Source frames: the source clip's own frame numbers (at camera.sourceFps), fractional for an in-between. One second
//   of real action is camera.sourceFps x camera.slow source frames; camera.captureFps is the capture's own rate, which
//   says which display frames can be real.
// - Cameras: OpenCV axes (+x right, +y down, +z forward), world-from-camera rotation, intrinsics in source pixels
//   (camera.width x camera.height), pixel centres at whole numbers. An image of the frame of another width w (the live
//   or plate region, freeze.png) is scaled by s = w / camera.width as u' = (u + 0.5) s - 0.5 (camera.ts `scaled`).
// - Stream pixels: each show frame stacks three regions (video.regions): the live frame, its background plate (the
//   live frame with every person replaced from a fixed-centre pan mosaic) and the matte atlas. A fallback stream keeps
//   the same layout scaled by its width / video.width.
// - Paths are relative to court.json's folder, never absolute, never "..", never a URL.
// - Unknown fields are ignored, so the format can grow (as every Lucid Dreams contract does).

/** A point in court space, metres: [x, y, z]. */
export type Vec3 = [number, number, number];
/** A unit quaternion [x, y, z, w]. */
export type Quat = [number, number, number, number];
/** An inclusive range of show frames: [first, last]. */
export type FrameRange = [number, number];
/** A rectangle in stream pixels: [x, y, width, height], from the stream's top-left corner. */
export type Region = [number, number, number, number];
/** A box in an image's own pixels: [x0, y0, x1, y1], x0 < x1 and y0 < y1, from its top-left corner. */
export type Box = [number, number, number, number];
/** Four corners in court space: bottom-left, bottom-right, top-right, top-left, as seen from the front. */
export type Quad = [Vec3, Vec3, Vec3, Vec3];
/**
 * A rectangle on the floor (y = 0) in court metres: [minX, minZ, maxX, maxZ]. An image laid on it runs left to right
 * from minX to maxX and top to bottom from minZ to maxZ.
 */
export type FloorRect = [number, number, number, number];
/** A file inside the bundle, relative to court.json's folder ("video/show.h264"). */
export type BundlePath = string;

/** The honesty label, word for word (P22). The bundle must carry exactly this text. */
export const LABEL = "Real footage, rebuilt in 3D. Not affiliated with the NBA or the players.";
/** The id the ball's card uses in cards.json (kind "ball"; every other card is a person). */
export const BALL_CARD = "ball";

/** court.json. */
export interface Court {
  /** Format version: 1. */
  version: 1;
  /** The moment's name, for the page title. */
  title: string;
  /** Who, which game and the moment, shown low in front of the judge. */
  caption: string;
  /** Always exactly LABEL. */
  label: string;
  /** The source credit, always shown with the label. */
  credit: string;
  court: CourtGeometry;
  camera: SourceCamera;
  video: ShowVideoInfo;
  light: LightLevels;
  seat: SeatInfo;
  freeze: FreezeInfo;
  audio: AudioInfo;
  metrics: Metrics;
  surround?: SurroundInfo;
}

/** The rulebook court the footage is lined up with. */
export interface CourtGeometry {
  /** Baseline to baseline, metres (28.65 for the NBA). Runs along X, centred on 0. */
  length: number;
  /** Sideline to sideline, metres (15.24). Runs along Z, centred on 0. */
  width: number;
  /** Centre of the ring the play attacks, court space; y is the rim height (3.05 m +/- 0.03, P2). The rim and net are drawn in 3D here (props.ts standaloneHoop) and painted out of the plate. */
  rim: Vec3;
  /** The backboard's front face (the plate's board pixels are projected onto it), corners as seen from the court. */
  backboard: Quad;
  /** Top-down image of the floor made from the footage, covering the whole court (FloorRect [-length/2, -width/2, length/2, width/2]). */
  floor: BundlePath;
  /** Same extent as `floor`: white where the camera really filmed the floor; everything else is rendered (Reality check). */
  floorSeen: BundlePath;
  /** The rendered floor's colour, matched to the footage's floor: sRGB, each 0-1. */
  hardwood: [number, number, number];
}

/** The source camera: one fixed centre; its rotation and zoom change per frame (frames.json). */
export interface SourceCamera {
  /** The camera's optical centre, court space (fixed for the whole show). */
  centre: Vec3;
  /** Source image width, pixels (3840 for 4K). Every focal and principal point is in these pixels. */
  width: number;
  /** Source image height, pixels. */
  height: number;
  /** Principal point, source pixels (width / 2 - 0.5 when centred). */
  cx: number;
  /** Principal point, source pixels. */
  cy: number;
  /** Radial distortion left in the bundle: always 0 (the bake undistorts every frame with the solve's own k1). */
  k1: number;
  /** The source clip's container rate, frames per second. Real time -> source frames: sourceFps x slow per second. */
  sourceFps: number;
  /** The real capture rate, frames per second: how many distinct real frames a second of action has. */
  captureFps: number;
  /** How much slower than real time the source clip plays; 1 for a real-time clip. */
  slow: number;
}

/** The show stream: the whole show baked at the headset's display times, plus its fallbacks. */
export interface ShowVideoInfo {
  /** Raw H.264 Annex B, -bf 0 (decode order = display order), an IDR at every segment start, undistorted, no audio. */
  file: BundlePath;
  /** WebCodecs codec string: "avc1.640033" (High, level 5.1) for the 1536x2160 stacked frame at 72 Hz. */
  codec: string;
  /** Coded width, pixels (1536). */
  width: number;
  /** Coded height, pixels (2160: live 864 + plate 864 + mattes 432). */
  height: number;
  /** Where each part of a show frame sits in the stream (stream pixels; the regions never overlap). */
  regions: {
    /** The live frame, at the source's aspect: what the camera filmed (people and all). */
    live: Region;
    /** The background plate, the live region's size: the live frame with every person replaced from the pan mosaic. */
    plate: Region;
    /** The matte atlas: each card's matte (white = the person) in its own tile (cards.json `tile`). */
    mattes: Region;
  };
  /**
   * The display rate the show is baked for, Hz (72). At this XR rate the clock steps round(dt x displayHz) show frames
   * per XR frame (one); at any other, clock.ts's Cadence keeps real time (displayHz / the session's rate per frame).
   */
  displayHz: number;
  /** Pass 2's playback speed, x real time (below 1): every display frame of pass 2 is a real captured frame. Every ease starts at it; the resume ramps up to it. */
  pass2Speed: number;
  /** Pre-built fallbacks (section 9), each optional. */
  fallbacks: ShowFallbacks;
  /** Per show frame: its source frame and camera (video/frames.json, `ShowFrame[]`). */
  frames: BundlePath;
  /** Per show frame: one card per person in the lit region, and the ball's from the release to the make (video/cards.json, `ShowCards[]`). */
  cards: BundlePath;
  segments: ShowSegments;
  /** The last pass-2 show frame a press can still stop on (the last ease start); later presses stop on the next pass. */
  cutoff: number;
  /** F: the source frame the show freezes on. Every ease ends on it; it is a real frame (interp false). */
  freezeSource: number;
  /** Source frame where the ball drops through the net: the `make` one-shots fire as the show passes it. Required when any one-shot is cued on "make". */
  makeSource?: number;
  /** Frame F, lossless, undistorted, at the source's aspect (any width; scale the camera by width). */
  freeze: BundlePath;
  /** F's background plate (the clean plate): the players and the watermark gone, filled from the pan mosaic. */
  freezeClean: BundlePath;
  /** Same size as `freeze`: white where the stands and crowd are. */
  standsMask: BundlePath;
  /** Same size as `freeze`: white where `freezeClean` was inpainted (pixels the pan never saw), for the Reality check. */
  inpaintMask?: BundlePath;
}

/** The pre-built fallbacks: a small copy (same frames), a 90 Hz bake (its own frames), pass 1 for a <video> element. */
export interface ShowFallbacks {
  /** `?show=small`: the same show frame for frame (same frames.json, cards.json, segments and cutoff), smaller. */
  small?: { file: BundlePath; codec: string; width: number; height: number };
  /**
   * `?hz=90`: a separate bake at 90 Hz display times, so it has its own frames.json, cards.json, segments and cutoff,
   * and may have its own pass-2 speed (at 90 Hz, 0.75x keeps every pass-2 frame real); without one it plays at
   * video.pass2Speed.
   */
  hz90?: {
    file: BundlePath; codec: string; width: number; height: number; displayHz: number; frames: BundlePath; cards: BundlePath;
    segments: ShowSegments; cutoff: number; pass2Speed?: number;
  };
  /** `?video=element`: pass 1 as an MP4 for a <video> element (only if WebCodecs fails on the headset). */
  element?: BundlePath;
}

/** Where each part of the show sits in the stream. Ranges are inclusive and never overlap; each starts with an IDR. */
export interface ShowSegments {
  /** Pass 1, the play at real speed (1x). */
  pass1: FrameRange;
  /** Pass 2, the replay at video.pass2Speed; Step into the court is live here; unpressed it plays on through the make and repeats. */
  pass2: FrameRange;
  /** From F on through the make: 0 -> pass2Speed over 0.8 s, then pass2Speed. Shown after F (frame F itself is the ease's last). */
  resume: FrameRange;
  /** The ease ladder, in order of `start`: each slows pass2Speed -> 0 (1 - smootherstep) and ends on F. */
  eases: ShowEase[];
}

export interface ShowEase {
  /** The pass-2 show frame the ease is entered from: after it is shown, the ease's first frame follows. */
  start: number;
  /** The ease's own frames; the last one is F. */
  frames: FrameRange;
  /** Its length, seconds (the frame count / displayHz, within one frame: 1.2, 1.0, 0.8). */
  seconds: number;
}

/** One entry of video/frames.json per show frame. */
export interface ShowFrame {
  /** The source frame shown (fractional for an in-between). */
  src: number;
  /** True for an interpolated frame (RIFE, strobe replacements included); a real frame has a whole `src`. */
  interp: boolean;
  /** That frame's own solved camera rotation, world-from-camera (never smoothed; an in-between gets the slerp of its two real frames'). */
  q: Quat;
  /** That frame's own focal length, source pixels (an in-between gets the interpolation of its two real frames'). */
  f: number;
}

/** One entry of video/cards.json per show frame. */
export interface ShowCards {
  cards: ShowCard[];
}

/**
 * A layered card for one show frame: a person in the lit region (or the ball), stood at their anchor and cut by their
 * matte, so nobody shows twice through a gap and nobody tears at an edge (P43). Resolution-free: the box is in source
 * pixels and the tile is 0-1, so a smaller copy of the stream (fallbacks.small) uses the same cards.json.
 */
export interface ShowCard {
  /** The person's id (a freeze.players or freeze.others id when they are built in 3D; any other id otherwise), BALL_CARD for the ball. */
  id: string;
  /** What the card holds. */
  kind: "person" | "ball";
  /** The card's anchor, court space: a person's foot point on the floor (y = 0), or the ball's centre. */
  at: Vec3;
  /** The matte's box in the source frame, pixel edges [x0, y0, x1, y1] (camera.width x camera.height, 0 at the top-left edge). */
  box: Box;
  /** The matte in the atlas, [u0, v0, u1, v1] 0-1 inside the mattes region from its top left; the box maps linearly onto it. Tiles keep >= 4 px apart. */
  tile: Box;
  /** Front-to-back order in this frame: 0 is nearest the camera; each card has its own. */
  order: number;
}

/** The light field's levels (lightfield.ts, 3.3): one world-space field over the footage, the floor, the stands and the splats. */
export interface LightLevels {
  /** The crowd's level at the full time stop, 0-1. */
  crowd: number;
  /** The floor outside the pool at the full time stop, 0-1. */
  floor: number;
  /** The pair (always 1: players never change in light). */
  pair: number;
  /** The stands after the pool has grown, 0-1. */
  stands: number;
  /** The pool's soft edge, metres (at least 1.5). */
  penumbra: number;
  /** The darker alternative shown at Q2 (its pick becomes the first set). */
  alternative: { crowd: number; floor: number };
}

/**
 * Decision W: where the judge sits for the watch. The walking anchoring after the world opens (the pair's centre at the
 * room's centre, its long axis on a room diagonal, the chair as spot 0, Next view where a second placement fits, the
 * automatic ring) is derived from the bounds and the bodies' bounds by seatmath.ts (3.4), so it isn't stored.
 */
export interface SeatInfo {
  /** Which camera's optical ray the seat sits on: "freeze" (the camera of the show frame equal to F). */
  ray: "freeze";
  /** D': metres from `pairCentre` to the seat along that ray (5); `?seat=` overrides it within `distanceRange`. */
  distance: number;
  /** The range `?seat=` may choose from, metres: [low, high] (4-7). */
  distanceRange: [number, number];
  /** The pair's centre on the floor, court space (y = 0). */
  pairCentre: Vec3;
  /** The chair and every ring point keep this much clear of each body's bounds, metres (1.0, P29). */
  clear: number;
}

/** The frozen 3D: the pair, the ball, the other players, the stands. */
export interface FreezeInfo {
  /** The main players (the pair), each rebuilt from their own window. */
  players: FreezePlayer[];
  ball: FreezeBall;
  /**
   * The freeze.players id whose own splats hold the ball at F (the holder's real splats do): the 3D then draws no ball
   * of its own and erases nothing of theirs (freeze.ball.erase must not list them), and the ball's card leaves and comes
   * back with the video layer, in the same frames as the holder's card. Absent: freeze.ball's sphere is the ball.
   */
  ballInBody?: string;
  /** The extras (3.4b): every other player or ref placed on the court. May be empty. */
  others: FreezeExtra[];
  stands: StandsInfo;
}

export interface FreezePlayer {
  /** Stable id, unique among players and others. */
  id: string;
  /** Display name. */
  name: string;
  /** The freeze-frame Gaussians: 3DGS PLY, SH degree 1, court space. */
  splats: BundlePath;
  /** The same Gaussians in the same order, the ones no camera saw tinted blue (Reality check). */
  reality: BundlePath;
  /** The splat-depth proxy: a depth mesh of these splats seen from camera F, court space (glTF binary). */
  proxy: BundlePath;
  /** Axis-aligned bounds of the visible body, court space. */
  bounds: { min: Vec3; max: Vec3 };
  /** Share of the body the cameras really saw, 0-1. */
  seenFraction: number;
  /** Torso and head capsules only (never arms or hands): the eye 0.2 m from one fades the player (P17). */
  capsules: Capsule[];
  shadow: FloorMap;
  reflection: FloorMap;
}

/** A capsule: the segment a-b (court space) swept by radius r (metres). */
export interface Capsule {
  a: Vec3;
  b: Vec3;
  r: number;
}

/** A floor image baked from the Gaussians (contact shadow, reflection), laid on `rect`. */
export interface FloorMap {
  /** PNG; RGBA, alpha = coverage. */
  image: BundlePath;
  rect: FloorRect;
}

export interface FreezeBall {
  /** Ball centre at F, court space. */
  centre: Vec3;
  /** Metres (0.1195: a 23.9 cm ball). */
  radius: number;
  /** Splats of these players within `radius` metres of the ball's centre are erased (the ball replaces them). */
  erase: { player: string; radius: number }[];
}

/** An extra (3.4b): another player or ref, built one of three ways. */
export interface FreezeExtra {
  /** Unique among players and others. */
  id: string;
  /** Display name (optional). */
  name?: string;
  /** splats: rebuilt like the pair (PLY); body: an LHM++ body posed to C (PLY); relief: a relief mesh from the source frame (GLB). */
  kind: "splats" | "body" | "relief";
  /** The model file (PLY for splats and body, GLB for relief). */
  file: BundlePath;
  /** The same model with what no camera saw tinted blue. */
  reality: BundlePath;
  /** Which camera gave the pose: "A" (the source camera, seen in the show) or "C" (a second camera; Reality-marked). */
  pose: "A" | "C";
  /** Where they stand: the floor point under them, court space (y = 0). */
  foot: Vec3;
  /** Their height, metres (body scale check, P12). */
  height: number;
  /** The largest angle between camera F's ray to them and any walk-spot ray to them, degrees (a relief needs < 15, P16). */
  maxRayAngle: number;
  shadow: FloorMap;
  reflection: FloorMap;
}

/** What the footage is projected onto besides the court plane, the backboard and the people's cards. */
export interface StandsInfo {
  /** The stands proxy: planes the plate is projected onto. */
  proxy: { kind: "plane"; points: Quad }[];
  /** Depth cards (front row, photographers, the ref), each its own image on its own quad. */
  cards: StandCard[];
}

export interface StandCard {
  /** Unique among stand cards ("front-row"). */
  id: string;
  /** PNG cut from the clean plate, RGBA (alpha = the card's matte). */
  image: BundlePath;
  /** Corners in court space: bottom-left, bottom-right, top-right, top-left of the image, as seen from the court. */
  quad: Quad;
}

/**
 * The arena round the footage (optional; without it the bowl stays structured darkness). `far` is real: everything the
 * camera's pan filmed at the far end, people removed. `crowd` is imagined: blocks of the footage's own crowd laid on
 * the seating bowl the camera never saw, so the Reality check tints it blue (rule 6).
 */
export interface SurroundInfo {
  far?: SurroundFar;
  crowd?: SurroundCrowd;
}

/** The pan's mosaic as one pinhole image sharing camera F's centre and rotation (frames[frame].q), its own intrinsics. */
export interface SurroundFar {
  /** RGB (JPEG). */
  image: BundlePath;
  /** 8-bit, same size: 255 where the pan filmed it, 0 where it never did (feathered a few pixels). */
  alpha: BundlePath;
  /** The show frame whose rotation the image uses (camera F's). */
  frame: number;
  /** Focal length and principal point in this image's own pixels. */
  f: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/** Tiles of real crowd (whole rows of seats, upright) at one scale, laid on the imagined bowl. */
export interface SurroundCrowd {
  /** RGB (JPEG). */
  atlas: BundlePath;
  /** Atlas size, pixels. */
  width: number;
  height: number;
  /** Every tile is resampled to this many atlas pixels per metre of stands. */
  pxPerM: number;
  /** [x0, y0, x1, y1] in atlas pixels. */
  tiles: Box[];
}

export interface AudioInfo {
  /** The crowd bed: a no-vocals stem, looped seamlessly, swell cut out (AAC in MP4). */
  bed: BundlePath;
  /** The bed's integrated loudness, LUFS (-23). */
  lufs: number;
  /** At least four HRTF sources at the stands, each playing the bed from its own offset (P31). */
  sources: { at: Vec3; offsetS: number }[];
  /** One-shots: `make` fires as the show passes video.makeSource; `stepIn` fires softly at Step into the court. */
  oneShots: { file: BundlePath; at: "make" | "stepIn"; gainDb: number }[];
  /** Sounds at 3D positions (squeak, bounce, release), each fired as the show passes its source frame `frame`. May be empty. */
  events: { frame: number; kind: string; at: Vec3; file: BundlePath }[];
}

/** The measured numbers (section 11); null (or absent from a map) until measured. */
export interface Metrics {
  /** Calibration reprojection error, degrees. */
  reprojDeg: { median: number | null; p95: number | null };
  /** Held-out PSNR per player id vs generated views, dB. */
  heldOutPsnrVsGenerated: Record<string, number | null>;
  /** Seat-view match (P8), dB, by part ("players", "background", or a player id). */
  seatPsnr: Record<string, number | null>;
  /** Share of show frames that are interpolated, 0-1 (shown by the Reality check). */
  interpShare: number;
}

// ---------------- validation ----------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const show = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/** Collects errors as "<field>: <what's wrong>, got <value>". */
class Check {
  readonly errors: string[] = [];

  fail(path: string, msg: string, ...got: unknown[]): false {
    this.errors.push(`${path}: ${msg}${got.length ? `, got ${show(got[0])}` : ""}`);
    return false;
  }

  /** The field exists; reports "missing" when it doesn't. */
  has(o: Record<string, unknown>, key: string, path: string): boolean {
    return key in o && o[key] !== undefined ? true : this.fail(path, "missing");
  }

  obj(v: unknown, path: string): v is Record<string, unknown> {
    return isObj(v) || this.fail(path, "expected an object", v);
  }

  text(v: unknown, path: string): v is string {
    return (typeof v === "string" && v.trim().length > 0) || this.fail(path, "expected some text", v);
  }

  num(v: unknown, path: string, rule: { gt?: number; lt?: number; min?: number; max?: number; int?: boolean } = {}): v is number {
    if (typeof v !== "number" || !Number.isFinite(v)) return this.fail(path, "expected a number", v);
    if (rule.int && !Number.isInteger(v)) return this.fail(path, "expected a whole number", v);
    if (rule.gt !== undefined && rule.lt !== undefined && !(v > rule.gt && v < rule.lt))
      return this.fail(path, `expected a number between ${rule.gt} and ${rule.lt} (exclusive)`, v);
    if (rule.gt !== undefined && !(v > rule.gt)) return this.fail(path, `expected a number greater than ${rule.gt}`, v);
    if (rule.min !== undefined && rule.max !== undefined && (v < rule.min || v > rule.max))
      return this.fail(path, `expected a number between ${rule.min} and ${rule.max}`, v);
    if (rule.min !== undefined && v < rule.min) return this.fail(path, `expected a number of at least ${rule.min}`, v);
    if (rule.max !== undefined && v > rule.max) return this.fail(path, `expected a number of at most ${rule.max}`, v);
    return true;
  }

  bool(v: unknown, path: string): v is boolean {
    return typeof v === "boolean" || this.fail(path, "expected true or false", v);
  }

  /** A fixed-length list of finite numbers; each element is checked so the error names it. */
  nums(v: unknown, n: number, path: string, what: string): v is number[] {
    if (!Array.isArray(v) || v.length !== n) return this.fail(path, `expected ${what}`, v);
    let ok = true;
    v.forEach((x, i) => (ok = this.num(x, `${path}[${i}]`) && ok));
    return ok;
  }

  vec3(v: unknown, path: string): v is Vec3 {
    return this.nums(v, 3, path, "a point [x, y, z] in metres");
  }

  /** A list; `need` says how many in words when there is a minimum ("one ease"). */
  list(v: unknown, path: string, min = 0, need = ""): v is unknown[] {
    if (!Array.isArray(v)) return this.fail(path, "expected a list", v);
    if (v.length < min) return this.fail(path, `expected at least ${need}`, v.length);
    return true;
  }

  /** A bundle-relative file path: no scheme, no leading slash, no "..", no backslashes. */
  file(v: unknown, path: string): v is string {
    if (!this.text(v, path)) return false;
    const bad = /^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith("/") || v.includes("\\") || v.split("/").includes("..");
    return !bad || this.fail(path, "expected a path inside the bundle (relative, no '..', no URL)", v);
  }

  range(v: unknown, path: string): v is FrameRange {
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === "number" && Number.isFinite(x)))
      return this.fail(path, "expected [first, last] show frames", v);
    if (!v.every((x) => Number.isInteger(x) && x >= 0)) return this.fail(path, "expected whole show frames (0 or more)", v);
    if (v[0] > v[1]) return this.fail(path, "expected [first, last] with first <= last", v);
    return true;
  }

  rect(v: unknown, path: string): v is FloorRect {
    if (!this.nums(v, 4, path, "a floor rectangle [minX, minZ, maxX, maxZ]")) return false;
    return (v[0] < v[2] && v[1] < v[3]) || this.fail(path, "expected [minX, minZ, maxX, maxZ] with minX < maxX and minZ < maxZ", v);
  }

  /** A box [x0, y0, x1, y1] inside an image of w x h pixels. */
  box(v: unknown, path: string, w: number, h: number, what: string): v is Box {
    if (!this.nums(v, 4, path, `a box [x0, y0, x1, y1] in ${what} pixels`)) return false;
    if (!(v[0] < v[2] && v[1] < v[3])) return this.fail(path, "expected [x0, y0, x1, y1] with x0 < x1 and y0 < y1", v);
    if (v[0] < 0 || v[1] < 0 || v[2] > w || v[3] > h) return this.fail(path, `expected a box inside the ${what} (${w} x ${h})`, v);
    return true;
  }

  oneOf<T extends string>(v: unknown, options: readonly T[], path: string, words: string): v is T {
    return (typeof v === "string" && (options as readonly string[]).includes(v)) || this.fail(path, `expected ${words}`, v);
  }
}

const CODEC = /^avc1\.[0-9a-f]{6}$/i;

/** Every problem with a parsed court.json, one readable line each ("seat.distance: ..."); empty when it is valid. */
export function validateCourt(json: unknown): string[] {
  const c = new Check();
  if (!isObj(json)) {
    c.fail("court.json", "expected an object (the parsed court.json)", json);
    return c.errors;
  }
  const j = json;
  if (c.has(j, "version", "version") && j.version !== 1) c.fail("version", "expected 1 (the only version so far)", j.version);
  for (const k of ["title", "caption", "credit"]) if (c.has(j, k, k)) c.text(j[k], k);
  if (c.has(j, "label", "label") && j.label !== LABEL) c.fail("label", `expected exactly "${LABEL}" (P22)`, j.label);

  // court
  if (c.has(j, "court", "court") && c.obj(j.court, "court")) {
    const o = j.court;
    for (const k of ["length", "width"]) if (c.has(o, k, `court.${k}`)) c.num(o[k], `court.${k}`, { gt: 0 });
    if (c.has(o, "rim", "court.rim") && c.vec3(o.rim, "court.rim") && Math.abs(o.rim[1] - 3.05) > 0.03)
      c.fail("court.rim", "expected the rim at 3.05 m (+/- 0.03) in y", o.rim);
    if (c.has(o, "backboard", "court.backboard")) quad(c, o.backboard, "court.backboard");
    for (const k of ["floor", "floorSeen"]) if (c.has(o, k, `court.${k}`)) c.file(o[k], `court.${k}`);
    if (c.has(o, "hardwood", "court.hardwood") && c.nums(o.hardwood, 3, "court.hardwood", "an sRGB colour [r, g, b], each 0-1"))
      o.hardwood.forEach((x, i) => c.num(x, `court.hardwood[${i}]`, { min: 0, max: 1 }));
  }

  // camera
  let aspect: number | null = null; // the source's height / width: the live region keeps it
  if (c.has(j, "camera", "camera") && c.obj(j.camera, "camera")) {
    const o = j.camera;
    if (c.has(o, "centre", "camera.centre")) c.vec3(o.centre, "camera.centre");
    const w = c.has(o, "width", "camera.width") && c.num(o.width, "camera.width", { gt: 0, int: true }) ? o.width : null;
    const h = c.has(o, "height", "camera.height") && c.num(o.height, "camera.height", { gt: 0, int: true }) ? o.height : null;
    if (c.has(o, "cx", "camera.cx") && c.num(o.cx, "camera.cx") && w !== null && (o.cx <= 0 || o.cx >= w))
      c.fail("camera.cx", `expected the principal point inside the image (0-${w})`, o.cx);
    if (c.has(o, "cy", "camera.cy") && c.num(o.cy, "camera.cy") && h !== null && (o.cy <= 0 || o.cy >= h))
      c.fail("camera.cy", `expected the principal point inside the image (0-${h})`, o.cy);
    if (w !== null && h !== null) aspect = h / w;
    if (c.has(o, "k1", "camera.k1") && c.num(o.k1, "camera.k1") && o.k1 !== 0)
      c.fail("camera.k1", "expected 0: the bundle's frames are undistorted by the bake", o.k1);
    for (const k of ["sourceFps", "captureFps", "slow"]) if (c.has(o, k, `camera.${k}`)) c.num(o[k], `camera.${k}`, { gt: 0 });
  }

  // video
  const v = c.has(j, "video", "video") && c.obj(j.video, "video") ? j.video : null;
  if (v) {
    streamFields(c, v, "video");
    const size = typeof v.width === "number" && typeof v.height === "number" ? { w: v.width, h: v.height } : null;
    if (c.has(v, "regions", "video.regions")) regions(c, v.regions, size, aspect);
    if (c.has(v, "displayHz", "video.displayHz")) c.num(v.displayHz, "video.displayHz", { gt: 0 });
    if (c.has(v, "pass2Speed", "video.pass2Speed")) c.num(v.pass2Speed, "video.pass2Speed", { gt: 0, lt: 1 });
    for (const k of ["frames", "cards", "freeze", "freezeClean", "standsMask"]) if (c.has(v, k, `video.${k}`)) c.file(v[k], `video.${k}`);
    if (v.inpaintMask !== undefined) c.file(v.inpaintMask, "video.inpaintMask");
    if (c.has(v, "freezeSource", "video.freezeSource")) c.num(v.freezeSource, "video.freezeSource", { min: 0 });
    if (v.makeSource !== undefined) c.num(v.makeSource, "video.makeSource", { min: 0 });
    if (c.has(v, "fallbacks", "video.fallbacks") && c.obj(v.fallbacks, "video.fallbacks")) {
      const fb = v.fallbacks;
      if (fb.small !== undefined && c.obj(fb.small, "video.fallbacks.small")) {
        streamFields(c, fb.small, "video.fallbacks.small");
        sameShape(c, fb.small, size, "video.fallbacks.small");
      }
      if (fb.hz90 !== undefined && c.obj(fb.hz90, "video.fallbacks.hz90")) {
        const o = fb.hz90;
        streamFields(c, o, "video.fallbacks.hz90");
        sameShape(c, o, size, "video.fallbacks.hz90");
        if (c.has(o, "displayHz", "video.fallbacks.hz90.displayHz")) c.num(o.displayHz, "video.fallbacks.hz90.displayHz", { gt: 0 });
        if (o.pass2Speed !== undefined) c.num(o.pass2Speed, "video.fallbacks.hz90.pass2Speed", { gt: 0, lt: 1 });
        for (const k of ["frames", "cards"]) if (c.has(o, k, `video.fallbacks.hz90.${k}`)) c.file(o[k], `video.fallbacks.hz90.${k}`);
        if (c.has(o, "segments", "video.fallbacks.hz90.segments")) segments(c, o.segments, o.cutoff, "video.fallbacks.hz90", o.displayHz);
      }
      if (fb.element !== undefined) c.file(fb.element, "video.fallbacks.element");
    }
    if (c.has(v, "segments", "video.segments")) segments(c, v.segments, v.cutoff, "video", v.displayHz);
  }

  // light
  if (c.has(j, "light", "light") && c.obj(j.light, "light")) {
    const l = j.light;
    for (const k of ["crowd", "floor", "pair", "stands"]) if (c.has(l, k, `light.${k}`)) c.num(l[k], `light.${k}`, { min: 0, max: 1 });
    if (c.has(l, "penumbra", "light.penumbra")) c.num(l.penumbra, "light.penumbra", { min: 1.5 });
    if (c.has(l, "alternative", "light.alternative") && c.obj(l.alternative, "light.alternative"))
      for (const k of ["crowd", "floor"]) if (c.has(l.alternative, k, `light.alternative.${k}`)) c.num(l.alternative[k], `light.alternative.${k}`, { min: 0, max: 1 });
  }

  // seat
  if (c.has(j, "seat", "seat") && c.obj(j.seat, "seat")) {
    const o = j.seat;
    if (c.has(o, "ray", "seat.ray") && o.ray !== "freeze") c.fail("seat.ray", 'expected "freeze" (camera F\'s optical ray)', o.ray);
    let lo = -Infinity;
    let hi = Infinity;
    if (c.has(o, "distanceRange", "seat.distanceRange")) {
      const r = o.distanceRange;
      if (c.nums(r, 2, "seat.distanceRange", "[low, high] metres")) {
        if (r[0] > 0 && r[0] < r[1]) [lo, hi] = r;
        else c.fail("seat.distanceRange", "expected [low, high] metres with 0 < low < high", r);
      }
    }
    if (c.has(o, "distance", "seat.distance") && c.num(o.distance, "seat.distance", { gt: 0 }) && (o.distance < lo || o.distance > hi))
      c.fail("seat.distance", `expected a distance inside distanceRange [${lo}, ${hi}]`, o.distance);
    if (c.has(o, "pairCentre", "seat.pairCentre") && c.vec3(o.pairCentre, "seat.pairCentre") && Math.abs(o.pairCentre[1]) > 0.01)
      c.fail("seat.pairCentre", "expected a point on the floor (y = 0)", o.pairCentre);
    if (c.has(o, "clear", "seat.clear")) c.num(o.clear, "seat.clear", { gt: 0 });
  }

  // freeze
  if (c.has(j, "freeze", "freeze") && c.obj(j.freeze, "freeze")) {
    const fz = j.freeze;
    const ids = new Set<string>();
    const unique = (id: unknown, path: string) => {
      if (!c.text(id, path)) return;
      if (id === BALL_CARD) c.fail(path, `"${BALL_CARD}" is the ball's card id; pick another`, id);
      else if (ids.has(id)) c.fail(path, "expected an id unique among players and others", id);
      ids.add(id);
    };
    const players = new Set<string>();
    if (c.has(fz, "players", "freeze.players") && c.list(fz.players, "freeze.players", 1, "one player")) {
      fz.players.forEach((p, i) => {
        const at = `freeze.players[${i}]`;
        if (!c.obj(p, at)) return;
        if (c.has(p, "id", `${at}.id`)) {
          unique(p.id, `${at}.id`);
          if (typeof p.id === "string") players.add(p.id);
        }
        if (c.has(p, "name", `${at}.name`)) c.text(p.name, `${at}.name`);
        for (const k of ["splats", "reality", "proxy"]) if (c.has(p, k, `${at}.${k}`)) c.file(p[k], `${at}.${k}`);
        if (c.has(p, "bounds", `${at}.bounds`)) bounds(c, p.bounds, `${at}.bounds`);
        if (c.has(p, "seenFraction", `${at}.seenFraction`)) c.num(p.seenFraction, `${at}.seenFraction`, { min: 0, max: 1 });
        if (c.has(p, "capsules", `${at}.capsules`) && c.list(p.capsules, `${at}.capsules`, 1, "one capsule (torso or head)"))
          p.capsules.forEach((cap, k) => {
            const cp = `${at}.capsules[${k}]`;
            if (!c.obj(cap, cp)) return;
            if (c.has(cap, "a", `${cp}.a`)) c.vec3(cap.a, `${cp}.a`);
            if (c.has(cap, "b", `${cp}.b`)) c.vec3(cap.b, `${cp}.b`);
            if (c.has(cap, "r", `${cp}.r`)) c.num(cap.r, `${cp}.r`, { gt: 0 });
          });
        for (const k of ["shadow", "reflection"]) if (c.has(p, k, `${at}.${k}`)) floorMap(c, p[k], `${at}.${k}`);
      });
    }
    if (c.has(fz, "ball", "freeze.ball") && c.obj(fz.ball, "freeze.ball")) {
      const b = fz.ball;
      if (c.has(b, "centre", "freeze.ball.centre")) c.vec3(b.centre, "freeze.ball.centre");
      if (c.has(b, "radius", "freeze.ball.radius")) c.num(b.radius, "freeze.ball.radius", { gt: 0 });
      if (c.has(b, "erase", "freeze.ball.erase") && c.list(b.erase, "freeze.ball.erase"))
        b.erase.forEach((e, i) => {
          const at = `freeze.ball.erase[${i}]`;
          if (!c.obj(e, at)) return;
          if (c.has(e, "player", `${at}.player`) && c.text(e.player, `${at}.player`) && !players.has(e.player))
            c.fail(`${at}.player`, "expected the id of one of freeze.players (there is no player by that id)", e.player);
          if (c.has(e, "radius", `${at}.radius`)) c.num(e.radius, `${at}.radius`, { gt: 0 });
          if (fz.ballInBody !== undefined && e.player === fz.ballInBody)
            c.fail(`${at}.player`, "expected no erase for freeze.ballInBody's player: their splats hold the ball", e.player);
        });
    }
    if (fz.ballInBody !== undefined && c.text(fz.ballInBody, "freeze.ballInBody") && !players.has(fz.ballInBody))
      c.fail("freeze.ballInBody", "expected the id of one of freeze.players (there is no player by that id)", fz.ballInBody);
    if (c.has(fz, "others", "freeze.others") && c.list(fz.others, "freeze.others"))
      fz.others.forEach((o, i) => {
        const at = `freeze.others[${i}]`;
        if (!c.obj(o, at)) return;
        if (c.has(o, "id", `${at}.id`)) unique(o.id, `${at}.id`);
        if (o.name !== undefined) c.text(o.name, `${at}.name`);
        const kind = c.has(o, "kind", `${at}.kind`) && c.oneOf(o.kind, ["splats", "body", "relief"] as const, `${at}.kind`, "splats, body or relief") ? o.kind : null;
        for (const k of ["file", "reality"]) if (c.has(o, k, `${at}.${k}`)) c.file(o[k], `${at}.${k}`);
        if (c.has(o, "pose", `${at}.pose`)) c.oneOf(o.pose, ["A", "C"] as const, `${at}.pose`, "A or C (the camera that gave the pose)");
        if (c.has(o, "foot", `${at}.foot`)) c.vec3(o.foot, `${at}.foot`);
        if (c.has(o, "height", `${at}.height`)) c.num(o.height, `${at}.height`, { gt: 0 });
        if (c.has(o, "maxRayAngle", `${at}.maxRayAngle`) && c.num(o.maxRayAngle, `${at}.maxRayAngle`, { min: 0, max: 180 }) && kind === "relief" && o.maxRayAngle >= 15)
          c.fail(`${at}.maxRayAngle`, "a relief is only allowed where every walk-spot ray is within 15 deg of camera F's (P16)", o.maxRayAngle);
        for (const k of ["shadow", "reflection"]) if (c.has(o, k, `${at}.${k}`)) floorMap(c, o[k], `${at}.${k}`);
      });
    if (c.has(fz, "stands", "freeze.stands") && c.obj(fz.stands, "freeze.stands")) {
      const s = fz.stands;
      if (c.has(s, "proxy", "freeze.stands.proxy") && c.list(s.proxy, "freeze.stands.proxy"))
        s.proxy.forEach((p, i) => {
          const at = `freeze.stands.proxy[${i}]`;
          if (!c.obj(p, at)) return;
          if (c.has(p, "kind", `${at}.kind`)) c.oneOf(p.kind, ["plane"] as const, `${at}.kind`, '"plane"');
          if (c.has(p, "points", `${at}.points`)) quad(c, p.points, `${at}.points`);
        });
      const cards = new Set<string>();
      if (c.has(s, "cards", "freeze.stands.cards") && c.list(s.cards, "freeze.stands.cards"))
        s.cards.forEach((card, i) => {
          const at = `freeze.stands.cards[${i}]`;
          if (!c.obj(card, at)) return;
          if (c.has(card, "id", `${at}.id`) && c.text(card.id, `${at}.id`)) {
            if (cards.has(card.id)) c.fail(`${at}.id`, "expected an id unique among stand cards", card.id);
            cards.add(card.id);
          }
          if (c.has(card, "image", `${at}.image`)) c.file(card.image, `${at}.image`);
          if (c.has(card, "quad", `${at}.quad`)) quad(c, card.quad, `${at}.quad`);
        });
    }
  }

  // audio
  let wantsMake = false;
  if (c.has(j, "audio", "audio") && c.obj(j.audio, "audio")) {
    const a = j.audio;
    if (c.has(a, "bed", "audio.bed")) c.file(a.bed, "audio.bed");
    if (c.has(a, "lufs", "audio.lufs")) c.num(a.lufs, "audio.lufs", { max: 0 });
    if (c.has(a, "sources", "audio.sources") && c.list(a.sources, "audio.sources", 4, "4 crowd sources at the stands (P31)"))
      a.sources.forEach((s, i) => {
        const at = `audio.sources[${i}]`;
        if (!c.obj(s, at)) return;
        if (c.has(s, "at", `${at}.at`)) c.vec3(s.at, `${at}.at`);
        if (c.has(s, "offsetS", `${at}.offsetS`)) c.num(s.offsetS, `${at}.offsetS`, { min: 0 });
      });
    if (c.has(a, "oneShots", "audio.oneShots") && c.list(a.oneShots, "audio.oneShots"))
      a.oneShots.forEach((s, i) => {
        const at = `audio.oneShots[${i}]`;
        if (!c.obj(s, at)) return;
        if (c.has(s, "file", `${at}.file`)) c.file(s.file, `${at}.file`);
        if (c.has(s, "at", `${at}.at`) && c.oneOf(s.at, ["make", "stepIn"] as const, `${at}.at`, "make or stepIn")) wantsMake ||= s.at === "make";
        if (c.has(s, "gainDb", `${at}.gainDb`)) c.num(s.gainDb, `${at}.gainDb`);
      });
    if (c.has(a, "events", "audio.events") && c.list(a.events, "audio.events"))
      a.events.forEach((e, i) => {
        const at = `audio.events[${i}]`;
        if (!c.obj(e, at)) return;
        if (c.has(e, "frame", `${at}.frame`)) c.num(e.frame, `${at}.frame`, { min: 0 });
        if (c.has(e, "kind", `${at}.kind`)) c.text(e.kind, `${at}.kind`);
        if (c.has(e, "at", `${at}.at`)) c.vec3(e.at, `${at}.at`);
        if (c.has(e, "file", `${at}.file`)) c.file(e.file, `${at}.file`);
      });
  }
  if (wantsMake && v && v.makeSource === undefined)
    c.fail("video.makeSource", "missing: a one-shot is cued on the make, so the make's source frame is needed");

  // metrics
  if (c.has(j, "metrics", "metrics") && c.obj(j.metrics, "metrics")) {
    const m = j.metrics;
    if (c.has(m, "reprojDeg", "metrics.reprojDeg") && c.obj(m.reprojDeg, "metrics.reprojDeg"))
      for (const k of ["median", "p95"])
        if (k in m.reprojDeg && m.reprojDeg[k] !== null) c.num(m.reprojDeg[k], `metrics.reprojDeg.${k}`, { min: 0 });
        else if (!(k in m.reprojDeg)) c.fail(`metrics.reprojDeg.${k}`, "missing (null until measured)");
    for (const k of ["heldOutPsnrVsGenerated", "seatPsnr"])
      if (c.has(m, k, `metrics.${k}`) && c.obj(m[k], `metrics.${k}`))
        for (const [key, x] of Object.entries(m[k] as Record<string, unknown>)) if (x !== null) c.num(x, `metrics.${k}.${key}`);
    if (c.has(m, "interpShare", "metrics.interpShare")) c.num(m.interpShare, "metrics.interpShare", { min: 0, max: 1 });
  }

  // surround (optional)
  if (j.surround !== undefined && c.obj(j.surround, "surround")) {
    const s = j.surround;
    if (s.far !== undefined && c.obj(s.far, "surround.far")) {
      const f = s.far;
      for (const k of ["image", "alpha"]) if (c.has(f, k, `surround.far.${k}`)) c.file(f[k], `surround.far.${k}`);
      if (c.has(f, "frame", "surround.far.frame")) c.num(f.frame, "surround.far.frame", { min: 0, int: true });
      for (const k of ["f", "width", "height"]) if (c.has(f, k, `surround.far.${k}`)) c.num(f[k], `surround.far.${k}`, { gt: 0 });
      for (const k of ["cx", "cy"]) if (c.has(f, k, `surround.far.${k}`)) c.num(f[k], `surround.far.${k}`);
    }
    if (s.crowd !== undefined && c.obj(s.crowd, "surround.crowd")) {
      const cr = s.crowd;
      if (c.has(cr, "atlas", "surround.crowd.atlas")) c.file(cr.atlas, "surround.crowd.atlas");
      const size = ["width", "height"].every((k) => c.has(cr, k, `surround.crowd.${k}`) && c.num(cr[k], `surround.crowd.${k}`, { gt: 0, int: true }));
      if (c.has(cr, "pxPerM", "surround.crowd.pxPerM")) c.num(cr.pxPerM, "surround.crowd.pxPerM", { gt: 0 });
      if (c.has(cr, "tiles", "surround.crowd.tiles") && c.list(cr.tiles, "surround.crowd.tiles", 1, "at least one crowd tile") && size)
        cr.tiles.forEach((t, i) => c.box(t, `surround.crowd.tiles[${i}]`, cr.width as number, cr.height as number, "atlas"));
    }
  }
  return c.errors;
}

function streamFields(c: Check, o: Record<string, unknown>, at: string) {
  if (c.has(o, "file", `${at}.file`)) c.file(o.file, `${at}.file`);
  if (c.has(o, "codec", `${at}.codec`) && c.text(o.codec, `${at}.codec`) && !CODEC.test(o.codec))
    c.fail(`${at}.codec`, 'expected a WebCodecs H.264 string like "avc1.640033"', o.codec);
  for (const k of ["width", "height"]) if (c.has(o, k, `${at}.${k}`)) c.num(o[k], `${at}.${k}`, { gt: 0, int: true });
}

/** A fallback keeps the main stream's shape (within a pixel), so its regions are the main ones scaled by width. */
function sameShape(c: Check, o: Record<string, unknown>, main: { w: number; h: number } | null, at: string) {
  if (!main || typeof o.width !== "number" || typeof o.height !== "number") return;
  const want = (o.width * main.h) / main.w;
  if (Math.abs(o.height - want) > 1) c.fail(`${at}.height`, `expected the main stream's shape: ${Math.round(want)} for width ${o.width}`, o.height);
}

/** The stacked regions: inside the stream, never overlapping, live and plate the same size, live at the source's aspect. */
function regions(c: Check, r: unknown, size: { w: number; h: number } | null, aspect: number | null) {
  if (!c.obj(r, "video.regions")) return;
  const got: [string, Region][] = [];
  for (const k of ["live", "plate", "mattes"]) {
    const at = `video.regions.${k}`;
    if (!c.has(r, k, at) || !c.nums(r[k], 4, at, "a region [x, y, width, height] in stream pixels")) continue;
    const g = r[k] as Region;
    if (!g.every((x) => Number.isInteger(x)) || g[0] < 0 || g[1] < 0 || g[2] <= 0 || g[3] <= 0) {
      c.fail(at, "expected whole pixels: x, y >= 0 and width, height > 0", g);
      continue;
    }
    if (size && (g[0] + g[2] > size.w || g[1] + g[3] > size.h)) {
      c.fail(at, `expected a region inside the stream (${size.w} x ${size.h})`, g);
      continue;
    }
    got.push([k, g]);
  }
  for (let i = 0; i < got.length; i++)
    for (let k = i + 1; k < got.length; k++) {
      const [a, b] = [got[i][1], got[k][1]];
      if (a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3])
        c.fail("video.regions", `expected regions that never overlap: ${got[i][0]} and ${got[k][0]} do`);
    }
  const live = got.find(([k]) => k === "live")?.[1];
  const plate = got.find(([k]) => k === "plate")?.[1];
  if (live && plate && (live[2] !== plate[2] || live[3] !== plate[3])) c.fail("video.regions.plate", `expected the live region's size (${live[2]} x ${live[3]})`, plate);
  if (live && aspect !== null && Math.abs(live[3] - live[2] * aspect) > 1)
    c.fail("video.regions.live", `expected the source's aspect: height ${Math.round(live[2] * aspect)} for width ${live[2]}`, live);
}

/** Checks a segments block (and its cutoff). */
function segments(c: Check, s: unknown, cutoff: unknown, owner: string, displayHz: unknown) {
  const at = `${owner}.segments`;
  if (!c.obj(s, at)) return;
  const named: [string, FrameRange][] = [];
  for (const k of ["pass1", "pass2", "resume"]) if (c.has(s, k, `${at}.${k}`) && c.range(s[k], `${at}.${k}`)) named.push([k, s[k] as FrameRange]);
  const pass2 = named.find(([k]) => k === "pass2")?.[1] ?? null;
  const starts: number[] = [];
  if (c.has(s, "eases", `${at}.eases`) && c.list(s.eases, `${at}.eases`, 1, "one ease")) {
    s.eases.forEach((e, i) => {
      const ep = `${at}.eases[${i}]`;
      if (!c.obj(e, ep)) return;
      if (c.has(e, "start", `${ep}.start`) && c.num(e.start, `${ep}.start`, { min: 0, int: true })) {
        if (pass2 && (e.start < pass2[0] || e.start > pass2[1])) c.fail(`${ep}.start`, `expected a show frame inside pass 2 [${pass2[0]}, ${pass2[1]}]`, e.start);
        starts.push(e.start);
      }
      const ok = c.has(e, "frames", `${ep}.frames`) && c.range(e.frames, `${ep}.frames`);
      if (ok) named.push([`eases[${i}]`, e.frames as FrameRange]);
      if (c.has(e, "seconds", `${ep}.seconds`) && c.num(e.seconds, `${ep}.seconds`, { gt: 0 }) && ok && typeof displayHz === "number" && displayHz > 0) {
        const count = (e.frames as FrameRange)[1] - (e.frames as FrameRange)[0] + 1;
        if (Math.abs(e.seconds * displayHz - count) > 1)
          c.fail(`${ep}.seconds`, `expected the ease's length: its ${count} frames at ${displayHz} Hz are ${(count / displayHz).toFixed(3)} s`, e.seconds);
      }
    });
    if (starts.length === s.eases.length && starts.some((x, i) => i > 0 && x <= starts[i - 1]))
      c.fail(`${at}.eases`, "expected the eases in order of start (earliest first), each with its own start", starts);
  }
  // no two segments may share a show frame
  const sorted = [...named].sort((a, b) => a[1][0] - b[1][0]);
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i][1][0] <= sorted[i - 1][1][1])
      c.fail(at, `expected segments that never overlap: ${sorted[i - 1][0]} ${show(sorted[i - 1][1])} and ${sorted[i][0]} ${show(sorted[i][1])} overlap`);
  const cp = `${owner}.cutoff`;
  if (cutoff === undefined) c.fail(cp, "missing");
  else if (c.num(cutoff, cp, { min: 0, int: true })) {
    if (pass2 && (cutoff < pass2[0] || cutoff > pass2[1])) c.fail(cp, `expected a show frame inside pass 2 [${pass2[0]}, ${pass2[1]}]`, cutoff);
    else if (starts.length && cutoff > Math.max(...starts))
      c.fail(cp, `expected at most the last ease start (${Math.max(...starts)}): a later press would find no ease to take`, cutoff);
  }
}

function bounds(c: Check, b: unknown, at: string) {
  if (!c.obj(b, at)) return;
  const okMin = c.has(b, "min", `${at}.min`) && c.vec3(b.min, `${at}.min`);
  const okMax = c.has(b, "max", `${at}.max`) && c.vec3(b.max, `${at}.max`);
  if (okMin && okMax && !(b.min as Vec3).every((x, i) => x < (b.max as Vec3)[i])) c.fail(at, "expected min < max on every axis", b);
}

function floorMap(c: Check, m: unknown, at: string) {
  if (!c.obj(m, at)) return;
  if (c.has(m, "image", `${at}.image`)) c.file(m.image, `${at}.image`);
  if (c.has(m, "rect", `${at}.rect`)) c.rect(m.rect, `${at}.rect`);
}

function quad(c: Check, q: unknown, at: string) {
  if (!Array.isArray(q) || q.length !== 4) {
    c.fail(at, "expected four corners [[x, y, z] x 4]", q);
    return;
  }
  q.forEach((p, i) => c.vec3(p, `${at}[${i}]`));
}

/** Every problem with a parsed video/frames.json, checked against its court.json; empty when it is valid. */
export function validateFrames(json: unknown, court: Court): string[] {
  const c = new Check();
  if (!Array.isArray(json) || json.length === 0) {
    c.fail("frames.json", "expected one entry per show frame (a non-empty list)", Array.isArray(json) ? json.length : json);
    return c.errors;
  }
  const frames = json;
  frames.forEach((f, i) => {
    const at = `frames.json[${i}]`;
    if (!c.obj(f, at)) return;
    const src = c.has(f, "src", `${at}.src`) && c.num(f.src, `${at}.src`, { min: 0 });
    const interp = c.has(f, "interp", `${at}.interp`) && c.bool(f.interp, `${at}.interp`);
    if (src && interp && f.interp === false && !Number.isInteger(f.src))
      c.fail(`${at}.src`, "a real frame (interp false) must be a whole source frame", f.src);
    if (c.has(f, "q", `${at}.q`) && c.nums(f.q, 4, `${at}.q`, "a quaternion [x, y, z, w]")) {
      const n = Math.hypot(...(f.q as number[]));
      if (Math.abs(n - 1) > 1e-3) c.fail(`${at}.q`, "expected a unit quaternion (length 1)", Number(n.toFixed(4)));
    }
    if (c.has(f, "f", `${at}.f`)) c.num(f.f, `${at}.f`, { gt: 0 });
  });
  if (c.errors.length) return c.errors;
  const fr = frames as ShowFrame[];
  const seg = court.video.segments;
  const all: [string, FrameRange][] = [["pass1", seg.pass1], ["pass2", seg.pass2], ["resume", seg.resume], ...seg.eases.map((e, i) => [`ease ${i}`, e.frames] as [string, FrameRange])];
  for (const [name, r] of all)
    if (r[1] >= fr.length) c.fail("frames.json", `expected an entry for every show frame: ${name} ends on show frame ${r[1]} but there are only ${fr.length} entries`);
  if (c.errors.length) return c.errors;
  // every ease ends on F, a real frame, with one camera (camera F)
  let camF: ShowFrame | null = null;
  seg.eases.forEach((e, i) => {
    const k = e.frames[1];
    const last = fr[k];
    if (Math.abs(last.src - court.video.freezeSource) > 1e-6)
      c.fail(`frames.json[${k}].src`, `ease ${i} must end on F (source frame ${court.video.freezeSource})`, last.src);
    if (last.interp) c.fail(`frames.json[${k}].interp`, "F is a real frame: expected false", last.interp);
    if (!camF) camF = last;
    else if (Math.abs(last.f - camF.f) > 1e-6 || last.q.some((x, n) => Math.abs(x - camF!.q[n]) > 1e-6))
      c.fail(`frames.json[${k}]`, `ease ${i} must end on camera F, the same camera as ease 0's last frame`);
  });
  return c.errors;
}

/** Every problem with a parsed video/cards.json, checked against court.json and frames.json; empty when it is valid. */
export function validateCards(json: unknown, court: Court, frames: readonly ShowFrame[]): string[] {
  const c = new Check();
  if (!Array.isArray(json) || json.length !== frames.length) {
    c.fail("cards.json", `expected one entry per show frame (${frames.length}, as frames.json)`, Array.isArray(json) ? json.length : json);
    return c.errors;
  }
  const { width, height } = court.camera;
  json.forEach((entry, i) => {
    const at = `cards.json[${i}]`;
    if (!c.obj(entry, at) || !c.has(entry, "cards", `${at}.cards`) || !c.list(entry.cards, `${at}.cards`)) return;
    const ids = new Set<string>();
    const orders = new Set<number>();
    const tiles: Box[] = [];
    entry.cards.forEach((card, k) => {
      const cp = `${at}.cards[${k}]`;
      if (!c.obj(card, cp)) return;
      if (c.has(card, "id", `${cp}.id`) && c.text(card.id, `${cp}.id`)) {
        if (ids.has(card.id)) c.fail(`${cp}.id`, "expected one card per person per frame", card.id);
        ids.add(card.id);
      }
      const kindOk = c.has(card, "kind", `${cp}.kind`) && c.oneOf(card.kind, ["person", "ball"] as const, `${cp}.kind`, '"person" or "ball"');
      if (c.has(card, "at", `${cp}.at`) && c.vec3(card.at, `${cp}.at`) && kindOk && card.kind === "person" && Math.abs(card.at[1]) > 0.02)
        c.fail(`${cp}.at`, "expected a person's foot point on the floor (y = 0)", card.at);
      if (c.has(card, "box", `${cp}.box`)) c.box(card.box, `${cp}.box`, width, height, "source frame");
      if (c.has(card, "tile", `${cp}.tile`) && c.nums(card.tile, 4, `${cp}.tile`, "a tile [u0, v0, u1, v1] 0-1 in the matte atlas")) {
        const t = card.tile as Box;
        if (!(t[0] < t[2] && t[1] < t[3]) || t.some((u) => u < 0 || u > 1)) c.fail(`${cp}.tile`, "expected [u0, v0, u1, v1] inside 0-1 with u0 < u1 and v0 < v1", t);
        else {
          if (tiles.some((o) => t[0] < o[2] && o[0] < t[2] && t[1] < o[3] && o[1] < t[3])) c.fail(`${cp}.tile`, "expected a tile no other card in this frame uses", t);
          tiles.push(t);
        }
      }
      if (c.has(card, "order", `${cp}.order`) && c.num(card.order, `${cp}.order`, { min: 0, int: true })) {
        if (orders.has(card.order)) c.fail(`${cp}.order`, "expected an order no other card in this frame has", card.order);
        orders.add(card.order);
      }
    });
  });
  return c.errors;
}

// ---------------- loading ----------------

/** A loaded, validated bundle: court.json, frames.json, cards.json, and where its files are. */
export interface CourtBundle {
  /** The folder URL court.json is in, ending in "/". */
  base: string;
  court: Court;
  frames: ShowFrame[];
  cards: ShowCards[];
  /** The absolute URL of a bundle path. */
  file(path: BundlePath): string;
}

/** Thrown by loadCourt for a bundle that fails validation; `errors` lists every problem. */
export class CourtFormatError extends Error {
  readonly errors: string[];
  constructor(url: string, errors: string[]) {
    super(`${url} is not a valid court bundle:\n  ${errors.join("\n  ")}`);
    this.name = "CourtFormatError";
    this.errors = errors;
  }
}

async function getJson(url: string, fetcher: typeof fetch): Promise<unknown> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`${url}: not JSON (${String(e)})`);
  }
}

/** A pre-built stream instead of the main one: `?show=small` (small) or `?hz=90` (hz90). */
export type StreamFallback = "small" | "hz90";

/**
 * The court with a pre-built stream swapped into `video`, so every module reads one view of the show: the small copy
 * changes only the file, codec and size (its regions are the main ones scaled by width; cards.json is
 * resolution-free, so it stays); the 90 Hz bake also brings its display rate, frames.json, cards.json, segments,
 * cutoff and its pass-2 speed when it has one. Null returns the court as it is. Throws when the bundle has no such
 * stream.
 */
export function chooseStream(court: Court, fallback: StreamFallback | null): Court {
  if (!fallback) return court;
  const fb = court.video.fallbacks[fallback];
  if (!fb) throw new Error(`this bundle has no ${fallback === "hz90" ? "90 Hz bake (video.fallbacks.hz90)" : "small copy (video.fallbacks.small)"}`);
  const s = fb.width / court.video.width;
  const scale = (r: Region): Region => [Math.round(r[0] * s), Math.round(r[1] * s), Math.round(r[2] * s), Math.round(r[3] * s)];
  const { live, plate, mattes } = court.video.regions;
  const video: ShowVideoInfo = { ...court.video, file: fb.file, codec: fb.codec, width: fb.width, height: fb.height, regions: { live: scale(live), plate: scale(plate), mattes: scale(mattes) } };
  if (fallback === "hz90") {
    const hz = court.video.fallbacks.hz90!;
    Object.assign(video, { displayHz: hz.displayHz, frames: hz.frames, cards: hz.cards, segments: hz.segments, cutoff: hz.cutoff, pass2Speed: hz.pass2Speed ?? court.video.pass2Speed });
  }
  return { ...court, video };
}

/**
 * Fetches and validates a court bundle. `url` is court.json's URL, or its folder ending in "/"; a relative URL is
 * resolved against the page (in node, pass an absolute one). `fallback` picks a pre-built stream (chooseStream): the
 * returned court, frames and cards are that stream's.
 */
export async function loadCourt(url: string, options: { fetcher?: typeof fetch; fallback?: StreamFallback | null } = {}): Promise<CourtBundle> {
  const fetcher = options.fetcher ?? fetch;
  const here = (globalThis as { location?: { href: string } }).location?.href;
  const courtUrl = new URL(url.endsWith("/") ? `${url}court.json` : url, here).href;
  const base = new URL("./", courtUrl).href;
  const json = await getJson(courtUrl, fetcher);
  const errors = validateCourt(json);
  if (errors.length) throw new CourtFormatError(courtUrl, errors);
  const court = chooseStream(json as Court, options.fallback ?? null);
  const framesUrl = new URL(court.video.frames, base).href;
  const frames = await getJson(framesUrl, fetcher);
  const frameErrors = validateFrames(frames, court);
  if (frameErrors.length) throw new CourtFormatError(framesUrl, frameErrors);
  const cardsUrl = new URL(court.video.cards, base).href;
  const cards = await getJson(cardsUrl, fetcher);
  const cardErrors = validateCards(cards, court, frames as ShowFrame[]);
  if (cardErrors.length) throw new CourtFormatError(cardsUrl, cardErrors);
  return { base, court, frames: frames as ShowFrame[], cards: cards as ShowCards[], file: (path) => new URL(path, base).href };
}
