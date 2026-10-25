// Court Side's Screen view (the default; ?view=courtside is the projection into the arena): the watch plays the whole
// broadcast frame (the stream's live region, never cropped) on one big rounded cinema screen in front of the seat,
// world-locked in court space from the dolly seat along camera F's view toward the play, a little above eye level,
// the arena dimmed round it. Nothing of the footage is projected onto the 3D while it shows. As the ease slows into F,
// court.ts dissolves it into the same picture projected into the arena (proxies.ts, the Courtside path, pixel-exact
// from the seat), so the hand-off at F is today's; Back to my seat reverses it after the hand-back.
// Pure placement (screenPose) plus one mesh.
import * as THREE from "three";
import type { CourtBundle, Vec3 } from "./format";

/** The view setting: the screen (default) or the footage projected into the arena (V1.2). */
export type ViewMode = "screen" | "courtside";
export const viewMode = (query: string | null): ViewMode => (query === "courtside" ? "courtside" : "screen");

/** The screen's horizontal field from the seat, degrees, and its distance, metres. */
export const SCREEN_DEG = 64;
export const SCREEN_M = 7;
/** The seated eye's height above the court floor the screen is placed for, metres. */
export const SCREEN_EYE_M = 1.2;
/** Its lowest edge stays this high above the floor (the centre lifts above eye level to keep it there). */
export const SCREEN_FLOOR_M = 0.2;
/** The least lift of the centre above the horizon, degrees. */
export const SCREEN_LIFT_DEG = 4;
/** Corner radius, the shadow round it that dims the arena near the picture, and its thin light rim, metres. */
export const SCREEN_RADIUS_M = 0.22;
export const SCREEN_HALO_M = 2.4;
export const SCREEN_RIM_M = 0.015;
/** The screen dissolves into the projected picture over the ease's last this many show seconds (slowing into F). */
export const SCREEN_EASE_S = 0.6;
/** ...and back in over F's projected picture after the hand-back, seconds. */
export const SCREEN_FADE_S = 1.0;

export interface ScreenPose {
  /** Centre, court space. */
  centre: Vec3;
  /** Unit right and up along the screen, and its normal toward the eye. */
  right: Vec3;
  up: Vec3;
  normal: Vec3;
  /** Picture size, metres. */
  width: number;
  height: number;
}

/**
 * The screen from an eye (court space) looking along `axis` (camera F's, flattened to the horizon): SCREEN_DEG wide at
 * SCREEN_M, square to the eye's ray to its centre, the centre lifted (at least SCREEN_LIFT_DEG) until the bottom edge
 * clears the floor by SCREEN_FLOOR_M. aspect = height / width.
 */
export function screenPose(eye: Vec3, axis: Vec3, aspect: number): ScreenPose {
  const flat = Math.hypot(axis[0], axis[2]) || 1;
  const f: Vec3 = [axis[0] / flat, 0, axis[2] / flat];
  const right: Vec3 = [-f[2], 0, f[0]];
  const width = 2 * SCREEN_M * Math.tan(((SCREEN_DEG / 2) * Math.PI) / 180);
  const height = width * aspect;
  let lift = (SCREEN_LIFT_DEG * Math.PI) / 180;
  const bottom = (e: number) => eye[1] + SCREEN_M * Math.sin(e) - (height / 2) * Math.cos(e);
  while (bottom(lift) < SCREEN_FLOOR_M && lift < Math.PI / 4) lift += Math.PI / 720;
  const [c, s] = [Math.cos(lift), Math.sin(lift)];
  const dir: Vec3 = [f[0] * c, s, f[2] * c];
  const up: Vec3 = [-f[0] * s, c, -f[2] * s];
  return {
    centre: [eye[0] + SCREEN_M * dir[0], eye[1] + SCREEN_M * dir[1], eye[2] + SCREEN_M * dir[2]],
    right,
    up,
    normal: [-dir[0], -dir[1], -dir[2]],
    width,
    height,
  };
}

const VERT = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

