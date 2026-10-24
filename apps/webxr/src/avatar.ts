import * as THREE from "three";
import { SplatMesh, SplatSkinning, SplatSkinningMode } from "@sparkjsdev/spark";
import { type Dream, dreamUrl } from "./dream";

// An avatar bundle played live: Gaussians in the SMPL-X rest pose, skinned on the GPU from avatar/skin.bin and
// avatar/skeleton.json, posed every display frame from avatar/motion.json. The maths is avatars/README.md's
// ("Posing one frame"), so this matches lucid_avatars/skinning.py, the reference.

export interface MotionFrame {
  root_t: number[];
  root_q: number[]; // x, y, z, w
  pose: number[][]; // 55 x axis-angle
}
export interface Motion {
  fps: number;
  frames: MotionFrame[];
}
export interface Skeleton {
  joints: string[];
  parents: number[];
  rest: number[][];
}

const axisAngle = (v: number[], out = new THREE.Quaternion()) => {
  const a = Math.hypot(v[0], v[1], v[2]);
  if (a < 1e-12) return out.identity();
  return out.setFromAxisAngle(new THREE.Vector3(v[0] / a, v[1] / a, v[2] / a), a);
};

/** Per motion frame: each joint's local rotation, the root's global_orient folded into joint 0. */
export function localRotations(motion: Motion): THREE.Quaternion[][] {
  return motion.frames.map((f) => {
    const q = f.pose.map((v) => axisAngle(v));
    q[0] = new THREE.Quaternion(f.root_q[0], f.root_q[1], f.root_q[2], f.root_q[3]).normalize().multiply(q[0]);
    return q;
  });
}

/**
 * Skinning transforms for one pose: rotation R_j and translation t_j such that a rest-pose point x moves to
 * R_j x + t_j. G_0 = [R(root) | rest_0], G_j = G_parent [R(pose_j) | rest_j - rest_parent], M_j = G_j [I | -rest_j] + root_t.
 */
export function skinTransforms(skeleton: Skeleton, local: THREE.Quaternion[], rootT: THREE.Vector3) {
  const n = skeleton.parents.length;
  const rot: THREE.Quaternion[] = new Array(n);
  const pos: THREE.Vector3[] = new Array(n);
  const out: { q: THREE.Quaternion; t: THREE.Vector3 }[] = new Array(n);
  const rest = skeleton.rest.map((r) => new THREE.Vector3(r[0], r[1], r[2]));
  for (let j = 0; j < n; j++) {
    const p = skeleton.parents[j];
    if (p < 0) {
      rot[j] = local[j].clone();
      pos[j] = rest[j].clone();
    } else {
      rot[j] = rot[p].clone().multiply(local[j]);
      pos[j] = rest[j].clone().sub(rest[p]).applyQuaternion(rot[p]).add(pos[p]);
    }
    out[j] = { q: rot[j], t: pos[j].clone().sub(rest[j].clone().applyQuaternion(rot[j])).add(rootT) };
  }
  return out;
}

export class SkinnedAvatar {
  readonly duration: number;
  private local: THREE.Quaternion[][];
  private rootT: THREE.Vector3[];
  private q = new THREE.Quaternion();
  private t = new THREE.Vector3();

  private constructor(
    readonly mesh: SplatMesh,
    private skinning: SplatSkinning,
    private skeleton: Skeleton,
    readonly motion: Motion,
  ) {
    this.local = localRotations(motion);
    this.rootT = motion.frames.map((f) => new THREE.Vector3(f.root_t[0], f.root_t[1], f.root_t[2]));
    this.duration = motion.frames.length / motion.fps;
  }

  /** True when the bundle carries everything live skinning needs (older avatar bundles only have the rest pose). */
  static canSkin(dream: Dream): boolean {
    return dream.kind === "avatar" && !!dream.avatar?.skin && !!dream.avatar?.skeleton && !!dream.avatar?.motion;
  }

  /** file: another Gaussian file in the same order as avatar.file (e.g. avatar.reality), skinned the same way. */
  static async load(dream: Dream, motionOverride?: Motion, file?: string): Promise<SkinnedAvatar> {
    const a = dream.avatar!;
    // revalidate: a bundle fetched again under the same id must never play a stale rig
    const get = (f: string) => fetch(dreamUrl(dream.id, f), { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`${f}: ${r.status}`);
      return r;
    });
    const [mesh, skin, skeleton, motion] = await Promise.all([
      (async () => {
        const m = new SplatMesh({ url: dreamUrl(dream.id, file ?? a.file) });
        await m.initialized;
        return m;
      })(),
      get(a.skin!).then((r) => r.arrayBuffer()),
      get(a.skeleton!).then((r) => r.json() as Promise<Skeleton>),
      motionOverride ? Promise.resolve(motionOverride) : get(a.motion).then((r) => r.json() as Promise<Motion>),
    ]);
    const bytes = new Uint8Array(skin);
    const n = bytes.length / 8;
    const splats = mesh.packedSplats?.numSplats ?? n;
    if (n !== splats) throw new Error(`skin.bin has ${n} records for ${splats} Gaussians`);

    // Dual-quaternion skinning (no covariance splats needed, and no candy-wrapper twist at the wrists). Every bone's
    // rest is the identity, so the transform handed to a bone each frame is the whole skinning transform M_j.
    const skinning = new SplatSkinning({ mesh, numSplats: n, numBones: skeleton.parents.length, mode: SplatSkinningMode.DUAL_QUATERNION });
    for (let i = 0; i < n; i++)
      for (let k = 0; k < 4; k++) skinning.skinData[i * 4 + k] = bytes[i * 8 + 4 + k] | (bytes[i * 8 + k] << 8);
    skinning.skinTexture.needsUpdate = true;
    const zero = new THREE.Vector3();
    const id = new THREE.Quaternion();
    for (let j = 0; j < skeleton.parents.length; j++) skinning.setRestQuatPos(j, id, zero);
    mesh.skinning = skinning;
    mesh.updateGenerator();
    const avatar = new SkinnedAvatar(mesh, skinning, skeleton, motion);
    avatar.pose(0);
    return avatar;
  }

  /** Pose at time t seconds (looping), blending between the motion's frames so it's smooth at any display rate. */
  pose(t: number) {
    const n = this.local.length;
    const f = (((t * this.motion.fps) % n) + n) % n;
    const i0 = Math.floor(f);
    const i1 = (i0 + 1) % n;
    const a = f - i0;
    const local = this.local[i0].map((q, j) => q.clone().slerp(this.local[i1][j], a));
    const rootT = this.rootT[i0].clone().lerp(this.rootT[i1], a);
    skinTransforms(this.skeleton, local, rootT).forEach(({ q, t }, j) => this.skinning.setBoneQuatPos(j, this.q.copy(q), this.t.copy(t)));
    this.skinning.updateBones();
  }
}
