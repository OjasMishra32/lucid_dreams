// Court Side's opening title: in the arrival's lights-up, "COURT SIDE" and a small "LUCID DREAMS · GATOR HACK V" float
// where the cinema screen will be (screen.ts screenPose: on the eye's ray to it, floating TITLE_M out), out of focus
// and loosely tracked, drifting in from behind; they sharpen, the letters close up, and they fade away under the rising lights before the
// screen takes the place, so nothing of it is left by the watch (LIGHTS_UP_S, court.ts). Everything is drawn here:
// one canvas atlas per line in three bands (sharp, softly blurred, a wide glow) in the system font, one quad per
// letter, added onto the frame (the framebuffer's alpha, the passthrough's, is left alone). P44 sets the fades: each
// pixel's display value (written straight, no colour conversion) moves at most 0.97 grey levels a frame at 72 Hz on
// any texel (scripts/court/opening.test.ts sweeps every band's extremes). See my room fades it with the arena.
import * as THREE from "three";
import type { CourtBundle, Vec3 } from "./format";
import { ramp } from "./lightfield";
import { SCREEN_EYE_M, SCREEN_M, screenPose } from "./screen";

export const TITLE = "COURT SIDE";
export const SUBTITLE = "LUCID DREAMS · GATOR HACK V";
/**
 * Two clocks: `t`, seconds since the title began, and `up`, seconds into the lights-up (negative in the dark hold). With
 * ?solo ("early") the title is a stage of its own on the dark screen: it begins at Seat here, reveals, holds a beat and
 * fades on t, and the lights-up (and with it the broadcast) waits for EARLY_STAGE_S as well as the still head, so it
 * starts under the title's last light. After a hand-over ("late") the hold stays black (P27): the title begins with the
 * lights-up, over the rising picture, with shorter fades (so a lower peak). Either way nothing is left at the watch.
 */
export interface Timeline {
  /** The title's fade in on t, the subtitle's, and both lines' fade out (on t when outOnT, else on up). */
  titleIn: [number, number];
  subIn: [number, number];
  out: [number, number];
  outOnT: boolean;
  /** The sharp letter takes over from the soft one over sharpS from sharpStart (+ SHARP_STAGGER_S a letter off centre). */
  sharpStart: number;
  sharpS: number;
  subSharp: [number, number];
  /** The whole light's scale: the late fades are shorter, so its peak is lower (P44). */
  gain: number;
}
export const EARLY: Timeline = { titleIn: [0, 2.2], subIn: [0.6, 2.5], out: [2.9, 5.0], outOnT: true, sharpStart: 0.05, sharpS: 2.05, subSharp: [0.7, 2.45], gain: 1 };
export const LATE: Timeline = { titleIn: [0, 1.75], subIn: [0.5, 1.9], out: [1.95, 3.7], outOnT: false, sharpStart: 0.05, sharpS: 1.6, subSharp: [0.65, 1.95], gain: 0.78 };
/** EARLY: the lights-up may start this long after Seat here (the title 70% through its fade out, the screen still dark). */
export const EARLY_STAGE_S = 4.4;
export const SHARP_STAGGER_S = 0.05;
/** The letters close up from WIDE_EM to REST_EM of tracking over TRACK_S on t (an ease out). */
export const TRACK_S = 3.4;
export const WIDE_EM = 0.75;
export const REST_EM = 0.14;
/** The drift (as at 7 m): from DEPTH_M behind its rest to it over DEPTH_S on t (an ease out), then DRIFT_M toward the eye on the way out. */
export const DEPTH_M = 1.6;
export const DEPTH_S = 3.0;
export const DRIFT_M = 0.6;
/**
 * Peak display values (0-1, encoded) of the letter (soft or sharp), its bloom and the anamorphic streak through the
 * title; the subtitle is SUB_PEAK of the title. Their sum over EARLY's shortest fade keeps P44 (opening.test.ts).
 */
