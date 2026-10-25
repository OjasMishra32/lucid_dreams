// The demo's floor guide: once the 3D has the court (late in the hand-off, open, walking), glowing chevron trails on the
// floor lead the walker on a short path from the seat (the head where the 3D opened) round the frozen pair: a camera-side
// three-quarter of each player, then the gap between them. One trail and its ring are lit at a time, the rest of the path
// faint ahead; the lit ring sends up a soft column of light, seen from a level gaze at the seat; a ring the head reaches
// (0.4 m on the floor) flashes and fades and the next trail lights. The path stays within 1.4 m of the seat, keeps clear
// of every torso and head capsule, each body's bounds and the extras' feet, and is planned again (from the same seat)
// when Walk closer or Next view moves the court. Court space, in the world group, so the anchor's corrections carry it
// with the players. Additive; the floor marks draw before the splats (renderOrder under Spark's 0) so a body in front
// still covers them, the column after them (it stands on the seat's side of the pair). court.ts resets it whenever the
// phase leaves the 3D.
import * as THREE from "three";
import type { Court } from "./format";
import { toCourt, toRoom } from "./seatmath";
import type { Head, WorldPose } from "./types";

type XZ = [number, number];

/** The head reaches a waypoint this close on the floor, metres. */
export const REACH = 0.4;
/** Every waypoint within this of the seat (a 3 x 3 m square round it holds the whole path). */
export const RADIUS = 1.4;
/** Clear of a torso or head capsule's surface, of a body's bounds, and of an extra's feet, metres. */
const CAPSULE_CLEAR = 0.45;
const BOX_CLEAR = 0.15;
const EXTRA_CLEAR = 0.6;
/** The three-quarter stops: this far round from the seat's line to the player, at least VIEW_D from them. */
const THREE_QUARTER = (35 * Math.PI) / 180;
const VIEW_D = 1.6;
/** Consecutive points closer than this merge (no trail shorter than a stride). */
const MIN_LEG = 0.6;
/** Levels: the path ahead, faint; the reached ring's fade and the newly lit one's rise (per second). */
const AHEAD = 0.14;
const FADE_RATE = 4.5;
const RISE_RATE = 6;
/** The whole guide comes up over this long once planned, and goes with the arena in See my room. */
const APPEAR_S = 0.35;
/** Trail strip width; a ring's plane and its radius, metres. */
const TRAIL_W = 0.36;
const RING_PLANE = 1.1;
const RING_R = 0.24;
/** The lit stop's column of light (seen from a level gaze at the seat), metres. */
const BEAM_H = 0.75;
const BEAM_R = 0.2;
/** Draw order: the floor marks after the floor's shadows (-10, -11), before the hoop (-5) and Spark's splats (0); the
 * column after the splats, under the video layer (50) and the UI (100). */
const ORDER = -8;
const COLUMN_ORDER = 10;

/** One body to keep clear of, on the floor: torso and head capsules, the bounds' rectangle. */
interface Obstacle {
  caps: { a: XZ; b: XZ; r: number }[];
  box: [number, number, number, number] | null;
  centre: XZ;
}

const sub = (a: XZ, b: XZ): XZ => [a[0] - b[0], a[1] - b[1]];
const add = (a: XZ, b: XZ, k = 1): XZ => [a[0] + b[0] * k, a[1] + b[1] * k];
const len = (a: XZ): number => Math.hypot(a[0], a[1]);
const dot = (a: XZ, b: XZ): number => a[0] * b[0] + a[1] * b[1];
const unit = (a: XZ): XZ => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l] : [0, -1];
};

/** The nearest point of segment a-b to p. */
function nearestOnSegment(p: XZ, a: XZ, b: XZ): XZ {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0;
  return add(a, ab, t);
}

/** How far p is outside every keep-clear zone (negative: inside one), and the point it is nearest to. */
function clearance(p: XZ, bodies: readonly Obstacle[], extras: readonly XZ[]): { gap: number; from: XZ } {
  let gap = Infinity;
  let from: XZ = p;
  for (const b of bodies) {
    for (const c of b.caps) {
      const q = nearestOnSegment(p, c.a, c.b);
      const g = len(sub(p, q)) - c.r - CAPSULE_CLEAR;
      if (g < gap) [gap, from] = [g, q];
    }
    if (b.box) {
      const [x0, z0, x1, z1] = b.box;
      const q: XZ = [Math.min(x1, Math.max(x0, p[0])), Math.min(z1, Math.max(z0, p[1]))];
      // inside the box: measured to its centre so the push goes outward
      const inside = q[0] === p[0] && q[1] === p[1];
      const g = inside ? -BOX_CLEAR - Math.min(p[0] - x0, x1 - p[0], p[1] - z0, z1 - p[1]) : len(sub(p, q)) - BOX_CLEAR;
      if (g < gap) [gap, from] = [g, inside ? b.centre : q];
    }
  }
  for (const e of extras) {
    const g = len(sub(p, e)) - EXTRA_CLEAR;
    if (g < gap) [gap, from] = [g, e];
  }
  return { gap, from };
}