// uPart 1, the picture: the live region's raw sRGB bytes straight through (as proxies.ts draws the picture at light 1),
// rounded corners with a pixel of antialiasing. uPart 0, round it: a thin light rim and a wide soft shadow that dims the
// arena near the picture (drawn under the hands and the caption). Premultiplied
const FRAG = /* glsl */ `
  uniform sampler2D uTex; uniform vec2 uHalf; uniform float uRadius; uniform float uHalo; uniform float uRim;
  uniform float uOpacity; uniform float uPart; uniform float uGlow;
  varying vec2 vP;
  float rounded(vec2 p, vec2 h, float r) { vec2 q = abs(p) - h + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  void main() {
    float d = rounded(vP, uHalf, uRadius);
    float aa = max(fwidth(d), 1e-4);
    float inside = 1.0 - smoothstep(-aa, aa, d);
    if (uPart > 0.5) {
      vec2 uv = clamp(vP / (2.0 * uHalf) + 0.5, 0.0, 1.0);
      vec3 col = texture2D(uTex, uv).rgb;
      float a = inside * uOpacity;
      if (a <= 0.002) discard;
      gl_FragColor = vec4(col * a, a);
      return;
    }
    float out_ = max(d, 0.0);
    float shade = 1.0 - smoothstep(0.0, uHalo, out_);
    float halo = 0.82 * shade * shade * (1.0 - inside);
    float w = max(uRim, 1.5 * aa);
    float rim = (0.32 + 0.5 * uGlow) * (1.0 - smoothstep(w, w + aa, out_)) * (1.0 - inside);
    // Step into the court's pulse (glow): the rim brightens and a soft light spreads just past it; 0 is the plain rim
    float lit = max(rim, uGlow * 0.4 * (1.0 - smoothstep(0.0, 0.3, out_)) * (1.0 - inside));
    float a = max(halo, lit) * uOpacity;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(vec3(0.86) * lit * uOpacity, a);
  }`;

/** The cinema screen: one mesh in court space (add it to the court world group). */
export class CinemaScreen {
  readonly mesh: THREE.Mesh;
  private readonly halo: THREE.Mesh;
  readonly pose: ScreenPose;
  private readonly uOpacity = { value: 1 };
  private readonly uGlow = { value: 0 };
  private level = 1;
  private roomP = 0;

  /** `seat`: the dolly seat's floor point and F's direction along the floor (seat.ts Seat.spot), court space. */
  constructor(bundle: CourtBundle, live: THREE.Texture, seat: { floor: Vec3; forward: Vec3 }) {
    const [, , lw, lh] = bundle.court.video.regions.live;
    this.pose = screenPose([seat.floor[0], SCREEN_EYE_M, seat.floor[2]], seat.forward, lh / lw);
    const { width: w, height: h } = this.pose;
    const m = SCREEN_HALO_M;
    const material = (part: number) =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTex: { value: live },
          uHalf: { value: new THREE.Vector2(w / 2, h / 2) },
          uRadius: { value: SCREEN_RADIUS_M },
          uHalo: { value: SCREEN_HALO_M },
          uRim: { value: SCREEN_RIM_M },
          uOpacity: this.uOpacity,
          uPart: { value: part },
          uGlow: this.uGlow,
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material(1));
    this.mesh.name = "court-screen";
    this.mesh.renderOrder = 1000; // over the arena, the plates and the 3D
    this.mesh.frustumCulled = false;
    // the rim and shadow: a child (goes with the screen), drawn before the hands and the caption card (renderOrder 100)
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(w + 2 * m, h + 2 * m), material(0));
    this.halo.name = "court-screen-halo";
    this.halo.renderOrder = 95;
    this.halo.frustumCulled = false;
    this.mesh.add(this.halo);
    const { centre, right, up, normal } = this.pose;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrix.makeBasis(new THREE.Vector3(...right), new THREE.Vector3(...up), new THREE.Vector3(...normal)).setPosition(...centre);
    this.apply();
  }

  /** 0 hidden, 1 the screen whole. */
  get opacity(): number {
    return this.level;
  }

  set opacity(k: number) {
    this.level = Math.min(1, Math.max(0, k));
    this.apply();
  }

  /** Step into the court's pulse on the rim round the picture (0 the plain rim, 1 the peak); the picture never changes. */
  glow(k: number): void {
    this.uGlow.value = Math.min(1, Math.max(0, k));
  }

  /** See my room's fade (0 the arena, 1 the room): the screen goes with the arena. */
  room(p: number): void {
    this.roomP = p;
    this.apply();
  }

  private apply(): void {
    const k = this.level * (1 - this.roomP);
    this.uOpacity.value = k;
    this.mesh.visible = k > 0;
  }

  dispose(): void {
    for (const o of [this.mesh, this.halo]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
}
