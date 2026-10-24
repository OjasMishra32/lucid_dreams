import * as THREE from "three";

// Named SMPL-X hand poses for the seated opponent, copied from avatars/hand_poses.json (written by
// avatars/lucid_avatars/hand_poses.py): absolute local rotations of one hand's 15 finger joints, in SMPL-X order
// (index1-3, middle1-3, pinky1-3, ring1-3, thumb1-3), right hand, [x, y, z, w]. The left hand is the right one
// mirrored: negate y and z. A pinch puts the thumb tip on the index tip with the other three fingers curled out of the
// way; a point keeps the index straight (it presses the clock) with the rest curled; a fist, partly, closes a hand
// round another.

export type FingerPose = readonly (readonly [number, number, number, number])[];

export const PINCH: FingerPose = [
  [0, 0, 0.4291, 0.90326], [0, 0, 0.49254, 0.87029], [0, 0, 0.24837, 0.96866],
  [0, 0, 0.47943, 0.87758], [0, 0, 0.5851, 0.81096], [0, 0, 0.36627, 0.93051],
  [0, 0, 0.54383, 0.83919], [0, 0, 0.6249, 0.78071], [0, 0, 0.38942, 0.92106],
  [0, 0, 0.52269, 0.85252], [0, 0, 0.60519, 0.79608], [0, 0, 0.38942, 0.92106],
  [0.20295, -0.2332, 0.20978, 0.92759], [0.04892, 0.02047, 0.08137, 0.99527], [0.006, 0.0025, 0.01, 0.99993],
];

export const POINT: FingerPose = [
  [0, 0, 0.02, 0.9998], [0, 0, 0.02, 0.9998], [0, 0, 0.01, 0.99995],
  [0, 0, 0.66314, 0.7485], [0, 0, 0.76754, 0.641], [0, 0, 0.52269, 0.85252],
  [0, 0, 0.64422, 0.76484], [0, 0, 0.76754, 0.641], [0, 0, 0.52269, 0.85252],
  [0, 0, 0.66314, 0.7485], [0, 0, 0.76754, 0.641], [0, 0, 0.52269, 0.85252],
  [0.14283, -0.45437, 0.06614, 0.8768], [0.03944, 0.0609, 0.06639, 0.99515], [0.0005, 0.0005, 0.0005, 1],
];

/** All four fingers curled into the palm, the thumb across them: partly, it's a hand closing round another (a handshake). */
export const FIST: FingerPose = [
  [0, 0, 0.64422, 0.76484], [0, 0, 0.75128, 0.65998], [0, 0, 0.52269, 0.85252],
  [0, 0, 0.66314, 0.7485], [0, 0, 0.76754, 0.641], [0, 0, 0.52269, 0.85252],
  [0, 0, 0.64422, 0.76484], [0, 0, 0.76754, 0.641], [0, 0, 0.52269, 0.85252],
  [0, 0, 0.66314, 0.7485], [0, 0, 0.76754, 0.641], [0, 0, 0.52269, 0.85252],
  [0.14283, -0.45437, 0.06614, 0.8768], [0.03944, 0.0609, 0.06639, 0.99515], [0.0005, 0.0005, 0.0005, 1],
];

/** Finger joint i (0..14) of a pose for one hand (0 = left, mirrored; 1 = right). */
export function fingerQuat(pose: FingerPose, side: 0 | 1, i: number, out = new THREE.Quaternion()) {
  const [x, y, z, w] = pose[i];
  return side === 1 ? out.set(x, y, z, w) : out.set(x, -y, -z, w);
}