/** Into the seat's disc. */
function inDisc(p: XZ, seat: XZ): XZ {
  const d = sub(p, seat);
  const l = len(d);
  return l > RADIUS ? add(seat, d, RADIUS / l) : p;
}

/** Out of every keep-clear zone (a few steps straight away from the nearest), kept in the seat's disc. */
function pushClear(p: XZ, seat: XZ, bodies: readonly Obstacle[], extras: readonly XZ[]): XZ {
  let q = p;
  for (let i = 0; i < 8; i++) {
    const { gap, from } = clearance(q, bodies, extras);
    if (gap >= 0) break;
    const away = len(sub(q, from)) > 1e-6 ? unit(sub(q, from)) : unit(sub(q, seat));
    q = inDisc(add(q, away, -gap + 0.02), seat);
  }
  return q;
}

/** True when the straight walk a -> b keeps clear the whole way (every 5 cm). */
function legClear(a: XZ, b: XZ, bodies: readonly Obstacle[], extras: readonly XZ[]): boolean {
  const n = Math.max(1, Math.ceil(len(sub(b, a)) / 0.05));
  for (let i = 0; i <= n; i++) if (clearance(add(a, sub(b, a), i / n), bodies, extras).gap < 0) return false;
  return true;
}

/**
 * The waypoints (court x, z), in walking order, from the seat: the left player's three-quarter, the right player's, then
 * the gap between them, each pulled into the seat's disc and out of every body; a leg that would cut through a body gets a
 * detour; a stop that can't be made clear is dropped. `forward` is the way the seat faces (used only when the pair sits on
 * top of it). Pure: no three, no page.
 */
export function planPath(seat: XZ, forward: XZ, bodies: readonly Obstacle[], extras: readonly XZ[]): XZ[] {
  if (!bodies.length) return [];
  const pair: XZ = [bodies.reduce((s, b) => s + b.centre[0], 0) / bodies.length, bodies.reduce((s, b) => s + b.centre[1], 0) / bodies.length];
  const fwd = len(sub(pair, seat)) > 0.3 ? unit(sub(pair, seat)) : unit(forward);
  const right: XZ = [-fwd[1], fwd[0]];
  const byLateral = [...bodies].sort((a, b) => dot(sub(a.centre, seat), right) - dot(sub(b.centre, seat), right));
  const left = byLateral[0];
  const rightmost = byLateral[byLateral.length - 1];
  const threeQuarter = (b: Obstacle, side: number): XZ => {
    const v = unit(sub(seat, b.centre));
    const s: XZ = [right[0] * side, right[1] * side];
    const o = unit(sub(s, [v[0] * dot(s, v), v[1] * dot(s, v)]));
    const d = Math.max(VIEW_D, len(sub(seat, b.centre)) - 1.0);
    return add(b.centre, add([v[0] * Math.cos(THREE_QUARTER), v[1] * Math.cos(THREE_QUARTER)], o, Math.sin(THREE_QUARTER)), d);
  };
  const mid: XZ = [(left.centre[0] + rightmost.centre[0]) / 2, (left.centre[1] + rightmost.centre[1]) / 2];
  const between = add(mid, unit(sub(seat, mid)), Math.max(1.0, len(sub(seat, mid)) - 1.4));
  const stops: XZ[] = [];
  for (const raw of [threeQuarter(left, -1), threeQuarter(rightmost, 1), between]) {
    let p = pushClear(inDisc(raw, seat), seat, bodies, extras);
    // still inside something: draw it in toward the seat (always clear: the seat keeps 1 m from every body)
    for (let k = 0; k < 10 && clearance(p, bodies, extras).gap < 0; k++) p = add(seat, sub(p, seat), 0.85);
    if (clearance(p, bodies, extras).gap >= 0 && len(sub(p, seat)) >= MIN_LEG) stops.push(p);
  }
  // the legs: a detour round a body in the way, else the stop goes
  const path: XZ[] = [];
  let from = seat;
  for (const p of stops) {
    if (len(sub(p, from)) < MIN_LEG) continue;
    if (legClear(from, p, bodies, extras)) {
      path.push(p);
      from = p;
      continue;
    }
    const half = add(from, sub(p, from), 0.5);
    const side: XZ = [-(p[1] - from[1]), p[0] - from[0]];
    const detour = [pushClear(half, seat, bodies, extras), pushClear(add(half, unit(side), 0.4), seat, bodies, extras), pushClear(add(half, unit(side), -0.4), seat, bodies, extras)]
      .find((d) => clearance(d, bodies, extras).gap >= 0 && legClear(from, d, bodies, extras) && legClear(d, p, bodies, extras));
    if (!detour) continue;
    if (len(sub(detour, from)) >= MIN_LEG) path.push(detour);
    path.push(p);
    from = p;
  }
  return path;
}

