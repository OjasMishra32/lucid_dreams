// Court Side's warp, part 1: the screen stretches into a tunnel toward the seat, and its picture punches in.
//   - the tunnel: the screen's own rounded rim extruded from the picture toward the eye, flaring as it passes, its walls
//     streaked with light lanes and crossed by rings that run at the viewer, faster and faster (added onto the frame);
//   - the punch-in: the picture itself lifts off the screen and rushes at the eye, growing past the edges of the view
//     with two lagging echoes (the zoom, drawn on the world: the camera never moves) and a glowing rim, brightening as
//     it comes and gone well before F. It starts exactly over the screen's own pixels (the same texture, the same
//     rounded corners), so the lift-off never pops; behind it the screen is already dissolving into the court (court.ts
//     SCREEN_EASE_S), which is what it uncovers.
// World-locked in the screen's own frame (court space: add `object` to the court world group), the eye latched when
// the warp starts; nothing turns and the horizon stays level. Everything is a function of tF (seconds from F) with a
// guard fade from the first tF seen (a later, shorter ease never pops), and nothing is drawn from TUNNEL_OUT on.
import * as THREE from "three";
import type { Head } from "./types";
import type { CinemaScreen } from "./screen";

/** The tunnel reaches out from TUNNEL_IN and is gone by TUNNEL_OUT (seconds from F). */
export const TUNNEL_IN = -1.1;
export const TUNNEL_OUT = -0.08;
/** The punch-in flies from PUNCH_IN to PUNCH_END; each echo lags the one in front by ECHO_S. */
export const PUNCH_IN = -0.62;
export const PUNCH_END = -0.1;
const ECHO_S = 0.045;
const ECHOES = [1, 0.45, 0.22];
/** A warp first seen late in its window (a short ease) still fades in over this long, seconds. */
const GUARD_S = 0.25;
/** The travel speed into the tunnel, metres per second: V0 + V1 u^3 over the tunnel's progress u (0-1). */
const V0 = 2.5;
const V1 = 60;

const smooth = (u: number): number => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (x * (6 * x - 15) + 10);
};

export interface TunnelBeats {
  /** The tunnel's light, 0-1, how far it reaches from the picture toward the eye (0-1), and metres travelled. */
  level: number;
  extend: number;
  travel: number;
  /** Each punch-in layer's way to the eye (0 on the screen, 1 at the eye) and opacity, front layer first. */
  punch: { p: number; opacity: number }[];
}

/** The tunnel and the punch-in at tF seconds from F, before the guard fade: nothing outside [TUNNEL_IN, TUNNEL_OUT). */
export function tunnelBeats(tF: number): TunnelBeats {
  if (!(tF > TUNNEL_IN) || tF >= TUNNEL_OUT) return { level: 0, extend: 0, travel: 0, punch: ECHOES.map(() => ({ p: 0, opacity: 0 })) };
  const u = (tF - TUNNEL_IN) / -TUNNEL_IN;
  const out = 1 - smooth((tF + 0.36) / (TUNNEL_OUT + 0.36));
  const punch = ECHOES.map((w, i) => {
    const t = tF - i * ECHO_S;
    const x = Math.min(1, Math.max(0, (t - PUNCH_IN) / (PUNCH_END - PUNCH_IN)));
    const p = 0.85 * x * x;
    const gone = 1 - smooth((tF + 0.24) / 0.14); // every layer gone by PUNCH_END
    return { p, opacity: tF > PUNCH_IN ? w * (1 - smooth((p - 0.1) / 0.55)) * gone : 0 };
  });
  return { level: smooth(u / 0.4) * out, extend: smooth(u / 0.5), travel: -TUNNEL_IN * (V0 * u + (V1 * u ** 4) / 4), punch };
}

const HASH = /* glsl */ `
  float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }`;

