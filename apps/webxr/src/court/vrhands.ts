// The judge's hands in the arena: the session is drawn opaque, so the real hands don't show; each tracked hand is drawn
// softly (a ball per joint, a capsule per bone, one instanced draw each, shaded by a warm matcap) and lit by the arena
// (light(level): dark in the arrival's black hold, so nothing shows before the lights come up). In See my room they fade out as the real ones appear in passthrough, and depth-only
// occluders (xr/hands.ts handOccluder) keep the real hands in front of the players there (3.6). From
// court-spikes/s6-quest/spike6/vrhands.ts. Stream C (`core`).
import * as THREE from "three";
import { handOccluder, liveJoints } from "../xr/hands";

/** True once stream C has built this module. */
export const BUILT = true;

const FINGERS = ["index-finger", "middle-finger", "ring-finger", "pinky-finger"];
const CHAINS = [
  ["wrist", "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
  ...FINGERS.map((f) => ["wrist", `${f}-metacarpal`, `${f}-phalanx-proximal`, `${f}-phalanx-intermediate`, `${f}-phalanx-distal`, `${f}-tip`]),
];
const JOINTS = [...new Set(CHAINS.flat())];
const BONES = CHAINS.flatMap((c) => c.slice(1).map((name, k) => [c[k], name] as const));

/** A joint's radius as xr/hands.ts handOccluder sizes it. */
const radius = (j: THREE.Object3D) => Math.max(0.006, (j as unknown as { jointRadius?: number }).jointRadius ?? 0.008);
/** The drawn hands sit just outside the occluders' surface, so they stay visible over them while the room fades in. */
const OVER = 1.04;

/** A soft warm matcap: light from above left, darker toward the rim. */
function matcap(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(48, 40, 6, 64, 64, 64);
  grad.addColorStop(0, "#f1d6c2");
  grad.addColorStop(0.55, "#c99a7d");
  grad.addColorStop(0.9, "#6e4b3a");
  grad.addColorStop(1, "#3b2a22");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class VrHands {
  private readonly hands: THREE.Object3D[];
  private readonly scene: THREE.Scene;
  private readonly joints: THREE.InstancedMesh;
  private readonly bones: THREE.InstancedMesh;
  private readonly material: THREE.MeshMatcapMaterial;
  private readonly occluders: { update: () => void; group: THREE.Object3D | undefined }[];
  private room = 0;
  /** The arena's light on the hands, 0-1: 0 (the default, until court.ts says) draws nothing. */
  private level = 0;
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly d = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  /** `hands` are renderer.xr.getHand(0) and (1), already in the scene. */
  constructor(hands: THREE.Object3D[], scene: THREE.Scene) {
    this.hands = hands;
    this.scene = scene;
    this.material = new THREE.MeshMatcapMaterial({ matcap: matcap(), transparent: true, opacity: 0.92 });
    const count = hands.length;
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), this.material, count * JOINTS.length);
    this.bones = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true), this.material, count * BONES.length);
    for (const mesh of [this.joints, this.bones]) {
      mesh.name = "court-hands";
      mesh.frustumCulled = false;
      mesh.count = 0;
      scene.add(mesh);
    }
    // the occluders are on only in the room (in the arena they would fight the drawn hands for depth)
    this.occluders = hands.map((h) => {
      const before = new Set(scene.children);
      const update = handOccluder(h, scene);
      const group = scene.children.find((c) => !before.has(c));
      if (group) group.visible = false;
      return { update, group };
    });
  }

  /** Once a frame while presenting. */
  update(): void {
    const drawn = this.room < 1 && this.level > 0.01;
    let nj = 0;
    let nb = 0;
    if (drawn)
      for (const hand of this.hands) {
        const joints = liveJoints(hand);
        if (!joints.wrist?.visible) continue;
        for (const name of JOINTS) {
          const j = joints[name];
          if (!j?.visible) continue;
          j.getWorldPosition(this.a);
          this.m.compose(this.a, this.q.identity(), this.s.setScalar(radius(j) * OVER));
          this.joints.setMatrixAt(nj++, this.m);
        }
        for (const [from, to] of BONES) {
          const ja = joints[from];
          const jb = joints[to];
          if (!ja?.visible || !jb?.visible) continue;
          ja.getWorldPosition(this.a);
          jb.getWorldPosition(this.b);
          const len = this.a.distanceTo(this.b);
          const r = Math.min(radius(ja), radius(jb)) * OVER;
          this.q.setFromUnitVectors(this.up, this.d.subVectors(this.b, this.a).normalize());
          this.m.compose(this.a.add(this.b).multiplyScalar(0.5), this.q, this.s.set(r, len, r));
          this.bones.setMatrixAt(nb++, this.m);
        }
      }
    this.joints.count = nj;
    this.bones.count = nb;
    this.joints.instanceMatrix.needsUpdate = true;
    this.bones.instanceMatrix.needsUpdate = true;
    for (const o of this.occluders) {
      if (this.room > 0) o.update();
      else if (o.group) o.group.visible = false;
    }
  }

  /** 0 = drawn hands (the arena), 1 = faded out (the room: the real hands show, occluders on). */
  fade(p: number): void {
    this.room = Math.min(1, Math.max(0, p));
    this.material.opacity = 0.92 * (1 - this.room);
    this.joints.visible = this.bones.visible = this.room < 1 && this.level > 0.01;
  }

  /**
   * The arena's light where the judge is, 0-1 (court.ts: 0 in the arrival's dark hold, rising with the lights-up, then
   * the light field's level for a person at the head's floor point). The hands are shaded by it; 0 hides them.
   */
  light(level: number): void {
    this.level = Math.min(1, Math.max(0, level));
    this.material.color.setScalar(this.level);
    this.joints.visible = this.bones.visible = this.room < 1 && this.level > 0.01;
  }
}
