// The one world-space light field (3.3, 3.3a: House Lights' pool on Same Pixels' timing): the crowd's level, the floor
// outside the pool, the pair (always 1), the stands, and the growing pool (the real footprint plus a lane to the
// viewer's feet and the walking floor round the pair, each floor point brightening on its own curve nearest the pair
// first, penumbra >= 1.5 m, dark beyond; it never opens to the whole floor). One GLSL chunk multiplies every footage,
// floor and stands material (proxies.ts, world.ts) and one Spark dyno modifier multiplies every splat mesh
// (freeze.ts, `worldModifiers`, SplatMesh.d.ts:37-38), so footage and splats get the same numbers; dark gradients are
// dithered (the 8-bit panel bands). A CPU `at(x, z)` gives the same number for the tests. Levels come from court.json
// `light` (perceived brightness, 1 = as filmed; the shaders get linear multipliers). Pure (type-only imports), so
// lightfield.test.ts can load it under node. Stream E (`look`) builds it, from House Lights' FIELD_GLSL and splatK
// (court-spikes/proto-house-lights/webxr/src/proto/directions/house-lights.ts).
//
// P44 sets every duration: no light change may move a pixel's 8-bit value (three's exact sRGB encode, then the
// dither) more than 1 grey level per display frame at 72 Hz (or 90). Levels are display-referred: a level q becomes the
// linear multiplier q^2.4, so a surface's encoded value moves at a constant K(grey) per unit of q (K = 184 for a
// grey-170 surface: 255 x 1.055 x c^(1/2.4), c its linear value). Every change follows the ramp below (peak slope
// 1.11 / T), and lasts long enough to keep 184 x 1.11 x dq / T under 72 a second for a grey-170 surface (SAFE_GREY):
// the crowd's 0.52 over 1.8 s from the ease start (it lands at F+0.6 after the 1.2 s ease), the floor's 0.67 over
// 2.2 s (F+1, under the hand-off, which multiplies the video and the 3D by the same numbers), and every pool point at
// 1.11 / 3.0 s per unit of its own change, so the farthest land at F+5. lightfield.test.ts checks the encoded bytes,
// dither included, at 72 and 90 Hz. The hardwood is grey ~140.
import type * as THREE from "three";
import type { GsplatModifier, SplatMesh } from "@sparkjsdev/spark";
import type { dyno } from "@sparkjsdev/spark";
import type { PinholeCamera } from "./camera";
import type { Court, CourtBundle, LightLevels, Quat, ShowFrame, Vec3 } from "./format";

/** True once stream E has built this module. */
export const BUILT = true;

/**
 * What the field is doing; `set(beat, t)` takes seconds into the beat:
 * - "dark": the arrival's hold, everything at 0; "arrival": the lights come up over ARRIVAL_S, evenly on the encoded value (arrivalLevel, P44);
 * - "watch": the arena as filmed (the pool is the spot on the pair);
 * - "ease": t since the ease began: the crowd goes to light.crowd over the ease, the floor outside the pool to
 *   light.floor over FLOOR_DIM_S (it lands at F+1, under the hand-off), the pair at 1;
 * - "handoff" (alias "open"): t from F: the time stop lands, the pool grows F+1..F+5, the stands rise to light.stands
 *   F+3..F+5; t < 0 is ignored (the ease drives the field until F);
 * - "return" (alias "back"): t since Back to my seat: the stands go down and the pool gathers onto the pair (done by
 *   BACK_DONE_S, under the room fade);
 * - "resume": t since play resumed: the house comes up UP_LAG_S later.
 * "handoff" carries the floor's dim on from where the last "ease" left it (with no ease before it, the dims start at
 * F), so the field is a function of the beats called, deterministic for a recording.
 */
export type Beat = "dark" | "arrival" | "watch" | "ease" | "handoff" | "return" | "resume" | "open" | "back";
/** The same beats (the name stream D first coded against). */
export type LightBeat = Beat;

/** The field now (`levels`): linear multipliers, 1 = as filmed. */
export interface FieldState {
  crowd: number;
  floor: number;
  pair: number;
  stands: number;
  /** The pool on the floor: centre (court x, z), the growth's reach so far and the soft edge, metres. */
  pool: { centre: [number, number]; radius: number; penumbra: number };
}

/** What a footage, floor or stands pixel is, for the GLSL chunk's `courtLight(worldPos, part)`. */
export const PART = { floor: 0, crowd: 1, stands: 2, person: 3 } as const;

/** Which of court.json's two sets: the first, or `light.alternative` (`?light=alt`, world.ts). */
export type LightSet = "main" | "alternative";

/** The field's configured levels at the freeze (perceived; court.json `light`, the chosen set). */
export interface LightConfig {
  crowd: number;
  floor: number;
  pair: number;
  stands: number;
  penumbra: number;
}