/** The bundle's pair and extras as keep-clear zones on the court floor. */
function obstaclesOf(court: Court): { bodies: Obstacle[]; extras: XZ[] } {
  const bodies = court.freeze.players.map((p) => {
    const box: [number, number, number, number] = [p.bounds.min[0], p.bounds.min[2], p.bounds.max[0], p.bounds.max[2]];
    const torso = p.capsules[0];
    const centre: XZ = torso ? [(torso.a[0] + torso.b[0]) / 2, (torso.a[2] + torso.b[2]) / 2] : [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    return { caps: p.capsules.map((c) => ({ a: [c.a[0], c.a[2]] as XZ, b: [c.b[0], c.b[2]] as XZ, r: c.r })), box, centre };
  });
  return { bodies, extras: court.freeze.others.map((o) => [o.foot[0], o.foot[2]] as XZ) };
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** A trail: chevrons flowing toward the stop, a soft band of light under them, a brighter wave running along. */
const TRAIL_FRAG = /* glsl */ `
uniform float uTime;
uniform float uLen;
uniform float uLevel;
uniform float uActive;
uniform vec3 uCyan;
varying vec2 vUv;
void main() {
  float s = vUv.x * uLen;
  float v = abs(vUv.y * 2.0 - 1.0);
  float ends = smoothstep(0.0, 0.25, s) * smoothstep(uLen, uLen - 0.25, s);
  float cell = fract((s - uTime * (0.35 + 0.35 * uActive)) / 0.3);
  float d = abs(cell - 0.62 + 0.42 * v);
  float chev = smoothstep(0.085, 0.025, d) * smoothstep(1.0, 0.72, v);
  float wave = 0.5 + 0.5 * sin(uTime * 3.2 - s * 4.5);
  float band = exp(-v * v * 3.0) * (0.10 + 0.14 * uActive);
  float core = exp(-v * v * 14.0) * 0.10;
  float a = (chev * (0.55 + 0.45 * wave * wave) + band + core) * ends * uLevel;
  vec3 col = mix(uCyan, vec3(1.0), clamp(chev * (0.45 + 0.4 * uActive), 0.0, 1.0));
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}
`;

/** A stop: a crisp ring with a halo and a faint disc, a turning dashed outer ring and a ripple while lit, a flash on reach. */
const RING_FRAG = /* glsl */ `
uniform float uTime;
uniform float uLevel;
uniform float uActive;
uniform float uBurst;
uniform vec3 uCyan;
varying vec2 vUv;
const float R0 = ${RING_R.toFixed(3)};
float band(float r, float at, float w) { float x = (r - at) / w; return exp(-x * x); }
void main() {
  vec2 p = (vUv - 0.5) * ${RING_PLANE.toFixed(3)};
  float r = length(p);
  float ang = atan(p.y, p.x);
  float pulse = 0.8 + 0.2 * sin(uTime * 4.0);
  float ring = band(r, R0, 0.012) + 0.35 * band(r, R0, 0.07);
  float disc = (1.0 - smoothstep(0.0, R0, r)) * (0.06 + 0.08 * uActive);
  float dash = step(0.55, fract(ang / 6.2831853 * 28.0 + uTime * 0.2)) * band(r, R0 + 0.085, 0.007) * 0.6 * uActive;
  float rip = fract(uTime * 0.75);
  float ripple = (1.0 - rip) * band(r, R0 + rip * 0.26, 0.016) * 0.75 * uActive;
  float flash = uBurst * (band(r, R0 + (1.0 - uBurst) * 0.32, 0.025) + 0.25 * (1.0 - smoothstep(0.0, R0, r)));
  float a = (ring * pulse + disc + dash + ripple) * uLevel + flash;
  vec3 col = mix(uCyan, vec3(1.0), clamp(band(r, R0, 0.012) * 0.6 + flash, 0.0, 1.0));
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}
`;

/** The lit stop's column: soft light rising off the ring, densest at its foot and through its middle, a shimmer climbing it. */
const BEAM_VERT = /* glsl */ `
varying vec2 vUv;
varying float vFacing;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFacing = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}
`;
const BEAM_FRAG = /* glsl */ `
uniform float uTime;
uniform float uLevel;
uniform vec3 uCyan;
varying vec2 vUv;
varying float vFacing;
void main() {
  float h = vUv.y;
  float fall = pow(1.0 - h, 1.7) * smoothstep(0.0, 0.04, h);
  float rise = fract(h * 1.2 - uTime * 0.45);
  float shimmer = exp(-pow((rise - 0.5) / 0.09, 2.0));
  float a = fall * (0.20 + 0.22 * shimmer) * pow(vFacing, 1.4) * uLevel;
  gl_FragColor = vec4(mix(vec3(1.0), uCyan, smoothstep(0.0, 0.5, h)), clamp(a, 0.0, 1.0));
}
`;

/** Additive colour over the arena; the frame's alpha only ever kept (the room behind stays hidden, as world.ts's overRoom). */
function glowMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, vertexShader = VERT): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.SrcAlphaFactor;
  m.blendDst = THREE.OneFactor;
  m.blendEquationAlpha = THREE.MaxEquation;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneFactor;
  return m;
}