export const PEAK_TEXT = 0.38;
export const PEAK_GLOW = 0.08;
export const PEAK_STREAK = 0.05;
export const SUB_PEAK = 0.7;
/** The title floats this far from the eye, in front of the screen on the same ray (stereo sets it off the picture). */
export const TITLE_M = 3.4;
/** The title's em and the subtitle's, metres as if at the screen's 7 m (the group is scaled to TITLE_M); the streak's size. */
const TITLE_EM_M = 0.72;
const SUB_EM_M = 0.17;
const SUB_TRACK_EM = 0.38;
const STREAK_M: [number, number] = [8.4, 0.2];
const FONT = `-apple-system, "SF Pro Display", "Helvetica Neue", "Segoe UI", Roboto, system-ui, sans-serif`;
const TITLE_PX = 128;
const SUB_PX = 96;

type Line = "title" | "sub";
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOut = (u: number) => 1 - (1 - clamp01(u)) ** 3;
const span = (t: number, [a, b]: [number, number]) => (t - a) / (b - a);
const peakOf = (line: Line, tl: Timeline) => (line === "title" ? 1 : SUB_PEAK) * tl.gain;
/** How far through its fade out the title is (0 before it starts). */
const outOf = (t: number, up: number, tl: Timeline) => {
  const u = tl.outOnT ? t : up;
  return u < 0 ? 0 : ramp(span(u, tl.out));
};
const levelOf = (t: number, up: number, line: Line, tl: Timeline) =>
  t < 0 ? 0 : Math.min(ramp(span(t, line === "title" ? tl.titleIn : tl.subIn)), 1 - outOf(t, up, tl));

/** A line's light (0 dark, its peak at full). */
export function lineLevel(t: number, up: number, line: Line, tl: Timeline): number {
  return levelOf(t, up, line, tl) * peakOf(line, tl);
}
/**
 * How much of that light is the sharp letter (the rest is the soft one), a letter `step` letters off the centre: its own
 * ramp, never more than the line's level, so each band's weight only ever moves as fast as one ramp (P44).
 */