/** The lights come up over this long (court.ts LIGHTS_UP_S). */
export const ARRIVAL_S = 2.5;
/** The crowd goes down over this from the ease start (P28's ease is 1.2 s; P44 needs 1.8 s for grey 170); up on resume. */
export const CROWD_DIM_S = 1.8;
/** The floor outside the pool goes down over this, from the ease start (F+1 after the 1.2 s ease); up on resume. */
export const FLOOR_DIM_S = 2.2;
/** The pool starts growing at F + this. */
export const POOL_START_S = 1.0;
/** A pool point whose level changes by the whole 0 -> 1 takes this long (a smaller change proportionally less). */
export const POOL_RAMP_S = 3.0;
/** The pool's starts spread over this, nearest the pair first. */
export const POOL_SPREAD_S = 1.0;
/** The stands rise to `stands` over F+3..F+5. */
export const STANDS_START_S = 3.0;
export const STANDS_S = 2.0;
/** Seconds into "handoff" by which every light change has landed (handoff.ts HANDOFF_END must reach it). */
export const OPEN_DONE_S = 5.0;
/** "return" runs "handoff" backwards from OPEN_DONE_S to the pool's start: done by this. */
export const BACK_DONE_S = OPEN_DONE_S - POOL_START_S;
/** The house comes up this long after play resumes. */
export const UP_LAG_S = 0.25;
/** The brightest surface (sRGB grey, 0-255) every light change keeps under 1 grey level per frame at 72 Hz. */
export const SAFE_GREY = 170;

/** The ramp every light change follows: eased in and out over its first and last 10%, peak slope 1.11. */
const EDGE = 0.1;
/** The pool's core: a lane this wide (half-width, m) from the pair to the seat, and the walking floor round the pair. */
const LANE_HALF = 0.9;
/** The walking anchoring puts the pair at the room's centre (seatmath): the judge walks within this of it, metres. */
const WALK_R = 2.5;
/** A disc this big round each walking spot (spots(), from seat.layout()), metres. */
const SPOT_DISC = 0.9;
/** The spot that holds the pair through the time stop: their bounds plus this margin, metres. */
const SPOT_MARGIN = 0.5;
/** The soft edge runs over penumbra x this, so that from 99% lit to the dark is at least the penumbra. */
const FALLOFF = 1.25;

/** One person's light for the splat modifier: the pair (light.pair), or anyone else by the floor under their feet. */
export type LightPerson = { pair: true } | { foot: [number, number]; reach?: number };

/** The shared uniforms: merge into a ShaderMaterial's `uniforms` (or a patched material's shader.uniforms). */
export type LightUniforms = Record<string, THREE.IUniform>;

/** A display level from a linear multiplier (and back): q^2.4, so the encoded value moves evenly with q. */
export const perceived = (k: number): number => Math.pow(Math.max(0, k), 1 / 2.4);
export const linear = (p: number): number => Math.pow(Math.max(0, p), 2.4);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** sRGB (0-1) to linear light: three's decode. */
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * The arrival's level s of the way up (0-1 of ARRIVAL_S): the level at which a SAFE_GREY surface's encoded value is
 * s of its own, so it rises evenly (P44): 170 levels over 2.5 s is 0.94 a frame at 72 Hz; any darker grey rises slower.
 */
export function arrivalLevel(s: number): number {
  const g = SAFE_GREY / 255;
  return perceived(srgbToLinear(g * clamp01(s)) / srgbToLinear(g));
}
/** GLSL smoothstep. */
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** The ramp (GLSL lightRamp): eased in and out over EDGE, linear between. */
export function ramp(u: number): number {
  const x = clamp01(u);
  const k = 1 / (2 * EDGE * (1 - EDGE));
  if (x < EDGE) return x * x * k;
  if (x > 1 - EDGE) return 1 - (1 - x) * (1 - x) * k;
  return (x - 0.5 * EDGE) / (1 - EDGE);
}
/** Signed distance (approximate: exact on the axes) from q to an ellipse of half-sizes h, centred at the origin. */
function ellipse(qx: number, qy: number, hx: number, hy: number): number {
  const l = Math.hypot(qx / hx, qy / hy);
  const g = Math.hypot(qx / (hx * hx), qy / (hy * hy));
  return g > 1e-6 ? (l * (l - 1)) / g : -Math.min(hx, hy);
}

/** The configured levels: court.json `light` (the first set, or `alternative`); the penumbra never below 1.5 m. */
export function lightLevels(court: Court, set: LightSet = "main"): LightConfig {
  const l: LightLevels = court.light;
  const alt = set === "alternative";
  return {
    crowd: alt ? l.alternative.crowd : l.crowd,
    floor: alt ? l.alternative.floor : l.floor,
    pair: l.pair,
    stands: l.stands,
    penumbra: Math.max(1.5, l.penumbra),
  };
}

/** v rotated by the unit quaternion q (camera.ts's rotate; repeated here so this module stays type-only on siblings). */
function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/**
 * Vertex helper for any material that wants court-space positions: `uniform mat4 uLightCourtFromWorld;
 * varying vec3 vLightCourt; vec3 lightCourt(vec4 worldPos)`; in main `vLightCourt = lightCourt(modelMatrix *
 * vec4(transformed, 1.0));` (the world group's inverse is applied for you; declare `varying vec3 vLightCourt;` in the
 * fragment shader too).
 */
const GLSL_VERTEX = /* glsl */ `
uniform mat4 uLightCourtFromWorld;
varying vec3 vLightCourt;
vec3 lightCourt(vec4 worldPos) { return (uLightCourtFromWorld * worldPos).xyz; }
`;