interface Stop {
  at: XZ;
  level: number;
  burst: number;
  /** The column's own level: up while this stop is lit, down once reached. */
  beam: number;
  ring: THREE.Mesh;
  trail: THREE.Mesh;
  column: THREE.Mesh;
  ringU: Record<string, THREE.IUniform>;
  trailU: Record<string, THREE.IUniform>;
  columnU: Record<string, THREE.IUniform>;
}

export class FloorArrows {
  /** Court space: court.ts adds it to the world group. */
  readonly group = new THREE.Group();
  private readonly bodies: Obstacle[];
  private readonly extras: XZ[];
  private readonly time = { value: 0 };
  private readonly cyan = { value: new THREE.Vector3(0.32, 0.86, 1.0) };
  private stops: Stop[] = [];
  /** The seat in room space (the head where the 3D opened), and the world pose the path was planned for. */
  private seatRoom: [number, number, number] | null = null;
  private plannedFor: WorldPose | null = null;
  private active = 0;
  private appear = 0;

  constructor(court: Court) {
    ({ bodies: this.bodies, extras: this.extras } = obstaclesOf(court));
    this.group.name = "court-arrows";
    this.group.visible = false;
    if (import.meta.env?.DEV && typeof window !== "undefined") (window as unknown as { __courtArrows?: FloorArrows }).__courtArrows = this;
  }

  /** Once a frame once the 3D has the court: plan from the seat on the first frame (again if the court moved), light, fade. */
  update(head: Head, dt: number, world: WorldPose, roomP: number): void {
    if (!this.seatRoom) this.seatRoom = [head.room[0], 0, head.room[2]];
    if (!this.plannedFor || moved(this.plannedFor, world)) this.plan(world, head);
    this.time.value += dt;
    this.appear = Math.min(1, this.appear + dt / APPEAR_S);
    const here: XZ = [head.court[0], head.court[2]];
    // reaching any stop ahead counts for every stop before it too
    for (let i = this.stops.length - 1; i >= this.active; i--) {
      if (len(sub(here, this.stops[i].at)) > REACH) continue;
      for (let k = this.active; k <= i; k++) this.stops[k].burst = 1;
      this.active = i + 1;
      break;
    }
    const master = this.appear * (1 - Math.min(1, Math.max(0, roomP)));
    for (const [i, s] of this.stops.entries()) {
      const target = i < this.active ? 0 : i === this.active ? 1 : AHEAD;
      s.level += (target - s.level) * Math.min(1, dt * (target > s.level ? RISE_RATE : FADE_RATE));
      s.burst = Math.max(0, s.burst - dt / 0.6);
      const on = i === this.active ? 1 : 0;
      s.beam += (on - s.beam) * Math.min(1, dt * (on > s.beam ? RISE_RATE * 0.5 : FADE_RATE));
      s.columnU.uLevel.value = s.beam * master;
      s.column.visible = s.beam * master > 0.003;
      s.ringU.uLevel.value = s.level * master;
      s.ringU.uActive.value = on;
      s.ringU.uBurst.value = s.burst * master;
      s.trailU.uLevel.value = s.level * master;
      s.trailU.uActive.value = on;
      s.ring.visible = s.level * master > 0.003 || s.burst > 0;
      s.trail.visible = s.level * master > 0.003;
    }
    this.group.visible = this.stops.length > 0 && master > 0;
  }

