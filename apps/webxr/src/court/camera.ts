// Pinhole maths for the bundle's cameras, DOM-free and three-free: a show frame's camera from frames.json, projecting
// court points into it, rays out of it, and scaling it to another image width. One home for the camera convention
// (format.ts: OpenCV axes, world-from-camera rotation, source pixels, pixel centres at whole numbers), used by the
// stand-in renderer, seat.ts's maths and proxies.ts alike. Built by the integrator at T0 (tested in camera.test.ts).
import type { Court, Quat, ShowFrame, Vec3 } from "./format";

/** One frame's camera: where it is, how it's turned, and its intrinsics for an image `width` x `height`. */
export interface PinholeCamera {
  /** Optical centre, court space. */
  centre: Vec3;
  /** World-from-camera rotation (camera +x right, +y down, +z forward). */
  q: Quat;
  /** Focal length, pixels of this image. */
  f: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/** The camera of one show frame, in source pixels. */
export function cameraOf(court: Court, frame: ShowFrame): PinholeCamera {
  const c = court.camera;
  return { centre: [...c.centre], q: [...frame.q], f: frame.f, cx: c.cx, cy: c.cy, width: c.width, height: c.height };
}

/** The same camera for an image of another width (same aspect): pixel centres stay on pixel centres. */
export function scaled(cam: PinholeCamera, width: number): PinholeCamera {
  const s = width / cam.width;
  return { ...cam, f: cam.f * s, cx: (cam.cx + 0.5) * s - 0.5, cy: (cam.cy + 0.5) * s - 0.5, width, height: Math.round(cam.height * s) };
}

/** v rotated by the unit quaternion q. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 (q.xyz x v); v' = v + w t + q.xyz x t
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** The inverse rotation of a unit quaternion. */
export function conjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** A court point in the camera's own axes (+x right, +y down, +z forward), metres. */
export function toCamera(cam: PinholeCamera, p: Vec3): Vec3 {
  return rotate(conjugate(cam.q), [p[0] - cam.centre[0], p[1] - cam.centre[1], p[2] - cam.centre[2]]);
}

/** Where a court point lands in the image, pixels [u, v]; null behind the camera. (It may land outside the image.) */
export function project(cam: PinholeCamera, p: Vec3): [number, number] | null {
  const c = toCamera(cam, p);
  if (c[2] <= 1e-9) return null;
  return [cam.cx + (cam.f * c[0]) / c[2], cam.cy + (cam.f * c[1]) / c[2]];
}

/** The unit ray through pixel (u, v), in court space, from the camera's centre. */
export function rayOf(cam: PinholeCamera, u: number, v: number): { origin: Vec3; dir: Vec3 } {
  const d = rotate(cam.q, [(u - cam.cx) / cam.f, (v - cam.cy) / cam.f, 1]);
  const n = Math.hypot(d[0], d[1], d[2]);
  return { origin: [...cam.centre], dir: [d[0] / n, d[1] / n, d[2] / n] };
}

/** The camera's optical axis (its +z) in court space, unit length. */
export function opticalAxis(cam: PinholeCamera): Vec3 {
  return rotate(cam.q, [0, 0, 1]);
}

/**
 * The world-from-camera rotation of a camera looking along `forward` with the world's +Y up in its image (no roll):
 * camera +x = forward x up (right), +y = forward x right (down), +z = forward.
 */
export function lookRotation(forward: Vec3): Quat {
  const fl = Math.hypot(...forward);
  const f: Vec3 = [forward[0] / fl, forward[1] / fl, forward[2] / fl];
  let r: Vec3 = [-f[2], 0, f[0]]; // f x (0, 1, 0)
  const rl = Math.hypot(...r);
  if (rl < 1e-9) throw new Error("lookRotation: forward is straight up or down");
  r = [r[0] / rl, r[1] / rl, r[2] / rl];
  const d: Vec3 = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]]; // f x r
  return fromBasis(r, d, f);
}

/** The quaternion of the rotation whose columns are the unit axes x, y, z. */
export function fromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = z;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Angle between two directions, degrees. */
export function angleDeg(a: Vec3, b: Vec3): number {
  const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
  return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}