const GLSL_FRAGMENT = /* glsl */ `
uniform vec4 uLightLevel; // perceived: floor outside the pool, crowd, pair; arrival (all x it)
uniform vec4 uLightFrame; // the pair's centre x, z; unit axis x, z (pair -> seat)
uniform vec4 uLightSpot;  // the spot on the pair: offset along the axis, half across, half along; falloff (m)
uniform vec4 uLightFoot;  // the footprint: offset along, half across, half along; the lane's half-width
uniform vec4 uLightLane;  // seat distance; the walking disc's radius; walking spots (0-4); the growth's reach (m)
uniform vec4 uLightSpotsA; // walking spots 0, 1 (x, z each), court space
uniform vec4 uLightSpotsB; // walking spots 2, 3
uniform vec4 uLightGrow;  // seconds into the growth; ramp s for a whole change; spread s; ramp edge
uniform vec4 uLightView;  // unused; the arena's opacity: stands, floor (See my room, the edge); unused
float lightRamp(float u, float a) {
  u = clamp(u, 0.0, 1.0);
  float k = 1.0 / (2.0 * a * (1.0 - a));
  if (u < a) return u * u * k;
  if (u > 1.0 - a) return 1.0 - (1.0 - u) * (1.0 - u) * k;
  return (u - 0.5 * a) / (1.0 - a);
}
float lightEllipse(vec2 q, vec2 h) {
  float l = length(q / h);
  float g = length(q / (h * h));
  return g > 1e-6 ? l * (l - 1.0) / g : -min(h.x, h.y);
}
vec2 lightLocal(vec2 xz) {
  vec2 d = xz - uLightFrame.xy;
  return vec2(dot(d, vec2(-uLightFrame.w, uLightFrame.z)), dot(d, uLightFrame.zw));
}
float lightSpotOf(vec2 xz) {
  vec2 q = lightLocal(xz);
  return 1.0 - smoothstep(0.0, uLightSpot.w, lightEllipse(q - vec2(0.0, uLightSpot.x), uLightSpot.yz));
}
float lightShape(vec2 xz) {
  vec2 q = lightLocal(xz);
  float s = lightEllipse(q - vec2(0.0, uLightFoot.x), uLightFoot.yz);
  s = min(s, length(vec2(q.x, q.y - clamp(q.y, 0.0, uLightLane.x))) - uLightFoot.w);
  s = min(s, length(q) - uLightLane.y);
  if (uLightLane.z > 0.5) s = min(s, distance(xz, uLightSpotsA.xy) - ${SPOT_DISC.toFixed(2)});
  if (uLightLane.z > 1.5) s = min(s, distance(xz, uLightSpotsA.zw) - ${SPOT_DISC.toFixed(2)});
  if (uLightLane.z > 2.5) s = min(s, distance(xz, uLightSpotsB.xy) - ${SPOT_DISC.toFixed(2)});
  if (uLightLane.z > 3.5) s = min(s, distance(xz, uLightSpotsB.zw) - ${SPOT_DISC.toFixed(2)});
  return s;
}
// o: the point's level outside the pool; each point's ramp is as long as its own change needs (P44)
float lightPool(vec2 xz, float o) {
  float spot = lightSpotOf(xz);
  float mask = 1.0 - smoothstep(0.0, uLightSpot.w, lightShape(xz));
  float delay = clamp(distance(xz, uLightFrame.xy) / uLightLane.w, 0.0, 1.0) * uLightGrow.z;
  float change = (1.0 - o) * (1.0 - spot) * mask;
  float grow = lightRamp((uLightGrow.x - delay) / max(uLightGrow.y * change, 0.05), uLightGrow.w);
  return spot + (1.0 - spot) * mask * grow;
}
// the floor at court xz; reach = the rendered court's darkness falloff outside the frame (1 on the footage's surfaces)
float lightFloor(vec2 xz, float reach) {
  float o = uLightLevel.x * reach;
  return pow(mix(o, 1.0, lightPool(xz, o)) * uLightLevel.w, 2.4);
}
float lightCrowd() { return pow(uLightLevel.y * uLightLevel.w, 2.4); }
float lightHouse() { return lightCrowd(); }
float lightPair() { return pow(uLightLevel.z * uLightLevel.w, 2.4); }
float lightAt(vec2 foot) { return lightFloor(foot, 1.0); }
// the multiplier for a footage, floor or stands fragment at a court-space position (part: PART.*)
float courtLight(vec3 worldPos, float part) {
  if (part < 0.5) return lightFloor(worldPos.xz, 1.0);
  if (part < 2.5) return lightCrowd();
  return lightAt(worldPos.xz);
}
float lightRoomStands() { return uLightView.y; }
float lightRoomFloor() { return uLightView.z; }
float lightIgn(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec3 lightDither(vec3 rgb) {
  float n = lightIgn(gl_FragCoord.xy) + lightIgn(gl_FragCoord.xy + vec2(17.0, 59.0)) - 1.0;
  return rgb + n / 255.0;
}
`;

/** Splat colours are sRGB-encoded: decode exactly, multiply in linear light (as the footage path does), re-encode. */
const GLSL_SPLAT = /* glsl */ `
vec3 lightSplatRgb(vec3 c, float k) {
  if (k > 0.99999) return c;
  c = clamp(c, 0.0, 1.0);
  vec3 lin = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)) * k;
  return mix(lin * 12.92, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), lin));
}
`;

/** The Spark dyno namespace, handed to modifier() by its caller (freeze.ts), so this module never imports Spark. */
export type DynoApi = typeof dyno;

interface Attached {
  mesh: SplatMesh;
  person: LightPerson;
  k: { value: number };
}

