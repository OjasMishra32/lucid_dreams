import * as THREE from "three";

// Scene understanding: the real surfaces the headset knows about (WebXR plane detection; on a Quest, the floor, tables
// and desks from its Space Setup), so what we bring can stand on the real ones. Everything here is plain geometry on
// the floor plan, so it's checked without a headset (scripts/check_planes.ts).

/** A real surface facing up: its height and outline, in the reference space (local-floor: the floor at y = 0). */
export interface Flat {
  y: number;
  /** The outline on the floor plan, (x, z). */
  pts: THREE.Vector2[];
  /** What the headset calls it ("table", "floor", ...), lower case; "" when it doesn't say. */
  label: string;
  /** m² */
  area: number;
}

const m4 = new THREE.Matrix4();
const v3 = new THREE.Vector3();

/** The up-facing surfaces detected this frame; none without plane detection (or before the headset has any). */
export function upFacing(frame: XRFrame | null | undefined, space: XRReferenceSpace | null | undefined): Flat[] {
  let planes: XRPlaneSet | undefined;
  try {
    planes = frame?.detectedPlanes ?? undefined;
  } catch {
    return []; // (a frame that's no longer live, or a session without the feature)
  }
  if (!frame || !planes || !space) return [];
  const out: Flat[] = [];
  for (const plane of planes) {
    if (plane.orientation && plane.orientation !== "horizontal") continue;
    const pose = frame.getPose(plane.planeSpace, space);
    if (!pose || plane.polygon.length < 3) continue;
    m4.fromArray(pose.transform.matrix);
    // its normal is its space's +Y: a table or the floor faces up, a ceiling down
    if (v3.set(0, 1, 0).transformDirection(m4).y < 0.95) continue;
    const pts = plane.polygon.map((p) => {
      v3.set(p.x, p.y, p.z).applyMatrix4(m4);
      return new THREE.Vector2(v3.x, v3.z);
    });
    out.push({ y: m4.elements[13], pts, label: (plane.semanticLabel ?? "").toLowerCase(), area: Math.abs(signedArea(pts)) });
  }
  return out;
}

/** The floor's height, when the headset has found it: the surface it calls the floor, else the largest one near y = 0. */
export function floorLevel(flats: Flat[]): number | null {
  const named = flats.filter((f) => f.label === "floor");
  const near = named.length ? named : flats.filter((f) => Math.abs(f.y) < 0.3 && f.area > 1.5);
  if (!near.length) return null;
  return near.reduce((a, b) => (b.area > a.area ? b : a)).y;
}

/**
 * What a board needs from a table, in the board's own frame (meters from its centre; +x your right, +z toward you):
 * the table under all of [-left, right] x [-far, near], and nothing of it at -farMax across [-span, span] (that's where
 * the person across from you sits).
 */
export interface Footprint {
  left: number;
  right: number;
  near: number;
  far: number;
  farMax: number;
  span: number;
}

/** Where a board goes: its centre on the surface (y: the surface's height) and its turn (three's rotation.y). */
export interface Spot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  flat: Flat;
}

const SKIP = new Set(["floor", "ceiling", "bed", "couch", "wall", "door", "window"]);

/**
 * A table in front of you for the board: an up-facing surface at table height (lo..hi above the floor) that the
 * footprint fits on, its near side toward you, within reach (centre at most `reach` from your head on the floor plan).
 * The board is squared to the table's edge you face (else to your view), centred on you along it as far as it fits, and
 * as near you as it fits. null when none fits: too small, too deep, too far, or none at all.
 */
