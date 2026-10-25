// Court Side's warp into the court (demo mode; `?demo=0` keeps the plain dissolve): over the ease's last WARP_S the
// cinema screen stretches into a tunnel toward the seat and the viewer rushes into it. Four layers, all added onto the
// frame over the screen (the framebuffer's alpha, the passthrough's, left alone; under the Reset and fade-jump veils):
//   - the tunnel: the screen's own rounded rim extruded from the picture toward the eye, flaring as it passes, its
//     walls streaked with light lanes and crossed by rings that run at the viewer, faster and faster;
//   - the streaks: hyperspace light lines in a cone round the axis, born at the picture, rushing past the head, their
//     length growing with the speed (motion blur, so nothing strobes);
//   - the zoom ring: radial zoom lines round the axis just in front of the eye, a ring of them racing outward;
//   - the flash: a white-blue bloom round the head, brightest toward the screen, up and down on smoothsteps.
// Everything rides one function of tF (seconds to F, the ease's own real-time clock): warpBeats(tF) is 0 everywhere
// before -WARP_S and from tF = WARP_FLASH_END on, so the warp is fully gone the instant F lands and the hand-off (and
// the projected picture at F, pixel-exact, under it) is today's. The streaks and the tunnel have faded out under the
// flash before it peaks. Built in the screen's own frame (its centre, right, up and normal, from its world matrix), so
// the tunnel's far end is the screen's rim exactly.
import * as THREE from "three";
import type { CinemaScreen } from "./screen";

/** The warp runs over the ease's last this many seconds (the shortest ease's length, so it never starts mid-way). */
export const WARP_S = 0.8;
/** The flash: up over [FLASH_UP, FLASH_PEAK], down over [FLASH_PEAK, WARP_FLASH_END] (seconds to F). */
export const FLASH_UP = -0.34;
export const FLASH_PEAK = -0.14;
export const WARP_FLASH_END = 0;
/** The travel speed into the tunnel, metres per second: V0 + V1 u^3 over the warp's progress u (0-1). */
const V0 = 3;
const V1 = 80;
const STREAKS = 280;

/** Perlin's quintic on [0, 1], clamped. */
const smooth = (u: number): number => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (x * (6 * x - 15) + 10);
};

export interface WarpBeats {
  /** The tunnel and the streaks, 0-1. */
  level: number;
  /** How far the tunnel reaches from the picture toward the eye, 0-1. */
  extend: number;
  /** Metres travelled into the tunnel, and the speed now (m/s). */
  travel: number;
  speed: number;
  /** The zoom ring's level and its radius (0 the axis, 1 the edge of the view). */
  ring: number;
  ringR: number;
  /** The flash, 0-1. */
  flash: number;
}

const NONE: WarpBeats = { level: 0, extend: 0, travel: 0, speed: 0, ring: 0, ringR: 0, flash: 0 };

/** The warp at tF seconds to F (negative before F): all zero before -WARP_S and from WARP_FLASH_END on. */
export function warpBeats(tF: number): WarpBeats {
  if (!(tF > -WARP_S) || tF >= WARP_FLASH_END) return NONE;
  const u = 1 + tF / WARP_S;
  const under = 1 - smooth((tF - FLASH_UP - 0.04) / (FLASH_PEAK - FLASH_UP - 0.04)); // gone under the rising flash
  const flash = smooth((tF - FLASH_UP) / (FLASH_PEAK - FLASH_UP)) * (1 - smooth((tF - FLASH_PEAK) / (WARP_FLASH_END - FLASH_PEAK)));
  return {
    level: smooth(u / 0.45) * under,
    extend: smooth(u / 0.55),
    travel: WARP_S * (V0 * u + (V1 * u ** 4) / 4),
    speed: V0 + V1 * u ** 3,
    ring: smooth((u - 0.25) / 0.3) * under,
    ringR: 0.1 + 1.05 * smooth((u - 0.3) / 0.62),
    flash,
  };
}

const HASH = /* glsl */ `
  float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }`;