/** A vec4 uniform's value (three uploads any { x, y, z, w }), so this module needs no three at runtime. */
class Vec4 {
  constructor(public x = 0, public y = 0, public z = 0, public w = 0) {}
  set(x: number, y: number, z: number, w: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }
}

export class LightField {
  /** The field now (after the last set()): linear multipliers and the pool. */
  readonly levels: FieldState;
  /** The configured levels (court.json `light`, the chosen set; perceived). */
  config: LightConfig;
  /**
   * GLSL (fragment globals): the uniforms and `float courtLight(vec3 worldPos, float part)` (part: PART.*), the
   * multiplier for a footage, floor or stands fragment at a court-space position; also lightFloor(xz, reach),
   * lightCrowd(), lightPair(), lightAt(foot), lightRoomStands() / lightRoomFloor() (See my room and the edge: 1 =
   * arena, 0 = room) and lightDither(rgb) (+-0.5 LSB on the 8-bit output, after the colour-space conversion).
   * Every material includes it and shares `uniforms`. Multiply the linear colour before three's sRGB encode.
   */
  readonly glsl: string = GLSL_FRAGMENT;
  /** Optional vertex helper (court-space positions through the world group): see GLSL_VERTEX. */
  readonly glslVertex: string = GLSL_VERTEX;
  /** The uniforms `glsl` reads; one object, shared by every material (set() updates it in place). */
  readonly uniforms: LightUniforms;
  /** The seat's floor point (court space): on camera F's ray, D' from the pair. */
  seatFloor: Vec3;
  /** Unit floor direction from the pair to the seat [x, z]. */
  axis: [number, number];
  /** The pair's centre on the floor [x, z] (court space). */
  readonly pairXZ: [number, number];
  /** The players' white point, linear [r, g, b] with g = 1 (freeze.ts sets it; the arena's lights take it, P13). */
  white: [number, number, number] = [1, 1, 1];
  /** The show frame's reach (world.ts): the darkness falloff under an extra's feet, for their splats. */
  reach: ReachPlanes | null = null;
  /** The last beat and its t (the e2e report). */
  beat: Beat = "watch";
  t = 0;
  private readonly court: Court;
  private readonly attached: Attached[] = [];
  private inverse: THREE.Matrix4 | null = null;
  // the state the uniforms hold, perceived
  private floorOut = 1;
  private crowdLevel = 1;
  private arrival = 1;
  private grow = -1e3; // seconds into the pool's growth (negative: not started)
  /** The ease's own t when it ended, so "handoff" carries the floor dim on (0: no ease seen, the dims start at F). */
  private easeAtF = 0;
  // the pool's shape (court metres; the uniforms carry the same numbers)
  private spot: [number, number, number] = [0, 0.8, 0.8];
  private foot: [number, number, number] = [0, 2, 2];
  private seatDist: number;
  private reachR = 1;
  private discs: [number, number][] = [];
  // scratch for local()
  private lu = 0;
  private lv = 0;
  /** The levels when the current beat began (return, resume and ease start from wherever the light was). */
  private from = { beat: "watch" as Beat, floor: 1, crowd: 1, grow: -1e3, easeFloor: 1, easeCrowd: 1 };
  private falloff: number;

  /** One field per bundle (the first call's options win). */
  static shared(bundle: CourtBundle, opts: { set?: LightSet; seatDistance?: number } = {}): LightField {
    let f = fields.get(bundle);
    if (!f) fields.set(bundle, (f = new LightField(bundle, opts)));
    return f;
  }

