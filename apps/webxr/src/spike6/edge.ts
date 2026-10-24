import * as THREE from "three";

// Ojasva's condition for AR-opaque: the room fades in as you near the edge of the play area, always on. The edge is the
// guardian boundary (bounded-floor's boundsGeometry) when the browser gives it, else a 3.5 x 3.5 m square centred where
// the session started, turned to face the court. The opaque set is fully there 0.6 m from the edge and fully gone 0.3 m
// from it (smoothstep in between), every frame.

export const EDGE_START_M = 0.6;
export const EDGE_FULL_M = 0.3;
export const SQUARE_M = 3.5;

type Pt = { x: number; z: number };
export type EdgeArea =
  | { kind: "boundary"; space: XRReferenceSpace; points: Pt[]; w: number; d: number }
  | { kind: "square"; cx: number; cz: number; fx: number; fz: number; half: number };

/** Signed distance from p to a closed polygon's edges: positive inside, negative outside. */
export function polygonDistance(points: Pt[], p: Pt): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j];
    const b = points[i];
    if (b.z > p.z !== a.z > p.z && p.x < ((a.x - b.x) * (p.z - b.z)) / (a.z - b.z) + b.x) inside = !inside;
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.z - a.z) * ez) / (ex * ex + ez * ez || 1)));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * ex), p.z - (a.z + t * ez)));
  }
  return inside ? best : -best;
}

export class EdgeFade {
  area: EdgeArea | null = null;
  enabled = true; // off only while the boundary questions test the browser's own behaviour
  level = 1; // 1 = the opaque set, 0 = your room
  distanceM: number | null = null; // to the edge, negative past it

  setBoundary(space: XRReferenceSpace, points: Pt[]) {
    const xs = points.map((p) => p.x);
    const zs = points.map((p) => p.z);
    this.area = { kind: "boundary", space, points, w: Math.max(...xs) - Math.min(...xs), d: Math.max(...zs) - Math.min(...zs) };
  }

  /** The fallback play area: centred on where you stand, its sides along your facing. */
  setSquare(head: THREE.Vector3, forward: THREE.Vector3) {
    this.area = { kind: "square", cx: head.x, cz: head.z, fx: forward.x, fz: forward.z, half: SQUARE_M / 2 };
  }

  label(): string {
    const a = this.area;
    if (!a) return "none";
    return a.kind === "boundary" ? `boundary ${a.w.toFixed(1)} x ${a.d.toFixed(1)} m` : `${SQUARE_M} m square at start`;
  }

  /** Once a frame, with the head in three's reference space. */
  update(frame: XRFrame, head: THREE.Vector3) {
    const a = this.area;
    if (!a) return;
    let d: number;
    if (a.kind === "boundary") {
      const p = frame.getViewerPose(a.space)?.transform.position;
      if (!p) return;
      d = polygonDistance(a.points, { x: p.x, z: p.z });
    } else {
      const dx = head.x - a.cx;
      const dz = head.z - a.cz;
      const u = dx * a.fx + dz * a.fz;
      const v = -dx * a.fz + dz * a.fx;
      d = Math.min(a.half - Math.abs(u), a.half - Math.abs(v));
    }
    this.distanceM = d;
    const t = Math.min(1, Math.max(0, (d - EDGE_FULL_M) / (EDGE_START_M - EDGE_FULL_M)));
    this.level = this.enabled ? t * t * (3 - 2 * t) : 1;
  }
}

/**
 * The opacity of an alpha-blend session comes from geometry: three clears to (0,0,0,0) there whatever the clear colour.
 * A black sphere around the head, drawn first with no depth test or write and no blending, writes (0,0,0,opacity) under
 * everything; the set draws over it. In VR it is just black under the arena (same cost in both modes).
 */
export function makeCurtain(): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000, side: THREE.BackSide, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(40, 24, 12), material);
  mesh.renderOrder = -100;
  mesh.frustumCulled = false;
  return mesh;
}
