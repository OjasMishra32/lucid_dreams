// Court Side's warp, part 2: hyperspace light streaks pouring out of the cinema screen and rushing past the seat as the
// ease slows into F. World-locked: a cone round the eye -> screen axis, the eye latched when the warp starts (no head
// lock, nothing turns, the horizon stays level). Every streak's place is a pure function of tF (seconds from F), so
// nothing reseeds per frame; they speed up and stretch with their speed, with a subtle RGB split and glints along
// them. Additive, soft-ended, procedural. One instanced draw of STREAKS quads. Gone by F (visible false at tF >= 0),
// so F's own pixels are untouched.
import * as THREE from "three";

/** The streaks ramp in from here (seconds from F), are brightest at T_PEAK, and are gone at F. */
export const STREAKS_IN_S = -1.4;
export const STREAKS_PEAK_S = -0.3;
/** Streak count (4 vertices each). */
const STREAKS = 720;
/** Axial speed at the start and at F, metres per second, and how it grows (w^POW over the window). */
const V0 = 2.5;
const V1 = 34;
const POW = 2.5;
/** A streak is as long as its travel over this long (motion blur), within LEN_MIN..LEN_MAX metres. */
const SHUTTER_S = 0.075;
const LEN_MIN = 0.14;
const LEN_MAX = 3.0;
/** Radius off the axis where streaks leave the picture, and where they pass the eye's plane, metres. */
const R_SCREEN: [number, number] = [0.08, 1.7];
const R_EYE: [number, number] = [0.75, 2.8];
/** They run on this far behind the eye before wrapping back to the screen, metres. */
const BEHIND_M = 1.6;
/** Lines never get thinner than this angle (radians, ~2 Quest pixels): no shimmer from sub-pixel streaks. */
const MIN_ANGLE = 0.0022;
/** A warp that starts late in the window (a short ease) still fades in over this long, seconds: no pop. */
const GUARD_S = 0.25;

const smooth = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (x * (6 * x - 15) + 10);
};
const span = -STREAKS_IN_S;
const progress = (tF: number) => Math.min(1, Math.max(0, (tF - STREAKS_IN_S) / span));
/** Axial speed at tF, m/s. */
const speed = (tF: number) => V0 + (V1 - V0) * progress(tF) ** POW;
/** Axial distance travelled since the window opened, m (the integral of speed). */
const travel = (tF: number) => {
  const w = progress(tF);
  return span * (V0 * w + ((V1 - V0) * w ** (POW + 1)) / (POW + 1)) + Math.min(0, tF - STREAKS_IN_S) * V0;
};
/** 0 before the window and at F, 1 at the peak. */
const envelope = (tF: number) =>
  tF >= 0 ? 0 : smooth((tF - STREAKS_IN_S) / (STREAKS_PEAK_S - STREAKS_IN_S)) * (1 - smooth((tF - STREAKS_PEAK_S) / -STREAKS_PEAK_S));