// position.xy the rim's point at the screen (its own frame), position.z the way to the eye (0 the picture, 1 the eye);
// aU the way round the rim (0-1)
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
    float near = 1.0 - smoothstep(0.72, 0.98, vV);              // and gone before it reaches it
    float k0 = lead * near * uLevel;
    if (k0 <= 0.002) discard;
    float lane = vU * 150.0;
    float id = floor(lane);
    float h = hash(id);
    float across = 1.0 - abs(fract(lane) - 0.5) * 2.0;
    float lanes = step(0.5, h) * across * across * across;
    float period = 2.2 + 3.0 * hash(id + 3.7);
    float dash = fract((vV * uD - uTravel * (0.9 + 0.4 * h)) / period + 7.0 * h);
    float streak = lanes * smoothstep(0.0, 0.75, dash) * (1.0 - smoothstep(0.9, 1.0, dash));
    float rp = fract((vV * uD - uTravel) / 1.6);
    float rings = 0.42 * exp(-pow((rp - 0.5) / 0.07, 2.0));
    float rim = 0.75 * exp(-vV * uD / 0.35); // the screen's rim, carried out into the tunnel
    vec3 tint = mix(vec3(0.42, 0.66, 1.0), vec3(0.9, 0.96, 1.0), clamp(streak + rim, 0.0, 1.0));
    gl_FragColor = vec4(tint * (0.85 * streak + rings + rim + 0.05) * k0, 0.0);
  }`;

// The punch-in: the screen's picture (screen.ts's own sampling and rounded corners) on a quad MARGIN wider each side
// for its glowing rim, uP of the way to the eye. Premultiplied over the frame, the rim added
const MARGIN = 0.35;
const PUNCH_VERT = /* glsl */ `
  uniform vec3 uO; uniform float uP;
  varying vec2 vP;
  void main() {
    vP = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position + uO * uP, 1.0);
  }`;
const PUNCH_FRAG = /* glsl */ `
  uniform sampler2D uTex; uniform vec2 uHalf; uniform float uRadius; uniform float uOpacity; uniform float uP;
  varying vec2 vP;
  float rounded(vec2 p, vec2 h, float r) { vec2 q = abs(p) - h + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  void main() {
    float d = rounded(vP, uHalf, uRadius);
    float aa = max(fwidth(d), 1e-4);
    float a = (1.0 - smoothstep(-aa, aa, d)) * uOpacity;
    vec3 col = texture2D(uTex, clamp(vP / (2.0 * uHalf) + 0.5, 0.0, 1.0)).rgb * (1.0 + 0.7 * uP);
    float glow = uOpacity * smoothstep(0.0, 0.2, uP) * (0.9 * exp(-abs(d) / 0.05) + 0.35 * exp(-max(d, 0.0) / 0.22));
    vec3 rim = vec3(0.55, 0.78, 1.0) * glow;
    if (a + glow <= 0.002) discard;
    gl_FragColor = vec4(col * a + rim, a);
  }`;

/** Added onto the frame, the framebuffer's alpha (the passthrough's) kept. */
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
/** Premultiplied over the frame (screen.ts's blending). */
const OVER = {
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
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

/** The tunnel and the punch-in: add `object` to the court world group; update once a frame. */
export class WarpTunnel {
  readonly object = new THREE.Group();
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly u = {
    uO: { value: new THREE.Vector3(0, 0, 7) },
    uD: { value: 7 },
    uLevel: { value: 0 },
    uExtend: { value: 0 },
    uTravel: { value: 0 },
  };
  private readonly tube: THREE.Mesh;
  private readonly layers: { mesh: THREE.Mesh; uP: { value: number }; uOpacity: { value: number } }[] = [];
  private start: number | null = null; // the first tF of this warp; null between warps
  private last = 0;
  private readonly inv = new THREE.Matrix4();

  /** `live`: the screen's own texture (the stream's live region, as CinemaScreen draws it). */
  constructor(screen: CinemaScreen, live: THREE.Texture) {
    this.object.name = "court-warp-tunnel";
    this.object.matrixAutoUpdate = false;
    this.object.matrix.copy(screen.mesh.matrix); // the screen's own frame, court space
    this.inv.copy(screen.mesh.matrix).invert();
    this.object.visible = false;

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
    const u = this.u;
    this.tube = this.add("court-warp-tunnel-walls", tubeG, this.material(TUBE_VERT, TUBE_FRAG, { uO: u.uO, uD: u.uD, uLevel: u.uLevel, uExtend: u.uExtend, uTravel: u.uTravel }, ADDED), 1000.8);

    // the punch-in's layers, the lagging echoes drawn first (farther from the eye), the front layer last
    const punchG = new THREE.PlaneGeometry(width + 2 * MARGIN, height + 2 * MARGIN);
    this.geometries.push(punchG);
    ECHOES.forEach((_, i) => {
      const uP = { value: 0 };
      const uOpacity = { value: 0 };
      const m = this.material(PUNCH_VERT, PUNCH_FRAG, { uTex: { value: live }, uHalf: { value: new THREE.Vector2(width / 2, height / 2) }, uRadius: { value: 0.22 }, uO: u.uO, uP, uOpacity }, OVER);
      // after the screen (1000), before the walls' light and the streaks (1001): their light lands on the picture
      this.layers.push({ mesh: this.add(`court-warp-punch-${i}`, punchG, m, 1000.5 - 0.1 * i, false), uP, uOpacity });
    });
  }

  private material(vertexShader: string, fragmentShader: string, uniforms: Record<string, { value: unknown }>, blend: typeof ADDED | typeof OVER): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, side: THREE.DoubleSide, ...blend });
    this.materials.push(m);
    return m;
  }

  private add(name: string, g: THREE.BufferGeometry, m: THREE.Material, order: number, own = true): THREE.Mesh {
    if (own) this.geometries.push(g);
    const o = new THREE.Mesh(g, m);
    o.name = name;
    o.renderOrder = order;
    o.frustumCulled = false; // placed in the shader
    o.visible = false;
    this.object.add(o);
    return o;
  }

  /** Once a frame: `tF` seconds from F (anything outside the window: nothing drawn), `head` the eye. */
  update(tF: number, head: Head): void {
    const b = tunnelBeats(tF);
    if (!(tF > TUNNEL_IN) || tF >= TUNNEL_OUT) {
      this.object.visible = false;
      this.start = null;
      return;
    }
    if (this.start === null || tF < this.last) {
      this.start = tF;
      const o = this.u.uO.value.set(...head.court).applyMatrix4(this.inv); // the eye in the screen's frame
      this.u.uD.value = Math.max(1, o.length());
    }
    this.last = tF;
    const guard = smooth((tF - this.start) / GUARD_S);
    const u = this.u;
    u.uLevel.value = b.level * guard;
    u.uExtend.value = b.extend;
    u.uTravel.value = b.travel;
    this.tube.visible = u.uLevel.value > 0;
    b.punch.forEach((l, i) => {
      const layer = this.layers[i];
      layer.uP.value = l.p;
      layer.uOpacity.value = l.opacity * guard;
      layer.mesh.visible = layer.uOpacity.value > 0;
    });
    this.object.visible = true;
  }

  dispose(): void {
    this.object.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