export function sharpAt(t: number, up: number, line: Line, tl: Timeline, step = 0): number {
  const s = line === "title" ? ramp((t - tl.sharpStart - step * SHARP_STAGGER_S) / tl.sharpS) : ramp(span(t, tl.subSharp));
  return Math.min(s, levelOf(t, up, line, tl)) * peakOf(line, tl);
}
/** Tracking (em) and the drift toward the eye (metres, negative is behind its rest). */
export function trackAt(t: number): number {
  return REST_EM + (WIDE_EM - REST_EM) * (1 - easeOut(t / TRACK_S));
}
export function depthAt(t: number, up: number, tl: Timeline): number {
  return -DEPTH_M * (1 - easeOut(t / DEPTH_S)) + DRIFT_M * outOf(t, up, tl);
}
/** A texel's display value (the shaders' own sums) from the line's level and sharp weight: sharp, soft, glow and streak coverage 0-1. */
export function texel(level: number, sharpW: number, sharp: number, soft: number, glow: number, streak = 0): number {
  return PEAK_TEXT * ((level - sharpW) * soft + sharpW * sharp) + PEAK_GLOW * level * glow + PEAK_STREAK * level * streak;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
// written as display values (no colour conversion: texel() above is the encoded value), added onto the frame
const FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform float uLevel;
uniform float uSharp;
uniform vec2 uPeak;
uniform vec3 uTint;
varying vec2 vUv;
void main() {
  float sharp = texture2D(uTex, vUv).a;
  float soft = texture2D(uTex, vUv - vec2(0.0, 1.0 / 3.0)).a;
  float glow = texture2D(uTex, vUv - vec2(0.0, 2.0 / 3.0)).a;
  float b = uPeak.x * ((uLevel - uSharp) * soft + uSharp * sharp) + uPeak.y * uLevel * glow;
  gl_FragColor = vec4(uTint * b, 0.0);
}`;
// the anamorphic streak: a thin horizontal light through the title, falling off to nothing at its ends and edges
const STREAK_FRAG = /* glsl */ `
uniform float uLevel;
uniform float uPeak;
uniform vec3 uTint;
varying vec2 vUv;
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float along = pow(max(0.0, 1.0 - q.x * q.x), 3.0);
  float across = exp(-9.0 * q.y * q.y) * (1.0 - q.y * q.y);
  gl_FragColor = vec4(uTint * (uPeak * uLevel * along * across), 0.0);
}`;


/** Added onto the frame, over everything (the screen it gives way to too), the framebuffer's alpha (the passthrough's) kept. */
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

interface Glyph {
  mesh: THREE.Mesh;
  uniforms: { uLevel: { value: number }; uSharp: { value: number } };
  /** Advance, em; steps off centre (the focus stagger). */
  advance: number;
  step: number;
}

/**
 * Draws `items` (each a letter, or a whole line) into one canvas in three bands, top to bottom: sharp, soft, glow. Each
 * cell is padded so the glow never reaches its neighbour. Returns the texture and each item's UV box and size in em.
 */
function atlas(items: string[], px: number, weight: number, trackEm = 0) {
  const pad = Math.ceil(px * 0.75);
  const probe = document.createElement("canvas").getContext("2d")!;
  const font = `${weight} ${px}px ${FONT}`;
  probe.font = font;
  const chars = items.map((s) => [...s]);
  const width = (cs: string[]) => cs.reduce((w, c) => w + probe.measureText(c).width, 0) + trackEm * px * Math.max(0, cs.length - 1);
  const ws = chars.map(width);
  const cellH = Math.ceil(px * 1.25) + 2 * pad;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(ws.reduce((a, w) => a + Math.ceil(w) + 2 * pad, 0));
  canvas.height = 3 * cellH;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  const blurs = ["none", `blur(${(px * 0.1).toFixed(1)}px)`, `blur(${(px * 0.2).toFixed(1)}px)`];
  const boxes: { u0: number; u1: number; v0: number; v1: number; w: number; h: number }[] = [];
  let x = 0;
  chars.forEach((cs, i) => {
    const cellW = Math.ceil(ws[i]) + 2 * pad;
    blurs.forEach((filter, band) => {
      ctx.filter = filter; // ignored where unsupported: the bands are then all sharp
      ctx.font = font;
      let cx = x + pad;
      for (const c of cs) {
        ctx.fillText(c, cx, band * cellH + cellH / 2);
        cx += probe.measureText(c).width + trackEm * px;
      }
    });
    // the sharp band's box (v up, flipY): the shader steps down a third for the soft band and two for the glow
    boxes.push({ u0: x / canvas.width, u1: (x + cellW) / canvas.width, v0: 1 - cellH / canvas.height, v1: 1, w: cellW / px, h: cellH / px });
    x += cellW;
  });
  ctx.filter = "none";
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  const advances = chars.map((cs, i) => (cs.length === 1 ? probe.measureText(cs[0]).width / px : ws[i] / px));
  return { texture, boxes, advances, pad: pad / px };
}

/** The opening title: one group in court space (add it to the court world group). */
export class Opening {
  readonly group = new THREE.Group();
  private readonly title: Glyph[] = [];
  private readonly sub: Glyph[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly lines = [new THREE.Group(), new THREE.Group()];
  private readonly streak: THREE.Mesh;
  private readonly streakLevel = { value: 0 };

  /** `seat`: the dolly seat's floor point and F's direction along the floor (seat.ts Seat.spot), as the screen's. */
  constructor(bundle: CourtBundle, seat: { floor: Vec3; forward: Vec3 }) {
    const [, , lw, lh] = bundle.court.video.regions.live;
    const pose = screenPose([seat.floor[0], SCREEN_EYE_M, seat.floor[2]], seat.forward, lh / lw);
    this.group.name = "court-opening";
    this.group.matrixAutoUpdate = false;
    const near = SCREEN_M - TITLE_M;
    const k = TITLE_M / SCREEN_M;
    this.group.matrix
      .makeBasis(new THREE.Vector3(...pose.right), new THREE.Vector3(...pose.up), new THREE.Vector3(...pose.normal))
      .scale(new THREE.Vector3(k, k, k))
      .setPosition(pose.centre[0] + near * pose.normal[0], pose.centre[1] + near * pose.normal[1], pose.centre[2] + near * pose.normal[2]);
    this.group.visible = false;
    const [titleLine, subLine] = this.lines;
    titleLine.position.y = 0.16;
    subLine.position.y = -0.62;
    this.group.add(titleLine, subLine);

    const letters = [...TITLE];
    const t = atlas(letters, TITLE_PX, 700);
    const centre = (letters.length - 1) / 2;
    letters.forEach((_, i) => this.title.push(this.glyph(t, i, TITLE_EM_M, [1, 0.985, 0.96], Math.round(Math.abs(i - centre)), titleLine)));
    const s = atlas([SUBTITLE], SUB_PX, 500, SUB_TRACK_EM);
    this.sub.push(this.glyph(s, 0, SUB_EM_M, [0.82, 0.86, 0.93], 0, subLine));
    this.textures.push(t.texture, s.texture);
    this.streak = new THREE.Mesh(
      new THREE.PlaneGeometry(...STREAK_M),
      new THREE.ShaderMaterial({
        uniforms: { uLevel: this.streakLevel, uPeak: { value: PEAK_STREAK }, uTint: { value: new THREE.Color(0.62, 0.78, 1) } },
        vertexShader: VERT,
        fragmentShader: STREAK_FRAG,
        ...ADDED,
      }),
    );
    this.streak.name = "court-opening-streak";
    this.streak.renderOrder = 1001;
    this.streak.frustumCulled = false;
    titleLine.add(this.streak);
  }

  private glyph(a: ReturnType<typeof atlas>, i: number, emM: number, tint: [number, number, number], step: number, line: THREE.Group): Glyph {
    const b = a.boxes[i];
    const geometry = new THREE.PlaneGeometry(b.w * emM, b.h * emM);
    const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) ? b.u1 : b.u0, uv.getY(k) ? b.v1 : b.v0);
    const uniforms = { uTex: { value: a.texture }, uLevel: { value: 0 }, uSharp: { value: 0 }, uPeak: { value: new THREE.Vector2(PEAK_TEXT, PEAK_GLOW) }, uTint: { value: new THREE.Color(...tint) } };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      ...ADDED,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `court-opening-${i}`;
    mesh.renderOrder = 1001; // over the screen it gives way to
    mesh.frustumCulled = false;
    line.add(mesh);
    return { mesh, uniforms, advance: a.advances[i], step };
  }

  /**
   * `t`: seconds since the title began (negative: not yet); `up`: seconds into the lights-up (negative: the dark hold);
   * `early`: it began in the dark hold (EARLY), else with the lights-up (LATE); `roomP`: See my room's fade.
   */
  update(t: number, up: number, early: boolean, roomP: number): void {
    const tl = early ? EARLY : LATE;
    const k = 1 - roomP;
    const title = lineLevel(t, up, "title", tl) * k;
    const sub = lineLevel(t, up, "sub", tl) * k;
    this.group.visible = title > 0 || sub > 0;
    if (!this.group.visible) return;
    // the letters close up about the line's centre
    const track = trackAt(t);
    const total = this.title.reduce((w, g) => w + g.advance, 0) + track * (this.title.length - 1);
    let x = -total / 2;
    for (const g of this.title) {
      g.mesh.position.x = (x + g.advance / 2) * TITLE_EM_M;
      x += g.advance + track;
      g.uniforms.uLevel.value = title;
      g.uniforms.uSharp.value = sharpAt(t, up, "title", tl, g.step) * k;
    }
    for (const g of this.sub) {
      g.uniforms.uLevel.value = sub;
      g.uniforms.uSharp.value = sharpAt(t, up, "sub", tl) * k;
    }
    this.streakLevel.value = title;
    const z = depthAt(t, up, tl);
    this.lines[0].position.z = z;
    this.lines[1].position.z = z;
  }

  /** Whether the lights-up may start, `t` seconds after the title began: EARLY waits for its stage. */
  ready(t: number, early: boolean): boolean {
    return !early || t >= EARLY_STAGE_S;
  }

  /** Nothing drawn (every phase but the arrival). */
  hide(): void {
    this.group.visible = false;
  }

  dispose(): void {
    for (const g of [...this.title, ...this.sub]) {
      g.mesh.geometry.dispose();
      (g.mesh.material as THREE.Material).dispose();
    }
    for (const t of this.textures) t.dispose();
    this.streak.geometry.dispose();
    (this.streak.material as THREE.Material).dispose();
  }
}