/** Deterministic PRNG (mulberry32): the same field every time. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const VERT = /* glsl */ `
  attribute vec4 aPath;  // angle round the axis, radius at the screen, radius at the eye's plane, phase (0-1)
  attribute vec4 aLook;  // width (m), brightness, warmth, glint seed
  uniform vec3 uEye;
  uniform vec3 uFwd;
  uniform vec3 uRight;
  uniform vec3 uUp;
  uniform float uZfar;
  uniform float uLoop;
  uniform float uTravel;
  uniform float uLen;
  uniform float uSquash;
  uniform float uMinAngle;
  varying vec2 vUV;
  varying float vZ;
  varying float vThin;
  varying vec3 vLook;

  // the streak's straight path: distance z ahead of the eye along the axis, its radius growing from the screen to the eye
  vec3 at(float z) {
    float k = (uZfar - z) / uZfar;
    float r = mix(aPath.y, aPath.z, k);
    float s = sin(aPath.x);
    s *= s < 0.0 ? uSquash : 1.0; // flatter below: clear of the floor
    return uEye + uFwd * z + (uRight * cos(aPath.x) + uUp * s) * r;
  }

  void main() {
    float zHead = uZfar - mod(aPath.w * uLoop + uTravel, uLoop);
    float zTail = zHead + uLen;
    float v = position.y; // 0 the tail (toward the screen), 1 the head (toward the eye)
    float z = mix(zTail, zHead, v);
    vec4 p = modelViewMatrix * vec4(at(z), 1.0);
    vec3 d = (modelViewMatrix * vec4(at(zHead) - at(zTail), 0.0)).xyz;
    vec3 side = cross(d, p.xyz);
    side /= max(length(side), 1e-6);
    float w = max(aLook.x, uMinAngle * length(p.xyz));
    p.xyz += side * position.x * w;
    vThin = aLook.x / w; // widened to the pixel floor: dimmer by as much, so far streaks don't brighten
    vUV = vec2(position.x, v);
    vZ = z;
    vLook = aLook.yzw;
    gl_Position = projectionMatrix * p;
  }`;

const FRAG = /* glsl */ `
  uniform float uZfar;
  uniform float uFront;
  uniform float uOpacity;
  uniform float uSplit;
  uniform float uT;
  varying vec2 vUV;
  varying float vZ;
  varying float vThin;
  varying vec3 vLook;

  // along the streak: a long soft tail into a rounded bright head
  float along(float v) {
    return smoothstep(0.0, 0.8, v) * (1.0 - smoothstep(0.88, 1.0, v));
  }

  void main() {
    float u = vUV.x;
    float v = vUV.y;
    float seed = vLook.z;
    // glints: a bright bead slides along some streaks now and then, its colours split a little more
    float twinkle = pow(max(0.0, sin(seed * 57.0 + uT * 6.0)), 6.0);
    float b = (v - fract(seed * 3.7 + uT * 2.2)) * 9.0;
    float bead = exp(-b * b) * twinkle;
    float s = uSplit * (1.0 + 1.5 * twinkle);
    vec3 core = vec3(along(v - s), along(v), along(v + s)) * exp(-u * u * 4.0);
    vec3 fringe = vec3(exp(-u * u * 2.6), exp(-u * u * 4.0), exp(-u * u * 6.0)); // red a touch wider than blue
    vec3 tint = mix(vec3(0.70, 0.83, 1.0), vec3(1.0, 0.85, 0.64), vLook.y);
    vec3 col = core * fringe * tint + bead * along(v) * vec3(along(v - 2.0 * s), along(v), along(v + 2.0 * s)) * 0.9;
    // out of the picture softly, the stream's front pouring toward the seat, dimmer as they pass the eye, gone behind it
    float fromScreen = uZfar - vZ;
    float k = smoothstep(0.0, 0.9, fromScreen) * (1.0 - smoothstep(uFront - 1.4, uFront, fromScreen));
    k *= mix(0.35, 1.0, smoothstep(0.0, 3.0, vZ)) * smoothstep(-1.4, 0.0, vZ);
    gl_FragColor = vec4(col * (k * vLook.x * vThin * uOpacity), 1.0);
  }`;

/** The warp's light streaks: add `object` to the scene (world space); update once a frame through the ease. */
export class WarpStreaks {
  readonly object: THREE.Object3D;
  private readonly mesh: THREE.Mesh;
  private readonly screen: THREE.Vector3;
  private readonly floorY: number;
  private readonly u = {
    uEye: { value: new THREE.Vector3() },
    uFwd: { value: new THREE.Vector3(0, 0, -1) },
    uRight: { value: new THREE.Vector3(1, 0, 0) },
    uUp: { value: new THREE.Vector3(0, 1, 0) },
    uZfar: { value: 7 },
    uLoop: { value: 8.6 },
    uTravel: { value: 0 },
    uLen: { value: LEN_MIN },
    uSquash: { value: 1 },
    uMinAngle: { value: MIN_ANGLE },
    uFront: { value: 0 },
    uOpacity: { value: 0 },
    uSplit: { value: 0 },
    uT: { value: 0 },
  };
  /** tF the current warp started at (null between warps), and the last tF seen. */
  private start: number | null = null;
  private last = 0;