  /**
   * From court.json alone (court.ts), or the bundle (camera F's own footprint from frames.json; else fitFrames()
   * refines it once a module with the bundle calls it).
   */
  constructor(source: Court | CourtBundle, opts: { set?: LightSet; seatDistance?: number } = {}) {
    const bundle = "court" in source && "frames" in source ? (source as CourtBundle) : null;
    const court = bundle ? bundle.court : (source as Court);
    this.court = court;
    this.config = lightLevels(court, opts.set);
    this.falloff = this.config.penumbra * FALLOFF;
    const pc = court.seat.pairCentre;
    this.pairXZ = [pc[0], pc[2]];
    const dx = court.camera.centre[0] - pc[0];
    const dz = court.camera.centre[2] - pc[2];
    const dl = Math.hypot(dx, dz) || 1;
    this.axis = [dx / dl, dz / dl];
    this.seatDist = court.seat.distance;
    this.seatFloor = [pc[0] + this.axis[0] * this.seatDist, 0, pc[2] + this.axis[1] * this.seatDist];
    this.levels = { crowd: 1, floor: 1, pair: 1, stands: 1, pool: { centre: [pc[0], pc[2]], radius: 0, penumbra: this.config.penumbra } };
    this.uniforms = {
      uLightCourtFromWorld: { value: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } },
      uLightLevel: { value: new Vec4(1, 1, this.config.pair, 1) },
      uLightFrame: { value: new Vec4() },
      uLightSpot: { value: new Vec4() },
      uLightFoot: { value: new Vec4() },
      uLightLane: { value: new Vec4() },
      uLightSpotsA: { value: new Vec4() },
      uLightSpotsB: { value: new Vec4() },
      uLightGrow: { value: new Vec4(this.grow, POOL_RAMP_S, POOL_SPREAD_S, EDGE) },
      uLightView: { value: new Vec4(1, 1, 1, 0) },
    };
    this.select(opts);
    if (bundle) this.fitFrames(bundle.frames);
    this.push();
  }

  /** The level set (`?light=alt`) and D' (`?seat=` within seat.distanceRange); world.ts reads the URL. */
  select(opts: { set?: LightSet; seatDistance?: number }): void {
    const court = this.court;
    if (opts.set) {
      this.config = lightLevels(court, opts.set);
      this.falloff = this.config.penumbra * FALLOFF;
    }
    const [lo, hi] = court.seat.distanceRange;
    const d = opts.seatDistance;
    if (d !== undefined && Number.isFinite(d)) this.seatDist = Math.min(hi, Math.max(lo, d));
    const pc = court.seat.pairCentre;
    this.seatFloor = [pc[0] + this.axis[0] * this.seatDist, 0, pc[2] + this.axis[1] * this.seatDist];
    this.shape(this.foot[1], this.foot[0] + this.foot[2]);
  }

  /** Camera F's own footprint and ray from frames.json (the last frame of the first ease is F). */
  fitFrames(frames: readonly ShowFrame[]): void {
    const court = this.court;
    const fIndex = court.video.segments.eases[0]?.frames[1] ?? court.video.segments.pass2[1];
    const camF = frames[Math.min(frames.length - 1, Math.max(0, fIndex))];
    if (!camF) return;
    const pc = court.seat.pairCentre;
    const fwd = rotate(camF.q, [0, 0, 1]);
    const fl = Math.hypot(fwd[0], fwd[2]) || 1;
    this.axis = [-fwd[0] / fl, -fwd[2] / fl]; // back along the ray, toward the camera and the seat
    this.seatFloor = [pc[0] + this.axis[0] * this.seatDist, 0, pc[2] + this.axis[1] * this.seatDist];
    // the real footprint: camera F's frame across at the pair's depth, from where its bottom edge meets the floor
    // (toward the seat) to as far beyond the pair
    const cc = court.camera.centre;
    const depth = Math.max(1, (pc[0] - cc[0]) * fwd[0] + (pc[1] - cc[1]) * fwd[1] + (pc[2] - cc[2]) * fwd[2]);
    const across = Math.min(4, Math.max(1.5, (court.camera.width / 2 / camF.f) * depth));
    const bottom = rotate(camF.q, [0, (court.camera.height - 1 - court.camera.cy) / camF.f, 1]);
    let near = across;
    if (bottom[1] < -1e-6) {
      const s = -cc[1] / bottom[1];
      this.local(cc[0] + bottom[0] * s, cc[2] + bottom[2] * s);
      near = this.lv;
    }
    this.shape(across, Math.min(8, Math.max(1.5, near)));
    this.push();
  }

  /** The pool's shape from the footprint's half-width across and its near reach toward the seat. */
  private shape(across: number, near: number): void {
    const pc = this.court.seat.pairCentre;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of this.court.freeze.players)
      for (const x of [p.bounds.min[0], p.bounds.max[0]])
        for (const z of [p.bounds.min[2], p.bounds.max[2]]) {
          this.local(x, z);
          u0 = Math.min(u0, this.lu); u1 = Math.max(u1, this.lu); v0 = Math.min(v0, this.lv); v1 = Math.max(v1, this.lv);
        }
    if (!Number.isFinite(u0)) [u0, u1, v0, v1] = [-0.5, 0.5, -0.5, 0.5];
    this.spot = [(v0 + v1) / 2, Math.max(0.8, (u1 - u0) / 2 + SPOT_MARGIN), Math.max(0.8, (v1 - v0) / 2 + SPOT_MARGIN)];
    this.foot = [(near - across) / 2, across, (near + across) / 2];
    // the growth's reach: the farthest core point from the pair, so every start falls inside the spread
    this.reachR = Math.max(this.seatDist, near, across, WALK_R);
    const u = this.uniforms;
    (u.uLightFrame.value as Vec4).set(pc[0], pc[2], this.axis[0], this.axis[1]);
    (u.uLightSpot.value as Vec4).set(this.spot[0], this.spot[1], this.spot[2], this.falloff);
    (u.uLightFoot.value as Vec4).set(this.foot[0], this.foot[1], this.foot[2], LANE_HALF);
    (u.uLightLane.value as Vec4).set(this.seatDist, WALK_R, this.discs.length, this.reachR);
  }

  /** Court (x, z) in the pool's frame, into this.lu (across) and this.lv (along toward the seat): no allocation. */
  private local(x: number, z: number): void {
    const dx = x - this.pairXZ[0];
    const dz = z - this.pairXZ[1];
    this.lu = -this.axis[1] * dx + this.axis[0] * dz;
    this.lv = this.axis[0] * dx + this.axis[1] * dz;
  }

  /**
   * The walking spots (court space, at most 4; court.ts from seat.layout() whenever it changes): the pool also covers
   * a disc round each, so wherever the judge is walked to stands in the light.
   */
  spots(points: readonly Vec3[]): void {
    this.discs = points.slice(0, 4).map((p) => [p[0], p[2]] as [number, number]);
    const d = (i: number): [number, number] => this.discs[i] ?? [0, 0];
    (this.uniforms.uLightSpotsA.value as Vec4).set(...d(0), ...d(1));
    (this.uniforms.uLightSpotsB.value as Vec4).set(...d(2), ...d(3));
    this.reachR = Math.max(this.reachR, ...this.discs.map(([x, z]) => Math.hypot(x - this.pairXZ[0], z - this.pairXZ[1]) + SPOT_DISC));
    (this.uniforms.uLightLane.value as Vec4).set(this.seatDist, WALK_R, this.discs.length, this.reachR);
    this.push();
  }

  /**
   * Move the field to `t` seconds into `beat` (see Beat). The ease, the hand-off without an ease, the walk back and
   * the resume start from wherever the light is when the beat begins and ease from there, so an interrupted change
   * never jumps (dark, arrival and watch set the arena outright: they're called when it's black or already as filmed).
   */
  set(beat: Beat, t: number): void {
    const L = this.config;
    const b: Beat = beat === "open" ? "handoff" : beat === "back" ? "return" : beat;
    if (b === "handoff" && t < 0) return; // the ease drives the field until F
    const f = this.from;
    if (b !== f.beat) {
      // a new beat: remember where the light is (the hand-off after an ease carries the ease's own curves on)
      if (!(b === "handoff" && f.beat === "ease")) {
        f.floor = this.floorOut;
        f.crowd = this.crowdLevel;
        f.grow = this.grow;
        if (b === "ease" || b === "handoff") {
          f.easeFloor = this.floorOut;
          f.easeCrowd = this.crowdLevel;
          this.easeAtF = 0;
        }
      }
      f.beat = b;
    }
    this.beat = beat;
    this.t = t;
    this.arrival = b === "dark" ? 0 : b === "arrival" ? arrivalLevel(t / ARRIVAL_S) : 1;
    const toward = (a: number, z: number, u: number) => a + (z - a) * ramp(u);
    switch (b) {
      case "dark":
      case "arrival":
      case "watch":
        this.floorOut = 1;
        this.crowdLevel = 1;
        this.grow = -1e3;
        this.easeAtF = 0;
        break;
      case "ease":
        this.floorOut = toward(f.easeFloor, L.floor, t / FLOOR_DIM_S);
        this.crowdLevel = toward(f.easeCrowd, L.crowd, t / CROWD_DIM_S);
        // a pool still open (an ease after the resume) gathers onto the pair at the pool's own pace
        this.grow = f.grow > -1e2 ? f.grow - t : -1e3;
        this.easeAtF = t;
        break;
      case "handoff": {
        const e = this.easeAtF + t;
        this.floorOut = toward(f.easeFloor, L.floor, e / FLOOR_DIM_S);
        this.crowdLevel = t < STANDS_START_S ? toward(f.easeCrowd, L.crowd, e / CROWD_DIM_S) : toward(L.crowd, L.stands, (t - STANDS_START_S) / STANDS_S);
        this.grow = Math.max(t - POOL_START_S, f.grow);
        break;
      }
      case "return":
        this.floorOut = toward(f.floor, L.floor, t / FLOOR_DIM_S);
        this.crowdLevel = toward(f.crowd, L.crowd, t / STANDS_S);
        this.grow = f.grow > -1e2 ? f.grow - t : -1e3;
        break;
      case "resume": {
        const up = t - UP_LAG_S;
        this.floorOut = toward(f.floor, 1, up / FLOOR_DIM_S);
        this.crowdLevel = toward(f.crowd, 1, up / CROWD_DIM_S);
        this.grow = f.grow; // held: the floor coming up covers it
        break;
      }
    }
    this.push();
  }

  /** Once a frame: the world group (court -> room), whose inverse takes room points back to court space. */
  frame(world: THREE.Object3D): void {
    world.updateWorldMatrix(true, false);
    this.inverse ??= world.matrixWorld.clone();
    this.inverse.copy(world.matrixWorld).invert();
    (this.uniforms.uLightCourtFromWorld.value as { elements: ArrayLike<number> }).elements = this.inverse.elements;
  }

  /** The arena's opacity, stands and darkness first, then the floor (world.ts: See my room and the edge fade). */
  room(stands: number, floor: number): void {
    const v = this.uniforms.uLightView.value as Vec4;
    v.y = clamp01(stands);
    v.z = clamp01(floor);
  }

  /** The arena's opacity now (1 = arena, 0 = room). */
  arenaOpacity(): { stands: number; floor: number } {
    const v = this.uniforms.uLightView.value as Vec4;
    return { stands: v.y, floor: v.z };
  }

  /** The show frame's reach changed (world.ts): the extras' splats follow the floor under their feet. */
  setReach(r: ReachPlanes): void {
    this.reach = r;
    this.push();
  }

  /** The players' white point from their splat colours (freeze.ts; see whitePoint). */
  setWhite(colors: ArrayLike<number>): void {
    this.white = whitePoint(colors);
  }

  /**
   * The field's dyno modifier, appended to a splat mesh's worldModifiers: its colour decoded, multiplied by the
   * person's light in linear light (the footage path's maths) and re-encoded; the mesh is regenerated only when that
   * light moves (the pair never). Needs the mesh, the person and Spark's `dyno` (this module never imports Spark);
   * without them there is nothing to apply: null.
   */
  modifier(mesh?: SplatMesh, person?: LightPerson, api?: DynoApi): GsplatModifier | null {
    if (!mesh || !person || !api) return null;
    const k = api.dynoFloat(this.personLight(person));
    const relight = new api.Dyno({
      inTypes: { gsplat: api.Gsplat, k: "float" },
      outTypes: { gsplat: api.Gsplat },
      inputs: { k },
      globals: () => [api.defineGsplat, GLSL_SPLAT],
      statements: ({ inputs, outputs }) => {
        const { gsplat: out } = outputs;
        if (!out) return [];
        return [`${out} = ${inputs.gsplat};`, `${out}.rgba.rgb = lightSplatRgb(${out}.rgba.rgb, ${inputs.k});`];
      },
    });
    const modifier = api.dynoBlock({ gsplat: api.Gsplat }, { gsplat: api.Gsplat }, ({ gsplat }) => ({
      gsplat: relight.apply({ gsplat }).gsplat,
    }));
    mesh.worldModifiers = [...(mesh.worldModifiers ?? []), modifier];
    mesh.updateGenerator();
    this.attached.push({ mesh, person, k });
    return modifier;
  }

  /**
   * The multiplier at a floor point (court x, z) for `part`, exactly as the GLSL computes it (courtLight; with
   * `reach` for the floor, lightFloor(xz, reach)).
   */
  at(x: number, z: number, part: number = PART.floor, reach = 1): number {
    if (part === PART.crowd || part === PART.stands) return this.crowd();
    const o = this.floorOut * (part === PART.floor ? reach : 1);
    return linear((o + (1 - o) * this.pool(x, z, o)) * this.arrival);
  }

  /** The crowd's linear multiplier now (lightCrowd()). */
  crowd(): number {
    return linear(this.crowdLevel * this.arrival);
  }

  /** The pair's linear multiplier now (lightPair()). */
  pair(): number {
    return linear(this.config.pair * this.arrival);
  }

  /** The crowd's perceived level and the arrival's, now (world.ts's house lights). */
  get crowdLevelNow(): number {
    return this.crowdLevel;
  }
  get arrivalNow(): number {
    return this.arrival;
  }

  /** A person's linear multiplier: the pair's, or the floor's under their feet (with that floor's darkness falloff). */
  personLight(person: LightPerson): number {
    if ("pair" in person) return this.pair();
    const reach = person.reach ?? (this.reach ? reachAtXYZ(this.reach, person.foot[0], 0, person.foot[1]) : 1);
    return this.at(person.foot[0], person.foot[1], PART.floor, reach);
  }

  /**
   * The courtside plate's dim for a viewer at court (x, z) (P30): 0 on camera F's ray, 1 (dark) by OFF_RAY_DARK_DEG
   * off it, for Proxies.dim(p). The angle is taken at a pivot OFF_RAY_PIVOT beyond the pair (away from the seat), so
   * it stays steady when you stand by the players.
   */
  offRayAt(x: number, z: number): number {
    const px = this.pairXZ[0] - this.axis[0] * OFF_RAY_PIVOT;
    const pz = this.pairXZ[1] - this.axis[1] * OFF_RAY_PIVOT;
    const hx = x - px;
    const hz = z - pz;
    const along = hx * this.axis[0] + hz * this.axis[1];
    const across = Math.abs(hx * this.axis[1] - hz * this.axis[0]);
    return ramp(((Math.atan2(across, along) * 180) / Math.PI) / OFF_RAY_DARK_DEG);
  }

  /** The pool at (x, z), 0..1 (GLSL lightPool); o = that point's level outside the pool. */
  private pool(x: number, z: number, o: number): number {
    this.local(x, z);
    const u = this.lu;
    const v = this.lv;
    const spot = 1 - smoothstep(0, this.falloff, ellipse(u, v - this.spot[0], this.spot[1], this.spot[2]));
    let s = ellipse(u, v - this.foot[0], this.foot[1], this.foot[2]);
    s = Math.min(s, Math.hypot(u, v - Math.min(this.seatDist, Math.max(0, v))) - LANE_HALF);
    s = Math.min(s, Math.hypot(u, v) - WALK_R);
    for (const [sx, sz] of this.discs) s = Math.min(s, Math.hypot(x - sx, z - sz) - SPOT_DISC);
    const mask = 1 - smoothstep(0, this.falloff, s);
    const delay = clamp01(Math.hypot(x - this.pairXZ[0], z - this.pairXZ[1]) / this.reachR) * POOL_SPREAD_S;
    const change = (1 - o) * (1 - spot) * mask;
    const grow = ramp((this.grow - delay) / Math.max(POOL_RAMP_S * change, 0.05));
    return spot + (1 - spot) * mask * grow;
  }

  /** Write the state into the uniforms, `levels` and the splat modifiers (regenerating only meshes whose light moved). */
  private push(): void {
    (this.uniforms.uLightLevel.value as Vec4).set(this.floorOut, this.crowdLevel, this.config.pair, this.arrival);
    (this.uniforms.uLightGrow.value as Vec4).x = this.grow;
    const s = this.levels;
    s.crowd = this.crowd();
    s.stands = s.crowd;
    s.pair = this.pair();
    s.floor = linear(this.floorOut * this.arrival);
    s.pool.radius = clamp01(this.grow / (POOL_SPREAD_S + POOL_RAMP_S)) * this.reachR;
    s.pool.penumbra = this.config.penumbra;
    for (const a of this.attached) {
      const k = this.personLight(a.person);
      if (k !== a.k.value) {
        // every change, as the GLSL's uniforms take every change: the 3D never lags the footage by a frame
        a.k.value = k;
        a.mesh.updateVersion();
      }
    }
  }
}

