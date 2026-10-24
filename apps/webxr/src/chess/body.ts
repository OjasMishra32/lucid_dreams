import * as THREE from "three";
import type { SplatMesh } from "@sparkjsdev/spark";

// The opponent's real bulk, measured from the avatar's own Gaussians in its rest pose: a rounded block around each torso
// and head bone (a boxy jacket, a full head of hair and all), and how thick the forearms and hands are. The seated poses
// keep hands and forearms out of these boxes (seated.ts), so no pose sinks into the body, whatever body the photos
// made. Boxes live in their joint's rest frame (x = the person's left, y up, z forward), so they follow the pose:
// a rest point x lands at G_j (x - rest_j) + P_j.

const TORSO = [0, 3, 6, 9, 13, 14]; // pelvis, spine1-3, collars (the upper chest)
const NECK = 12;
const HEAD = 15;
const FACE = [22, 23, 24]; // jaw, eyes: counted with the head
const L_ELBOW = 18, R_ELBOW = 19, L_WRIST = 20, R_WRIST = 21;
const FINGERS = [Array.from({ length: 15 }, (_, i) => 25 + i), Array.from({ length: 15 }, (_, i) => 40 + i)];
const SPLAT = 0.012; // a Gaussian reaches about this far past its centre
const ROUND = 2.5; // the blocks' roundness: 2 an ellipsoid, higher boxier (a jacket's front is rounded, about this)

export interface Box {
  j: number; // the joint it rides on
  c: THREE.Vector3; // centre, rest frame, relative to the joint
  r: THREE.Vector3; // half extents
  head: boolean;
}

const _l = new THREE.Vector3();
const _q = new THREE.Quaternion();

function pct(a: number[], q: number) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}

export class BodyShape {
  boxes: Box[] = [];
  arm: [number, number] = [0.045, 0.045]; // forearm radius, sleeve included
  hand: [number, number] = [0.03, 0.03]; // half the hand's thickness and width, about its axis
  handLen: [number, number] = [0.18, 0.18]; // wrist to fingertips
  front = 0.167; // how far the belly (jacket and all) reaches in front of the lower spine joints, rest frame

  /** Measured from a skinned avatar mesh (rest-pose centres, the skin's strongest bone per Gaussian). */
  static measure(mesh: SplatMesh, rest: THREE.Vector3[]): BodyShape {
    const body = new BodyShape();
    const skin = mesh.skinning?.skinData;
    if (!skin) return body;
    const byBone = new Map<number, THREE.Vector3[]>();
    mesh.forEachSplat((i, center, _s, _q, opacity) => {
      if (opacity < 0.25 || i * 4 + 3 >= skin.length) return;
      let bone = 0;
      let w = -1;
      for (let k = 0; k < 4; k++) {
        const v = skin[i * 4 + k];
        if ((v & 0xff) > w) {
          w = v & 0xff;
          bone = v >> 8;
        }
      }
      let list = byBone.get(bone);
      if (!list) byBone.set(bone, (list = []));
      list.push(center.clone());
    });
    const box = (j: number, bones: number[], head: boolean) => {
      const pts = bones.flatMap((b) => byBone.get(b) ?? []);
      if (pts.length < 40) return;
      const ax = (k: "x" | "y" | "z") => {
        const v = pts.map((p) => p[k] - rest[j][k]);
        return [pct(v, 0.01), pct(v, 0.99)];
      };
      const [x, y, z] = [ax("x"), ax("y"), ax("z")];
      body.boxes.push({
        j,
        c: new THREE.Vector3((x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2),
        r: new THREE.Vector3((x[1] - x[0]) / 2 + SPLAT, (y[1] - y[0]) / 2 + SPLAT, (z[1] - z[0]) / 2 + SPLAT),
        head,
      });
    };
    for (const j of TORSO) box(j, [j], false);
    const belly = body.boxes.filter((b) => b.j === 3 || b.j === 6).map((b) => b.c.z + b.r.z);
    if (belly.length) body.front = Math.max(...belly);
    box(NECK, [NECK], true);
    box(HEAD, [HEAD, ...FACE], true);
    // how far the sleeve and the hand reach from their bones' axes (most of it: a few stray Gaussians don't count)
    const radius = (bones: number[], a: THREE.Vector3, b: THREE.Vector3) => {
      const axis = b.clone().sub(a).normalize();
      const d = bones.flatMap((k) => byBone.get(k) ?? []).map((p) => _l.copy(p).sub(a).cross(axis).length());
      return d.length > 40 ? pct(d, 0.9) + SPLAT / 2 : null;
    };
    for (const side of [0, 1] as const) {
      const [el, wr] = side === 0 ? [L_ELBOW, L_WRIST] : [R_ELBOW, R_WRIST];
      const mid = FINGERS[side][3]; // middle1
      body.arm[side] = THREE.MathUtils.clamp(radius([el], rest[el], rest[wr]) ?? 0.045, 0.035, 0.09);
      // a flat hand is wide, not thick: as one radius around its axis, at most 4.5 cm
      body.hand[side] = THREE.MathUtils.clamp(radius([wr, ...FINGERS[side]], rest[wr], rest[mid]) ?? 0.03, 0.02, 0.045);
      const tips = (byBone.get(FINGERS[side][5]) ?? []).map((p) => p.distanceTo(rest[wr])); // middle3
      body.handLen[side] = THREE.MathUtils.clamp(tips.length > 10 ? pct(tips, 0.95) : rest[mid].distanceTo(rest[wr]) * 1.9, 0.14, 0.24);
    }
    return body;
  }

  /**
   * How deep a ball of radius `grow` at p (bundle space) reaches into the body (0 when clear), in meters, and the way
   * out of the box it's deepest in (bundle, unit). G, P: each joint's global rotation and position this frame.
   * which: the whole body, the torso alone, or the head and neck alone (a hand may rest against the face on purpose).
   */
  depth(p: THREE.Vector3, grow: number, G: THREE.Quaternion[], P: THREE.Vector3[], out?: THREE.Vector3, which: "all" | "torso" | "head" = "all"): number {
    let best = 0;
    for (const b of this.boxes) {
      if ((which === "torso" && b.head) || (which === "head" && !b.head)) continue;
      _l.copy(p).sub(P[b.j]).applyQuaternion(_q.copy(G[b.j]).invert()).sub(b.c);
      const rx = b.r.x + grow;
      const ry = b.r.y + grow;
      const rz = b.r.z + grow;
      // a rounded block: |x/rx|^n + |y/ry|^n + |z/rz|^n < 1 inside
      const f = Math.abs(_l.x / rx) ** ROUND + Math.abs(_l.y / ry) ** ROUND + Math.abs(_l.z / rz) ** ROUND;
      if (f >= 1) continue;
      const s = Math.max(f ** (1 / ROUND), 1e-3); // the point is s of the way from the centre to the surface
      const len = _l.length();
      const d = Math.min(len * (1 / s - 1), Math.max(rx, ry, rz));
      if (d <= best) continue;
      best = d;
      if (out) {
        if (len < 1e-4) out.set(0, 0, 1);
        else out.copy(_l).divideScalar(len);
        out.applyQuaternion(G[b.j]);
      }
    }
    return best;
  }
}