  /** Off and forgotten (court.ts: whenever the phase isn't open or walking): the next open plans from its own seat. */
  reset(): void {
    if (!this.seatRoom && !this.stops.length) return;
    this.clear();
    this.seatRoom = null;
    this.plannedFor = null;
    this.appear = 0;
    this.group.visible = false;
  }

  /** The e2e's read: the stops in room space through `world`, which one is lit, their levels. */
  state(world: WorldPose): { seat: number[] | null; stops: number[][]; active: number; levels: number[]; visible: boolean } {
    return {
      seat: this.seatRoom ? [...this.seatRoom] : null,
      stops: this.stops.map((s) => toRoom(world, [s.at[0], 0, s.at[1]])),
      active: this.active,
      levels: this.stops.map((s) => Number(s.level.toFixed(3))),
      visible: this.group.visible,
    };
  }

  private plan(world: WorldPose, head: Head): void {
    this.clear();
    this.plannedFor = { position: [...world.position], yaw: world.yaw };
    const seat = toCourt(world, this.seatRoom ?? head.room);
    const fwdRoom: [number, number, number] = [head.room[0] - Math.sin(head.yaw), 0, head.room[2] - Math.cos(head.yaw)];
    const fwdCourt = toCourt(world, fwdRoom);
    const headCourt = toCourt(world, [head.room[0], 0, head.room[2]]);
    const at = planPath([seat[0], seat[2]], [fwdCourt[0] - headCourt[0], fwdCourt[2] - headCourt[2]], this.bodies, this.extras);
    let from: XZ = [seat[0], seat[2]];
    for (const [i, p] of at.entries()) {
      const ringU = { uTime: this.time, uCyan: this.cyan, uLevel: { value: 0 }, uActive: { value: 0 }, uBurst: { value: 0 } };
      const ringGeo = new THREE.PlaneGeometry(RING_PLANE, RING_PLANE);
      ringGeo.rotateX(-Math.PI / 2);
      const ring = new THREE.Mesh(ringGeo, glowMaterial(RING_FRAG, ringU));
      ring.position.set(p[0], 0.008, p[1]);
      // the trail from the last stop (the seat first) to this one, stopping short of both rings
      const d = sub(p, from);
      const start = i === 0 ? 0.22 : RING_R + 0.06;
      const length = Math.max(0.3, len(d) - start - (RING_R + 0.05));
      const trailU = { uTime: this.time, uCyan: this.cyan, uLen: { value: length }, uLevel: { value: 0 }, uActive: { value: 0 } };
      const trailGeo = new THREE.PlaneGeometry(length, TRAIL_W);
      trailGeo.rotateX(-Math.PI / 2);
      const trail = new THREE.Mesh(trailGeo, glowMaterial(TRAIL_FRAG, trailU));
      const u = unit(d);
      const centre = add(from, u, start + length / 2);
      trail.position.set(centre[0], 0.006, centre[1]);
      trail.rotation.y = Math.atan2(-u[1], u[0]); // the plane's +x (uv.x) along the walk
      const columnU = { uTime: this.time, uCyan: this.cyan, uLevel: { value: 0 } };
      const columnGeo = new THREE.CylinderGeometry(BEAM_R, BEAM_R * 1.15, BEAM_H, 48, 1, true);
      columnGeo.translate(0, BEAM_H / 2, 0);
      const column = new THREE.Mesh(columnGeo, glowMaterial(BEAM_FRAG, columnU, BEAM_VERT));
      column.position.set(p[0], 0.01, p[1]);
      for (const m of [ring, trail, column]) {
        m.renderOrder = m === column ? COLUMN_ORDER : m === trail ? ORDER : ORDER + 1;
        m.frustumCulled = false;
        this.group.add(m);
      }
      this.stops.push({ at: p, level: i === 0 ? 0 : AHEAD, burst: 0, beam: 0, ring, trail, column, ringU, trailU, columnU });
      from = p;
    }
    this.active = 0;
  }

  private clear(): void {
    for (const s of this.stops) {
      for (const m of [s.ring, s.trail, s.column]) {
        this.group.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    }
    this.stops = [];
    this.active = 0;
  }
}

/** The court moved (Walk closer, Next view, a re-seat), not the anchor's centimetre corrections. */
function moved(a: WorldPose, b: WorldPose): boolean {
  const dyaw = Math.atan2(Math.sin(a.yaw - b.yaw), Math.cos(a.yaw - b.yaw));
  return Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]) > 0.25 || Math.abs(dyaw) > (5 * Math.PI) / 180;
}