const fields = new WeakMap<CourtBundle, LightField>();

// ---------------- the arena's maths (world.ts draws it; the numbers live here so node can test them) ----------------

/** The courtside plate is dark this far off camera F's ray, degrees (P30, tuned by eye). */
export const OFF_RAY_DARK_DEG = 45;
/** The off-ray angle's pivot: this far beyond the pair, metres. */
export const OFF_RAY_PIVOT = 1.0;

/**
 * See my room (3.6), as functions of court.ts's roomP (0 -> 1 over 0.6 s out, 1 -> 0 over 0.8 s back): out, the
 * darkness and stands go over 0-0.4 s and the floor over 0.2-0.6 s; back, the same curves run the other way, so the
 * floor returns first.
 */
export function roomCurves(p: number): { stands: number; floor: number } {
  const x = clamp01(p);
  return { stands: 1 - ramp(x * 1.5), floor: 1 - ramp((x - 1 / 3) * 1.5) };
}

/** The black veil over the room after See my room: 50%, easing to nothing over 1.5 s (t: seconds since the toggle). */
export const VEIL = 0.5;
export const VEIL_S = 1.5;
export function veil(t: number): number {
  return t < 0 ? 0 : VEIL * (1 - ramp(t / VEIL_S));
}

/** The edge fade (P35): the arena's opacity d metres from the bounds, 1 from fade[0] (0.6 m) to 0 at fade[1] (0.3 m). */
export function edgeLevel(d: number, fade: [number, number]): number {
  return Number.isFinite(d) ? smoothstep(fade[1], fade[0], d) : 1;
}