  /** `screenCentre`: the cinema screen's centre, world space; `floorY`: the floor's height, world space. */
  constructor(screenCentre: THREE.Vector3, floorY = 0) {
    this.screen = screenCentre.clone();
    this.floorY = floorY;
    const base = new THREE.InstancedBufferGeometry();
    // one quad: x across (-1..1), y along (0 tail .. 1 head)
    base.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
    base.setIndex([0, 1, 2, 2, 1, 3]);
    const rand = prng(0x5eed);
    const path = new Float32Array(STREAKS * 4);
    const look = new Float32Array(STREAKS * 4);
    for (let i = 0; i < STREAKS; i++) {
      const k = rand();
      path.set([rand() * Math.PI * 2, R_SCREEN[0] + (R_SCREEN[1] - R_SCREEN[0]) * k * (0.6 + 0.4 * rand()), R_EYE[0] + (R_EYE[1] - R_EYE[0]) * Math.sqrt(k), rand()], i * 4);
      look.set([0.008 + 0.014 * rand(), 0.25 + 0.75 * rand() ** 2, rand() < 0.22 ? 0.8 : 0, rand()], i * 4);
    }
    base.setAttribute("aPath", new THREE.InstancedBufferAttribute(path, 4));
    base.setAttribute("aLook", new THREE.InstancedBufferAttribute(look, 4));
    base.instanceCount = STREAKS;
    const material = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(base, material);
    this.mesh.name = "court-warp-streaks";
    this.mesh.frustumCulled = false; // placed in the shader
    this.mesh.renderOrder = 1001; // over the cinema screen (1000, no depth write): the streaks are in front of it
    this.mesh.visible = false;
    this.object = this.mesh;
  }

  /** Once a frame: `tF` seconds from F (negative before it), `head` the eye in world space (latched as the warp starts). */
  update(tF: number, head: { room: [number, number, number] } | THREE.Vector3): void {
    const env = envelope(tF);
    if (!(tF < 0) || tF <= STREAKS_IN_S) {
      this.hide();
      return;
    }
    // a new warp (or the show went back): the field is laid along this eye's axis to the screen, and stays put
    if (this.start === null || tF < this.last) {
      this.start = tF;
      this.latch(head instanceof THREE.Vector3 ? head : new THREE.Vector3(...head.room));
    }
    this.last = tF;
    const u = this.u;
    u.uTravel.value = travel(tF);
    u.uFront.value = travel(tF) - travel(this.start);
    u.uLen.value = Math.min(LEN_MAX, Math.max(LEN_MIN, speed(tF) * SHUTTER_S));
    u.uSplit.value = 0.015 + 0.05 * progress(tF) ** 2;
    u.uT.value = tF;
    u.uOpacity.value = env * smooth((tF - this.start) / GUARD_S);
    this.mesh.visible = u.uOpacity.value > 0;
  }

  private latch(eye: THREE.Vector3): void {
    const u = this.u;
    u.uEye.value.copy(eye);
    const fwd = u.uFwd.value.subVectors(this.screen, eye);
    const far = fwd.length();
    fwd.divideScalar(far || 1);
    u.uRight.value.crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize(); // level: the right is horizontal
    u.uUp.value.crossVectors(u.uRight.value, fwd);
    u.uZfar.value = Math.max(1, far - 0.1);
    u.uLoop.value = u.uZfar.value + BEHIND_M;
    // the lower half of the cone flattened so it never dips under the floor at the eye's plane
    u.uSquash.value = Math.min(1, Math.max(0.2, (eye.y - this.floorY - 0.2) / R_EYE[1]));
  }

  private hide(): void {
    this.mesh.visible = false;
    this.u.uOpacity.value = 0;
    this.start = null;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
