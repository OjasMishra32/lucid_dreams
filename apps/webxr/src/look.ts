import * as THREE from "three";
import type { Skeleton } from "./avatar";

// Eye contact: someone you're with (companion) or playing against turns their head toward you, the way a person in
// the room would. Layered on the motion: the head (SMPL-X joint 15) takes 70% of the turn and the neck (12) 30%,
// within ±35° yaw and ±20° pitch, eased so it settles in about 300 ms. More than 110° off their face (you walked
// behind them) they give up and look ahead again rather than twist round. The Quest's HeadLook.cs is the same maths.

const NECK = 12;
const HEAD = 15;
const DEG = Math.PI / 180;
const MAX_YAW = 35 * DEG;
const MAX_PITCH = 20 * DEG;
const GIVE_UP = 110 * DEG;
const NECK_SHARE = 0.3;
const EASE_S = 0.1; // time constant: 95% of the way in 300 ms

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(-1, 0, 0); // rest pose faces +Z with +Y up, so the person's right is -X
const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));

export class HeadLook {
  /** The turn applied now, in the head's own frame: yaw toward +X, pitch up. */
  yaw = 0;
  pitch = 0;

  /**
   * For SkinnedAvatar.pose's edit: turns the neck and head toward eye (the viewer's eyes in the bundle's space, or
   * null to look ahead again), easing by dt seconds.
   */
  apply(local: THREE.Quaternion[], rootT: THREE.Vector3, skeleton: Skeleton, eye: THREE.Vector3 | null, dt: number) {
    let yawT = 0;
    let pitchT = 0;
    if (eye) {
      const { rot, pos } = headPose(local, rootT, skeleton);
      const d = eye.clone().sub(pos).applyQuaternion(rot.invert()); // head frame: forward +Z, up +Y
      const yaw = Math.atan2(d.x, d.z);
      if (Math.abs(yaw) < GIVE_UP) {
        yawT = clamp(yaw, MAX_YAW);
        pitchT = clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), MAX_PITCH);
      }
    }
    const k = 1 - Math.exp(-Math.max(dt, 0) / EASE_S);
    this.yaw += (yawT - this.yaw) * k;
    this.pitch += (pitchT - this.pitch) * k;
    if (!eye && Math.abs(this.yaw) < 1e-4 && Math.abs(this.pitch) < 1e-4) this.yaw = this.pitch = 0;
    if (!this.yaw && !this.pitch) return;
    // The neck turns about the head's own axes (local'_12 = local_12 · local_15 · D · local_15⁻¹), then the head
    // takes the rest, so the head ends up turned by the whole yaw and pitch.
    const head = local[HEAD];
    local[NECK].multiply(head.clone().multiply(this.turn(NECK_SHARE)).multiply(head.clone().invert()));
    head.multiply(this.turn(1 - NECK_SHARE));
  }

  private turn(share: number) {
    return new THREE.Quaternion().setFromAxisAngle(UP, share * this.yaw).multiply(new THREE.Quaternion().setFromAxisAngle(RIGHT, share * this.pitch));
  }
}

/** The head's rotation and position in the bundle's space for these joint rotations (the chain pelvis to head). */
export function headPose(local: THREE.Quaternion[], rootT: THREE.Vector3, skeleton: Skeleton) {
  const chain: number[] = [];
  for (let j = HEAD; j >= 0; j = skeleton.parents[j]) chain.unshift(j);
  const rest = (j: number) => new THREE.Vector3(...(skeleton.rest[j] as [number, number, number]));
  const rot = new THREE.Quaternion();
  const pos = rest(chain[0]);
  chain.forEach((j, i) => {
    if (i > 0) pos.add(rest(j).sub(rest(chain[i - 1])).applyQuaternion(rot));
    rot.multiply(local[j]);
  });
  return { rot, pos: pos.add(rootT) };
}