/** The rendered court outside the frame falls to dark over this many floor metres. */
export const REACH_FALLOFF_M = 3.5;

/**
 * The frame's four sides as planes through the camera's centre, for the rendered court's darkness falloff: each an
 * outward unit normal in court space and 1 / its horizontal length, so n . (p - centre) x that is floor metres
 * outside that side (exact where the plane meets the floor, for the low broadcast camera's grazing bottom edge too).
 */
export interface ReachPlanes {
  centre: Vec3;
  planes: [number, number, number, number][];
}

export function reachPlanes(cam: PinholeCamera): ReachPlanes {
  const tl = (cam.cx + 0.5) / cam.f;
  const tr = (cam.width - 0.5 - cam.cx) / cam.f;
  const tt = (cam.cy + 0.5) / cam.f;
  const tb = (cam.height - 0.5 - cam.cy) / cam.f;
  // camera axes: +x right, +y down, +z forward; a point is outside a side when n . c > 0
  const sides: Vec3[] = [[1, 0, -tr], [-1, 0, -tl], [0, 1, -tb], [0, -1, -tt]];
  const planes = sides.map((n) => {
    const l = Math.hypot(...n);
    const w = rotate(cam.q, [n[0] / l, n[1] / l, n[2] / l]);
    return [w[0], w[1], w[2], 1 / Math.max(0.02, Math.hypot(w[0], w[2]))] as [number, number, number, number];
  });
  return { centre: [...cam.centre], planes };
}