// The tunnel: position.xy the rim's point at the screen (its own frame), position.z the way to the eye (0 the picture, 1
// the eye); aU the way round the rim (0-1)
const TUBE_VERT = /* glsl */ `
  attribute float aU;
  uniform vec3 uO;
  varying float vV; varying float vU;
  void main() {
    float v = position.z;
    float s = 1.0 + 0.55 * v * v;
    vec3 p = vec3(position.xy * s, 0.0) + uO * v;
    vV = v; vU = aU;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;
const TUBE_FRAG = /* glsl */ `
  uniform float uLevel; uniform float uExtend; uniform float uTravel; uniform float uD;
  varying float vV; varying float vU;
  ${HASH}
  void main() {
    float lead = 1.0 - smoothstep(uExtend - 0.12, uExtend, vV); // the tunnel's soft front, reaching for the eye
    float near = 1.0 - smoothstep(0.72, 0.98, vV);        // and gone before it reaches it
    float k0 = lead * near * uLevel;
    if (k0 <= 0.002) discard;
    float lane = vU * 150.0;
    float id = floor(lane);
    float h = hash(id);
    float across = 1.0 - abs(fract(lane) - 0.5) * 2.0;
    float lanes = step(0.5, h) * across * across * across;
    float run = vV * uD / (2.2 + 3.0 * hash(id + 3.7)) - uTravel * (0.9 + 0.4 * h) / (2.2 + 3.0 * hash(id + 3.7)) + 7.0 * h;
    float dash = fract(run);
    float streak = lanes * smoothstep(0.0, 0.75, dash) * (1.0 - smoothstep(0.9, 1.0, dash));
    float rp = fract(vV * uD / 1.6 - uTravel / 1.6);
    float rings = 0.42 * exp(-pow((rp - 0.5) / 0.07, 2.0));
    float rim = 0.75 * exp(-vV * uD / 0.35);              // the screen's rim, carried out into the tunnel
    vec3 tint = mix(vec3(0.42, 0.66, 1.0), vec3(0.9, 0.96, 1.0), clamp(streak + rim, 0.0, 1.0));
    float k = (0.85 * streak + rings + rim + 0.05) * k0;
    gl_FragColor = vec4(tint * k, 0.0);
  }`;

// The streaks: corner.x 0 the tail, 1 the head; corner.y across. aSeed: the angle round the axis, the radius at the
// eye, the start along the way, and a random 0-1 (speed and hue)
const STREAK_VERT = /* glsl */ `
  attribute vec2 corner; attribute vec4 aSeed;
  uniform vec3 uO; uniform float uD; uniform float uTravel; uniform float uLen;
  varying float vT; varying float vS; varying float vA; varying float vHue;
  void main() {
    float span = 1.5;
    float k = 0.7 + 0.6 * aSeed.w;
    float head = -0.3 + fract(aSeed.z + uTravel * k / (span * uD)) * span; // 0 the picture, 1 the eye
    float a = head - (1.0 - corner.x) * uLen * k / uD;
    float r = aSeed.y * mix(0.28, 1.0, clamp(a, 0.0, 1.2));
    vec2 dir = vec2(cos(aSeed.x), sin(aSeed.x));
    vec3 p = uO * a + vec3(dir * r + vec2(-dir.y, dir.x) * corner.y * (0.02 + 0.008 * aSeed.y), 0.0);
    vT = corner.x; vS = corner.y; vHue = aSeed.w;
    vA = smoothstep(0.0, 0.22, a) * (1.0 - smoothstep(0.8, 1.02, head));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;
const STREAK_FRAG = /* glsl */ `
  uniform float uLevel;
  varying float vT; varying float vS; varying float vA; varying float vHue;
  void main() {
    float along = pow(vT, 1.6);
    float across = exp(-5.0 * vS * vS) * (1.0 - vS * vS);
    vec3 tint = mix(vec3(0.5, 0.72, 1.0), vec3(1.0, 0.98, 0.96), vHue * 0.8);
    float k = uLevel * 1.1 * along * across * vA;
    if (k <= 0.002) discard;
    gl_FragColor = vec4(tint * k, 0.0);
  }`;

// The zoom ring: a plane square to the axis at uDist in front of the eye; vP the point on it from the axis
const PLANE_VERT = /* glsl */ `
  uniform vec3 uCentre;
  varying vec2 vP;
  void main() {
    vP = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position + uCentre, 1.0);
  }`;
const RING_FRAG = /* glsl */ `
  uniform float uLevel; uniform float uRingR; uniform float uDist; uniform float uTravel;
  varying vec2 vP;
  ${HASH}
  float lines(float x, float n) {
    float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(hash(mod(i, n)), hash(mod(i + 1.0, n)), f);
  }
  void main() {
    float rr = atan(length(vP), uDist) / radians(78.0); // 0 the axis, 1 at 78 degrees off it
    float ang = atan(vP.y, vP.x) / 6.2831853 + 0.5;
    float z = pow(lines(ang * 140.0, 140.0), 6.0) + 0.7 * pow(lines(ang * 57.0 + 0.3, 57.0), 9.0);
    float ring = exp(-pow((rr - uRingR) / 0.2, 2.0));
    float wake = smoothstep(0.0, uRingR, rr) * step(rr, uRingR) * 0.35;
    float flow = 0.65 + 0.35 * sin(rr * 26.0 - uTravel * 1.4);
    float k = uLevel * (z * (1.25 * ring + wake) * flow + 0.12 * ring) * smoothstep(0.06, 0.2, rr);
    if (k <= 0.002) discard;
    vec3 tint = mix(vec3(0.45, 0.7, 1.0), vec3(1.0), clamp(z, 0.0, 1.0) * 0.6);
    gl_FragColor = vec4(tint * k, 0.0);
  }`;

// The flash: a sphere round the eye, brightest toward the screen
const FLASH_VERT = /* glsl */ `
  uniform vec3 uO;
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position + uO, 1.0);
  }`;
const FLASH_FRAG = /* glsl */ `
  uniform float uFlash; uniform vec3 uAxis;
  varying vec3 vDir;
  void main() {
    float toward = max(0.0, dot(normalize(vDir), uAxis));
    vec3 col = mix(vec3(0.42, 0.64, 1.0), vec3(1.0, 0.99, 0.97), toward * toward);
    gl_FragColor = vec4(col * uFlash * (0.5 + 0.5 * pow(toward, 1.5)), 0.0);
  }`;

/** Added onto the frame, over everything but the veils, the framebuffer's alpha (the passthrough's) kept. */
const ADDED = {
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.ZeroFactor,
  blendDstAlpha: THREE.OneFactor,
} as const;

/**
 * The screen's rounded rim (`n` segments a corner), counter-clockwise, resampled to `m` points evenly by length with
 * the way round it (0-1): every quad of the tunnel is narrow, so its lanes stay straight across the triangle split.
 */
function rim(hw: number, hh: number, r: number, n: number, m: number): { x: number; y: number; u: number }[] {
  const pts: { x: number; y: number }[] = [];
  const corners: [number, number, number][] = [[hw - r, hh - r, 0], [-hw + r, hh - r, 0.5], [-hw + r, -hh + r, 1], [hw - r, -hh + r, 1.5]];
  for (const [cx, cy, a0] of corners)
    for (let i = 0; i <= n; i++) {
      const a = (a0 + (0.5 * i) / n) * Math.PI;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  pts.push({ ...pts[0] });
  let total = 0;
  const lens = pts.map((p, i) => (i ? (total += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y)) : 0));
  const out: { x: number; y: number; u: number }[] = [];
  for (let i = 0, j = 1; i <= m; i++) {
    const at = (i / m) * total;
    while (j < pts.length - 1 && lens[j] < at) j++;
    const f = (at - lens[j - 1]) / Math.max(1e-9, lens[j] - lens[j - 1]);
    out.push({ x: pts[j - 1].x + f * (pts[j].x - pts[j - 1].x), y: pts[j - 1].y + f * (pts[j].y - pts[j - 1].y), u: i / m });
  }
  return out;
}

/** The warp: add `group` to the scene (room space; it follows the screen's world matrix itself). */
export class Warp {
  readonly group = new THREE.Group();
  private readonly screen: CinemaScreen;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly u = {
    uO: { value: new THREE.Vector3(0, 0, 7) },
    uD: { value: 7 },
    uAxis: { value: new THREE.Vector3(0, 0, -1) },
    uCentre: { value: new THREE.Vector3() },
    uDist: { value: 1.4 },
    uLevel: { value: 0 },
    uExtend: { value: 0 },
    uTravel: { value: 0 },
    uLen: { value: 0.3 },
    uRingLevel: { value: 0 },
    uRingR: { value: 0 },
    uFlash: { value: 0 },
  };
  private readonly tube: THREE.Mesh;
  private readonly streaks: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly flash: THREE.Mesh;
  private latched = false;
  private readonly inv = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();

  constructor(screen: CinemaScreen) {
    this.screen = screen;
    this.group.name = "court-warp";
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    const u = this.u;
    const mat = (vertexShader: string, fragmentShader: string, uniforms: Record<string, { value: unknown }>, side: THREE.Side = THREE.DoubleSide) => {
      const m = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, side, ...ADDED });
      this.materials.push(m);
      return m;
    };
    const mesh = (name: string, g: THREE.BufferGeometry, m: THREE.Material, order: number) => {
      this.geometries.push(g);
      const o = new THREE.Mesh(g, m);
      o.name = name;
      o.renderOrder = order; // over the screen (1000) and the opening title (1001), under the veils (1e6)
      o.frustumCulled = false;
      this.group.add(o);
      return o;
    };

    // the tunnel: the rim swept from the picture (v 0) to the eye (v 1)
    const { width, height } = screen.pose;
    const ring = rim(width / 2, height / 2, 0.22, 8, 320);
    const NV = 24;
    const pos: number[] = [];
    const au: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= NV; j++) {
      const v = (j / NV) ** 1.4; // finer near the picture, where the rim's glow is tight
      for (const p of ring) {
        pos.push(p.x, p.y, v);
        au.push(p.u);
      }
    }
    const n = ring.length;
    for (let j = 0; j < NV; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        idx.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
      }
    const tubeG = new THREE.BufferGeometry();
    tubeG.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    tubeG.setAttribute("aU", new THREE.Float32BufferAttribute(au, 1));
    tubeG.setIndex(idx);
    this.tube = mesh("court-warp-tunnel", tubeG, mat(TUBE_VERT, TUBE_FRAG, { uO: u.uO, uD: u.uD, uLevel: u.uLevel, uExtend: u.uExtend, uTravel: u.uTravel }), 1002);

    // the streaks: one quad each, instanced, seeded the same every run (the stills are repeatable)
    const streakG = new THREE.InstancedBufferGeometry();
    streakG.setAttribute("position", new THREE.Float32BufferAttribute(new Array(12).fill(0), 3));
    streakG.setAttribute("corner", new THREE.Float32BufferAttribute([0, -1, 0, 1, 1, -1, 1, 1], 2));
    streakG.setIndex([0, 2, 1, 2, 3, 1]);
    let s = 1;
    const rnd = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
    const seeds = new Float32Array(STREAKS * 4);
    for (let i = 0; i < STREAKS; i++) seeds.set([rnd() * 2 * Math.PI, 0.9 + 3.6 * Math.sqrt(rnd()), rnd(), rnd()], i * 4);
    streakG.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    streakG.instanceCount = STREAKS;
    this.streaks = mesh("court-warp-streaks", streakG, mat(STREAK_VERT, STREAK_FRAG, { uO: u.uO, uD: u.uD, uTravel: u.uTravel, uLen: u.uLen, uLevel: u.uLevel }), 1003);

    // the zoom ring: a plane square to the axis (the screen's own plane) wide enough to fill the view from 1.4 m
    const half = 1.4 * Math.tan((80 * Math.PI) / 180);
    this.ring = mesh("court-warp-ring", new THREE.PlaneGeometry(2 * half, 2 * half), mat(PLANE_VERT, RING_FRAG, { uCentre: u.uCentre, uDist: u.uDist, uLevel: u.uRingLevel, uRingR: u.uRingR, uTravel: u.uTravel }), 1004);

    // the flash round the eye
    this.flash = mesh("court-warp-flash", new THREE.SphereGeometry(1.5, 32, 16), mat(FLASH_VERT, FLASH_FRAG, { uO: u.uO, uFlash: u.uFlash, uAxis: u.uAxis }, THREE.BackSide), 1005);
  }

  /**
   * Once a frame: `tF` seconds to F while the ease runs into it (null otherwise: the warp off), `head` the eye in room
   * space. The eye is latched when the warp starts, so the tunnel holds still round it.
   */
  update(tF: number | null, head: readonly number[]): void {
    const b = tF === null ? null : warpBeats(tF);
    if (!b || (b.level <= 0 && b.flash <= 0 && b.ring <= 0 && b.extend <= 0)) {
      this.group.visible = false;
      if (tF === null || tF >= WARP_FLASH_END || tF <= -WARP_S) this.latched = false;
      return;
    }
    const m = this.screen.mesh;
    m.updateWorldMatrix(true, false);
    this.group.matrix.copy(m.matrixWorld);
    this.group.matrixWorldNeedsUpdate = true;
    const u = this.u;
    if (!this.latched) {
      this.latched = true;
      this.inv.copy(m.matrixWorld).invert();
      u.uO.value.set(head[0], head[1], head[2]).applyMatrix4(this.inv);
      u.uD.value = Math.max(1, u.uO.value.length());
      u.uAxis.value.copy(u.uO.value).negate().normalize();
      // the zoom ring 1.4 m in front of the eye, on its ray to the picture
      u.uDist.value = Math.min(1.4, 0.4 * u.uD.value);
      this.v.copy(u.uAxis.value).multiplyScalar(-u.uDist.value);
      u.uCentre.value.copy(u.uO.value).add(this.v);
    }
    u.uLevel.value = b.level;
    u.uExtend.value = b.extend;
    u.uTravel.value = b.travel;
    u.uLen.value = Math.min(4.5, 0.25 + 0.055 * b.speed);
    u.uRingLevel.value = b.ring;
    u.uRingR.value = b.ringR;
    u.uFlash.value = b.flash;
    this.tube.visible = this.streaks.visible = b.level > 0;
    this.ring.visible = b.ring > 0;
    this.flash.visible = b.flash > 0;
    this.group.visible = true;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