export function tableSpot(
  flats: Flat[],
  head: THREE.Vector3,
  forward: THREE.Vector3,
  fp: Footprint,
  { floor = 0, lo = 0.6, hi = 0.95, reach = 0.9 } = {},
): Spot | null {
  const f = new THREE.Vector2(forward.x, forward.z);
  if (f.lengthSq() < 1e-6) return null;
  f.normalize();
  const h = new THREE.Vector2(head.x, head.z);
  let best: { score: number; spot: Spot } | null = null;
  for (const flat of flats) {
    const above = flat.y - floor;
    if (above < lo || above > hi || SKIP.has(flat.label)) continue;
    const named = flat.label === "table" || flat.label === "desk";
    for (const { d, aligned } of directions(flat.pts, h, f)) {
      const yaw = Math.atan2(-d.x, -d.y); // the board's +z (your side) toward you, against d
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      for (let side = 0; side <= 0.4 + 1e-9; side += 0.05)
        for (const sign of side ? [1, -1] : [1])
          for (let depth = 0.2; depth <= reach + 1e-9; depth += 0.02) {
            const lat = side * sign;
            // board centre: ahead of you along d, and along the table's edge by lat (the board's +x, your right)
            const x = h.x + d.x * depth + c * lat;
            const z = h.y + d.y * depth - s * lat;
            if (!fitsAt(flat.pts, x, z, yaw, fp)) continue;
            // nearer is better, then straight ahead of you; a named table and squared to its edge win ties
            const score = depth + 0.6 * side + (aligned ? 0 : 0.08) + (named ? 0 : 0.05);
            if (!best || score < best.score) best = { score, spot: { x, y: flat.y, z, yaw, flat } };
            break; // (the nearest that fits along this line)
          }
    }
  }
  return best?.spot ?? null;
}

/** Whether a board at (x, z), turned by yaw, sits on this surface as the footprint asks. */
export function fits(flat: Flat, x: number, z: number, yaw: number, fp: Footprint): boolean {
  return fitsAt(flat.pts, x, z, yaw, fp);
}

function fitsAt(pts: THREE.Vector2[], x: number, z: number, yaw: number, fp: Footprint): boolean {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // board-local (lx, lz) on the floor plan: three's rotation.y takes +x to (cos, -sin) and +z to (sin, cos)
  const at = (lx: number, lz: number) => inside(pts, x + c * lx + s * lz, z - s * lx + c * lz);
  for (let i = 0; i <= 4; i++)
    for (let j = 0; j <= 4; j++) if (!at(-fp.left + ((fp.left + fp.right) * i) / 4, -fp.far + ((fp.far + fp.near) * j) / 4)) return false;
  for (const lx of [-fp.span, 0, fp.span]) if (at(lx, -fp.farMax)) return false;
  return true;
}

/** Ways into the table from where you stand: straight in from each edge facing you (squared to it), and your view. */
function directions(pts: THREE.Vector2[], head: THREE.Vector2, forward: THREE.Vector2) {
  const out: { d: THREE.Vector2; aligned: boolean }[] = [];
  const centre = pts.reduce((a, p) => a.add(p), new THREE.Vector2()).divideScalar(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const e = b.clone().sub(a);
    if (e.length() < 0.2) continue; // a corner's short facet, not a side
    const d = new THREE.Vector2(-e.y, e.x).normalize();
    const mid = a.clone().add(b).multiplyScalar(0.5);
    if (d.dot(centre.clone().sub(mid)) < 0) d.negate(); // into the table
    // an edge you're outside of, more or less in front of you
    if (d.dot(head.clone().sub(mid)) < 0 && d.dot(forward) > Math.cos(THREE.MathUtils.degToRad(55))) out.push({ d, aligned: true });
  }
  out.push({ d: forward.clone(), aligned: false });
  return out;
}

/** Point in polygon (crossings), on the floor plan. */
export function inside(pts: THREE.Vector2[], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > z !== b.y > z && x < ((b.x - a.x) * (z - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

function signedArea(pts: THREE.Vector2[]): number {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return s / 2;
}

/**
 * Invisible, depth-only stand-in for a real surface (drawn before everything else): what's under a real table stays
 * hidden under it in passthrough, as it would in the room (the legs of someone sitting at it, a chair's seat).
 */
export function surfaceOccluder(flat: Flat): THREE.Mesh {
  // the shape is drawn in x, y and laid flat: (x, y) -> (x, 0, -y), so y is -z
  const shape = new THREE.Shape(flat.pts.map((p) => new THREE.Vector2(p.x, -p.y)));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
  mesh.position.y = flat.y;
  mesh.renderOrder = -1;
  return mesh;
}