/** How lit the rendered court is at p by the frame's reach (1 inside the frame, 0 REACH_FALLOFF_M outside it). */
export function reachAt(r: ReachPlanes, p: Vec3): number {
  return reachAtXYZ(r, p[0], p[1], p[2]);
}

/** reachAt without an array (the per-frame paths). */
export function reachAtXYZ(r: ReachPlanes, x: number, y: number, z: number): number {
  let out = -Infinity;
  for (const pl of r.planes) out = Math.max(out, (pl[0] * (x - r.centre[0]) + pl[1] * (y - r.centre[1]) + pl[2] * (z - r.centre[2])) * pl[3]);
  return 1 - smoothstep(0, REACH_FALLOFF_M, out);
}

/** reachAt in GLSL: uniforms uReachCentre (vec3) and uReachPlanes (vec4[4]) from reachPlanes. */
export const REACH_GLSL = /* glsl */ `
uniform vec3 uReachCentre;
uniform vec4 uReachPlanes[4];
float lightReach(vec3 p) {
  float o = -1e9;
  for (int i = 0; i < 4; i++) o = max(o, dot(uReachPlanes[i].xyz, p - uReachCentre) * uReachPlanes[i].w);
  return 1.0 - smoothstep(0.0, ${REACH_FALLOFF_M.toFixed(2)}, o);
}
`;

/**
 * The players' white point, from their splat colours (sRGB 0-1): the mean of the brightest 3% of splats, taken as
 * white (court-spikes/ground/estimate_light.py's "white" estimator), as the illuminant's linear [r, g, b], g = 1.
 * The arena's own lights (glows) take this colour, so the court and pools match the players (P13).
 */
export function whitePoint(colors: ArrayLike<number>): [number, number, number] {
  const n = Math.floor(colors.length / 3);
  if (!n) return [1, 1, 1];
  const dec = srgbToLinear;
  const lum = new Float64Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.2126 * dec(colors[3 * i]) + 0.7152 * dec(colors[3 * i + 1]) + 0.0722 * dec(colors[3 * i + 2]);
  const cut = Float64Array.from(lum).sort()[Math.min(n - 1, Math.floor(n * 0.97))];
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < n; i++)
    if (lum[i] >= cut) {
      r += dec(colors[3 * i]);
      g += dec(colors[3 * i + 1]);
      b += dec(colors[3 * i + 2]);
    }
  return g > 0 ? [r / g, 1, b / g] : [1, 1, 1];
}
