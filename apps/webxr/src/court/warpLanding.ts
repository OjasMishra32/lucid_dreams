// The warp's landing on F (the Screen view's step into the court), one function of tF (seconds from F, negative
// before it) so a recording is deterministic:
// - the flash: a white-blue veil round the head that builds through the ease's last moments, peaks just before F and
//   clears smoothly by FLASH_CLEAR_S after F, so what's left on F is F's own picture (the veil is hidden from
//   then on and never touches F's pixels); nothing moves with the head, only the light. Under it the demo's arena goes
//   to its full, even light and the cinema mask starts to lift (court.ts), so neither change is seen happening.
// - the shockwave: a thin glowing ring on the floor, centred under the players, running out toward the seat over RING_S
//   from the moment the picture starts handing off (handoff.ts videoFades, F + 0.15 s), so F's own pixels are never
//   touched (additive, drawn before the splats so the players stand in front of it).
// One of warp.ts's parts: its `object` goes in the court world group (court space), so the ring sits on the court and
// the veil follows head.court. `flash: false` leaves the flash to another part.
import * as THREE from "three";
import type { FreezePlayer } from "./format";
import type { Head } from "./types";

/** The flash: from FLASH_FROM_S it builds to FLASH_PEAK at FLASH_PEAK_S, then clears by FLASH_CLEAR_S (seconds from F). */
export const FLASH_FROM_S = -0.42;
export const FLASH_PEAK_S = -0.12;
export const FLASH_CLEAR_S = 0.1;
export const FLASH_PEAK = 0.8;
/** The ring: out from RING_START_M to RING_END_M over RING_S from RING_FROM_S, at most RING_LEVEL bright. */
export const RING_FROM_S = 0.15;
export const RING_S = 1.1;
export const RING_START_M = 0.35;
export const RING_END_M = 5.5;
export const RING_LEVEL = 0.6;
/** A second, fainter ring follows this much later. */
const ECHO_S = 0.14;
const ECHO_LEVEL = 0.45;
const WHITE_BLUE = new THREE.Color(0.82, 0.9, 1);

/** 6u^5 - 15u^4 + 10u^3 on [0, 1], clamped (zero slope and curvature at both ends). */
const smooth = (u: number): number => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (x * (6 * x - 15) + 10);
};

/** The flash veil's opacity at tF: 0 before FLASH_FROM_S and from FLASH_CLEAR_S on. */
export function flashLevel(tF: number): number {
  if (tF <= FLASH_FROM_S || tF >= FLASH_CLEAR_S) return 0;
  if (tF < FLASH_PEAK_S) return FLASH_PEAK * smooth((tF - FLASH_FROM_S) / (FLASH_PEAK_S - FLASH_FROM_S)) ** 2;
  return FLASH_PEAK * (1 - smooth((tF - FLASH_PEAK_S) / (FLASH_CLEAR_S - FLASH_PEAK_S)));
}

/** The ring at tF: its radius and half-width (metres) and brightness (0 outside [RING_FROM_S, RING_FROM_S + RING_S]). */
export function ringAt(tF: number): { radius: number; width: number; level: number } {
  const u = (tF - RING_FROM_S) / RING_S;
  const c = Math.min(1, Math.max(0, u));
  const radius = RING_START_M + (RING_END_M - RING_START_M) * (1 - (1 - c) ** 2);
  const level = u <= 0 || u >= 1 ? 0 : RING_LEVEL * smooth(u / 0.2) * (1 - u) ** 1.4;
  return { radius, width: 0.06 + 0.2 * c, level };
}

const RING_VERT = /* glsl */ `
varying float vR;
void main() {
  vR = length(position.xz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uLevel;
uniform float uSoft;
varying float vR;
void main() {
  float d = (vR - 1.0) / uSoft;
  gl_FragColor = vec4(uColor, uLevel * exp(-d * d));
}`;

export class WarpLanding {
  /** The flash and the rings, in court space. */
  readonly object = new THREE.Group();
  private readonly flash: THREE.Mesh;
  private readonly flashMat: THREE.MeshBasicMaterial;
  private readonly rings: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; delay: number; level: number }[] = [];
  private readonly ringGeo: THREE.BufferGeometry;

  private readonly flashOn: boolean;

  /**
   * `players`: court.freeze.players (the ring's centre is the middle of their feet, as freeze.ts places them);
   * `flash: false` leaves the flash to another part.
   */
  constructor(players: readonly Pick<FreezePlayer, "bounds">[], opts: { flash?: boolean } = {}) {
    this.flashOn = opts.flash !== false;
    this.object.name = "court-warp";
    // as transitions.ts's ResetVeil: a sphere round the head over everything, under the black veils (1e6, 1e6 + 1)
    this.flashMat = new THREE.MeshBasicMaterial({ color: WHITE_BLUE, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    this.flash = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 8), this.flashMat);
    this.flash.name = "court-warp-flash";
    this.flash.renderOrder = 1e6 - 1;
    this.flash.frustumCulled = false;
    this.flash.visible = false;
    this.object.add(this.flash);
    const n = Math.max(1, players.length);
    const x = players.reduce((s, p) => s + (p.bounds.min[0] + p.bounds.max[0]) / 2, 0) / n;
    const z = players.reduce((s, p) => s + (p.bounds.min[2] + p.bounds.max[2]) / 2, 0) / n;
    this.ringGeo = new THREE.RingGeometry(0.5, 1.5, 128, 1).rotateX(-Math.PI / 2);
    for (const [delay, level] of [[0, 1], [ECHO_S, ECHO_LEVEL]] as const) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: { uColor: { value: WHITE_BLUE.clone() }, uLevel: { value: 0 }, uSoft: { value: 0.1 } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.name = delay === 0 ? "court-warp-ring" : "court-warp-echo";
      mesh.renderOrder = -4; // after the floor and the hoop (-5), before the splats (0) and the video layer (50)
      mesh.position.set(x, 0.015, z);
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.object.add(mesh);
      this.rings.push({ mesh, mat, delay, level });
    }
  }

  /** The landing at tF seconds from F, the veil round the head (court space). */
  update(tF: number, head: Pick<Head, "court">): void {
    const f = this.flashOn ? flashLevel(tF) : 0;
    this.flashMat.opacity = f;
    this.flash.visible = f > 0;
    this.flash.position.set(head.court[0], head.court[1], head.court[2]);
    for (const r of this.rings) {
      const { radius, width, level } = ringAt(tF - r.delay);
      const a = level * r.level;
      r.mesh.visible = a > 0;
      if (!r.mesh.visible) continue;
      r.mesh.scale.setScalar(radius);
      r.mat.uniforms.uLevel.value = a;
      r.mat.uniforms.uSoft.value = Math.min(0.2, width / radius);
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.flash.geometry.dispose();
    this.flashMat.dispose();
    this.ringGeo.dispose();
    for (const r of this.rings) r.mat.dispose();
  }
}
