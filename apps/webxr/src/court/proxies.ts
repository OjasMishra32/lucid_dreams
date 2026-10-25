// Everything the footage is projected onto, each show frame from its own solved camera (never a smoothed path; the
// bake undistorted it, so this is a pure pinhole), in layers (3.2): the frame's background plate (every person
// removed) on the court plane (exact: it's planar), the stands proxy, the backboard plane (court.backboard) and the
// depth cards (front row, photographers, the ref); one card per person from cards.json, stood at their foot point and
// cut by their matte-atlas tile, so nobody shows twice through a gap and nobody tears at an edge (P43); the ball's
// card at the make. Each card is a grid laid along camera rays from the one fixed centre, so sliding a vertex along
// its ray never changes which pixel it shows: as the show nears F each pair player's card slides onto the depth of
// their own freeze splats seen from camera F (proxy.glb, the ball's front included), so at F the video layer sits on
// the splat-depth proxy and the hand-off is exact from the dolly seat (P8), with no jump on a still frame. Two
// layers: the video layer (a composite over the 3D, drawn after the splats at ShowVideo.opacity, the cinema mask's
// dark on its plates outside the frame) and the 3D's background (the same plate on the same proxies, drawn before
// the splats, shown once the video fades), so the two match by construction. Every footage colour is multiplied in
// linear light by the one light field (lightfield.ts `glsl`: courtLight, the room's opacity, the dither), the
// courtside plate also by the off-ray dim (`dim(p)`, world.ts, P30), the plate by the Reality check. Domes and
// spheres are never used (3.3: they misalign by 0.16-1.2 deg). Stream D (`handoff`) builds it.
// With `court.surround.far` (surround.ts) the pan's far end, people removed, is one more layer of the 3D under the
// plates: projected from camera F's centre on the same floor (up to the bowl's foot), stands proxy and backboard,
// it carries on round the picture wherever the pan filmed, so the cinema mask darkens it to a night-game level
// (CINEMA_SURROUND) instead of black, and the plates' feathered edges blend into the same scene; inside F's frame the
// plate covers it, so the hand-off is unchanged there. Off the camera ray the courtside plate and the far image fade
// out (P30 as opacity, not darkness) to the imagined bowl behind them (world.ts) instead of to black.
import * as THREE from "three";
import { cameraOf, rotate, conjugate, type PinholeCamera } from "./camera";
import type { CourtBundle, SurroundFar, Vec3 } from "./format";
import { PART, type LightField } from "./lightfield";
import { bowlLayout, farCamera } from "./surround";
import type { ShowVideo } from "./video";

/** True once stream D has built this module. */
export const BUILT = true;

/** The 3D's plates draw before Spark's splats (its SparkRenderer mesh is renderOrder 0, transparent) and the hoop (-5). */
export const ORDER_BACKGROUND = -50;
/** The video layer draws after them: plates, depth cards (+1), people back to front (+10..), the ball (+40); the UI is at 100. */
export const ORDER_VIDEO = 50;
/** How dark the cinema mask makes the world round the lit footage region (House Lights' rig). */
export const CINEMA = 0.96;
/** ...when the bundle has a surround: the far image and the bowl round the picture stay at a night game's level. */
export const CINEMA_SURROUND = 0.55;
/** The far image's long side on the GPU, texels (a 2x-wide far image keeps several texels per Quest pixel, 19.5 px/deg). */
const FAR_TEXELS = 2048;
/** The far image fades out over this share of it at its own edges. */
const FAR_EDGE = 0.03;
/** The lit region's edges are feathered over this share of the frame (3.2: ~10%). */
export const FEATHER = 0.1;
/** A pair player's card reaches their splat depth this close to F, real seconds (the 1.2 s ease's span at 0.6x). */
export const DEPTH_TAU_S = 0.36;
/** Person cards drawn at most per frame. */
export const MAX_CARDS = 16;
/** The splat-depth image's long side, texels. */
const DEPTH_TEXELS = 256;
/** The depth is trusted this many texels past the silhouette (filled from inside), then falls to the card's plane. */
const DEPTH_BAND = 12;
/** A depth step: corners or neighbours this far apart along the ray are two surfaces, never one stretched across, metres. */
const MAX_STEP = 0.1;
/** ...when the triangle between them is seen this close to edge-on from camera F (cos 85 deg): a real slant is never that steep. */
const EDGE_ON_COS = Math.cos((85 * Math.PI) / 180);

/** A card's plane: a person's stands upright through their foot, square to the camera's horizontal ray; the ball's faces the camera. */
export function cardPlane(at: Vec3, centre: Vec3, kind: "person" | "ball"): { point: Vec3; normal: Vec3 } {
  const d: Vec3 = [at[0] - centre[0], kind === "ball" ? at[1] - centre[1] : 0, at[2] - centre[2]];
  const n = Math.hypot(d[0], d[1], d[2]);
  return { point: [...at], normal: [d[0] / n, d[1] / n, d[2] / n] };
}

/** How far a pair player's card has slid onto their splat depth: 1 on F, 0 from DEPTH_TAU_S of real time away, smootherstep between. */
export function depthWeight(src: number, freezeSource: number, srcPerSecond: number): number {
  const u = Math.min(1, Math.abs(src - freezeSource) / srcPerSecond / DEPTH_TAU_S);
  return 1 - u * u * u * (u * (6 * u - 15) + 10);
}

/** The source-pixel box (edges) around a mesh seen from a camera, grown by `margin` of its size on each side. */
export function depthBox(cam: PinholeCamera, positions: Float32Array, margin: number): [number, number, number, number] {
  const inv = conjugate(cam.q);
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const c = rotate(inv, [positions[i] - cam.centre[0], positions[i + 1] - cam.centre[1], positions[i + 2] - cam.centre[2]]);
    if (c[2] <= 1e-6) continue;
    const u = cam.cx + (cam.f * c[0]) / c[2] + 0.5;
    const v = cam.cy + (cam.f * c[1]) / c[2] + 0.5;
    [x0, y0, x1, y1] = [Math.min(x0, u), Math.min(y0, v), Math.max(x1, u), Math.max(y1, v)];
  }
  const mx = (x1 - x0) * margin;
  const my = (y1 - y0) * margin;
  return [x0 - mx, y0 - my, x1 + mx, y1 + my];
}

/**
 * The splat-depth proxy as camera F sees it: for each texel of `box` (source-pixel edges, w x h texels, rows from the
 * top), the distance from the camera centre along that texel's ray to the nearest triangle (or the ball's sphere, when
 * given), metres; 0 where the ray misses. A triangle whose corners differ in distance by more than `maxStep` spans a
 * depth step (an arm in front of the torso, a body's edge against the fill behind it) and is left out, so the step
 * stays a step once dilateDepth fills the gap from each side instead of a rubber sheet across it.
 */
export function rasterDepth(
  positions: Float32Array, indices: Uint32Array, cam: PinholeCamera, box: [number, number, number, number], w: number, h: number,
  ball?: { centre: Vec3; radius: number }, maxStep = MAX_STEP,
): Float32Array {
  const out = new Float32Array(w * h);
  const C = cam.centre;
  const inv = conjugate(cam.q);
  const sx = (box[2] - box[0]) / w;
  const sy = (box[3] - box[1]) / h;
  // each texel's ray
  const dirs = new Float32Array(w * h * 3);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const u = box[0] + (i + 0.5) * sx - 0.5;
      const v = box[1] + (j + 0.5) * sy - 0.5;
      const d = rotate(cam.q, [(u - cam.cx) / cam.f, (v - cam.cy) / cam.f, 1]);
      const n = Math.hypot(d[0], d[1], d[2]);
      dirs.set([d[0] / n, d[1] / n, d[2] / n], (j * w + i) * 3);
    }
  // each vertex in texel coordinates
  const nv = positions.length / 3;
  const tx = new Float32Array(nv);
  const ty = new Float32Array(nv);
  const front = new Uint8Array(nv);
  const dist = new Float32Array(nv);
  for (let k = 0; k < nv; k++) {
    dist[k] = Math.hypot(positions[3 * k] - C[0], positions[3 * k + 1] - C[1], positions[3 * k + 2] - C[2]);
    const c = rotate(inv, [positions[3 * k] - C[0], positions[3 * k + 1] - C[1], positions[3 * k + 2] - C[2]]);
    front[k] = c[2] > 1e-6 ? 1 : 0;
    tx[k] = (cam.cx + (cam.f * c[0]) / c[2] + 0.5 - box[0]) / sx - 0.5;
    ty[k] = (cam.cy + (cam.f * c[1]) / c[2] + 0.5 - box[1]) / sy - 0.5;
  }
  for (let f = 0; f < indices.length; f += 3) {
    const a = indices[f];
    const b = indices[f + 1];
    const c = indices[f + 2];
    if (!front[a] || !front[b] || !front[c]) continue;
    const i0 = Math.max(0, Math.floor(Math.min(tx[a], tx[b], tx[c])));
    const i1 = Math.min(w - 1, Math.ceil(Math.max(tx[a], tx[b], tx[c])));
    const j0 = Math.max(0, Math.floor(Math.min(ty[a], ty[b], ty[c])));
    const j1 = Math.min(h - 1, Math.ceil(Math.max(ty[a], ty[b], ty[c])));
    if (i0 > i1 || j0 > j1) continue;
    // Moller-Trumbore against each texel ray in the triangle's box
    const ax = positions[3 * a] - C[0], ay = positions[3 * a + 1] - C[1], az = positions[3 * a + 2] - C[2];
    const e1x = positions[3 * b] - positions[3 * a], e1y = positions[3 * b + 1] - positions[3 * a + 1], e1z = positions[3 * b + 2] - positions[3 * a + 2];
    const e2x = positions[3 * c] - positions[3 * a], e2y = positions[3 * c + 1] - positions[3 * a + 1], e2z = positions[3 * c + 2] - positions[3 * a + 2];
    // a step: more than maxStep of depth across a triangle seen edge-on (a slanted surface of any size is kept)
    if (Math.max(dist[a], dist[b], dist[c]) - Math.min(dist[a], dist[b], dist[c]) > maxStep) {
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const gx = ax + (e1x + e2x) / 3, gy = ay + (e1y + e2y) / 3, gz = az + (e1z + e2z) / 3;
      if (Math.abs(nx * gx + ny * gy + nz * gz) < EDGE_ON_COS * Math.hypot(nx, ny, nz) * Math.hypot(gx, gy, gz)) continue;
    }
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const o = (j * w + i) * 3;
        const dx = dirs[o], dy = dirs[o + 1], dz = dirs[o + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const id = 1 / det;
        const sxv = -ax, syv = -ay, szv = -az; // ray origin (the centre, 0) minus vertex a
        const uu = (sxv * px + syv * py + szv * pz) * id;
        if (uu < 0 || uu > 1) continue;
        const qx = syv * e1z - szv * e1y, qy = szv * e1x - sxv * e1z, qz = sxv * e1y - syv * e1x;
        const vv = (dx * qx + dy * qy + dz * qz) * id;
        if (vv < 0 || uu + vv > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * id;
        if (t > 0 && (out[j * w + i] === 0 || t < out[j * w + i])) out[j * w + i] = t;
      }
  }
  if (ball) {
    const oc: Vec3 = [ball.centre[0] - C[0], ball.centre[1] - C[1], ball.centre[2] - C[2]];
    const cc = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - ball.radius * ball.radius;
    for (let k = 0; k < w * h; k++) {
      const b = dirs[3 * k] * oc[0] + dirs[3 * k + 1] * oc[1] + dirs[3 * k + 2] * oc[2];
      const disc = b * b - cc;
      if (disc < 0) continue;
      const t = b - Math.sqrt(disc);
      if (t > 0 && (out[k] === 0 || t < out[k])) out[k] = t;
    }
  }
  return out;
}

/**
 * Fill the depth outward from the silhouette for `band` texels (each new texel the mean of its filled 4-neighbours),
 * so a card sliding onto it never tears at the edge; `valid` is 1 on and near the body, falling to 0 at the band's end.
 */
export function dilateDepth(depth: Float32Array, w: number, h: number, band: number): { depth: Float32Array; valid: Float32Array } {
  const d = Float32Array.from(depth);
  const dist = new Float32Array(w * h).fill(Infinity);
  for (let k = 0; k < w * h; k++) if (d[k] > 0) dist[k] = 0;
  for (let it = 1; it <= band; it++) {
    const add: [number, number][] = [];
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (dist[k] < Infinity) continue;
        let s = 0;
        let n = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
          const kk = jj * w + ii;
          if (dist[kk] < it) {
            s += d[kk];
            n++;
          }
        }
        if (n) add.push([k, s / n]);
      }
    for (const [k, v] of add) {
      d[k] = v;
      dist[k] = it;
    }
  }
  const valid = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const x = Math.min(1, Math.max(0, (dist[k] - band * 0.5) / (band * 0.5)));
    valid[k] = dist[k] === Infinity ? 0 : 1 - x * x * (3 - 2 * x);
  }
  return { depth: d, valid };
}

/** Positions (court space, node transforms applied) and triangle indices of every mesh in a binary glTF. */
export function parseGlb(buffer: ArrayBuffer): { positions: Float32Array; indices: Uint32Array } {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("proxy.glb: not a binary glTF");
  let json: {
    scene?: number; scenes?: { nodes: number[] }[];
    nodes?: { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
    meshes?: { primitives: { attributes: { POSITION: number }; indices?: number; mode?: number }[] }[];
    accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }[];
    bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  } | null = null;
  let bin: DataView | null = null;
  for (let o = 12; o + 8 <= dv.byteLength; ) {
    const len = dv.getUint32(o, true);
    const type = dv.getUint32(o + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, o + 8, len)));
    else if (type === 0x004e4942) bin = new DataView(buffer, o + 8, len);
    o += 8 + len;
  }
  if (!json || !bin) throw new Error("proxy.glb: missing its JSON or BIN chunk");
  const g = json;
  const read = (a: number): number[] => {
    const acc = g.accessors[a];
    const view = g.bufferViews[acc.bufferView];
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type] ?? 1;
    const size = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType];
    if (!size) throw new Error(`proxy.glb: accessor ${a} has component type ${acc.componentType}`);
    const stride = view.byteStride ?? size * comps;
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const out: number[] = [];
    for (let i = 0; i < acc.count; i++)
      for (let c = 0; c < comps; c++) {
        const o = base + i * stride + c * size;
        out.push(acc.componentType === 5126 ? bin!.getFloat32(o, true) : acc.componentType === 5125 ? bin!.getUint32(o, true) : acc.componentType === 5123 ? bin!.getUint16(o, true) : bin!.getUint8(o));
      }
    return out;
  };
  const pos: number[] = [];
  const idx: number[] = [];
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const visit = (n: number, parent: THREE.Matrix4) => {
    const node = g.nodes?.[n];
    if (!node) return;
    const local = new THREE.Matrix4();
    if (node.matrix) local.fromArray(node.matrix);
    else
      local.compose(
        new THREE.Vector3(...((node.translation ?? [0, 0, 0]) as [number, number, number])),
        new THREE.Quaternion(...((node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
        new THREE.Vector3(...((node.scale ?? [1, 1, 1]) as [number, number, number])),
      );
    const world = m.copy(parent).multiply(local).clone();
    if (node.mesh !== undefined)
      for (const prim of g.meshes?.[node.mesh]?.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4) continue;
        const p = read(prim.attributes.POSITION);
        const base = pos.length / 3;
        for (let i = 0; i < p.length; i += 3) {
          v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(world);
          pos.push(v.x, v.y, v.z);
        }
        const ind = prim.indices !== undefined ? read(prim.indices) : Array.from({ length: p.length / 3 }, (_, i) => i);
        for (const i of ind) idx.push(base + i);
      }
    for (const c of node.children ?? []) visit(c, world);
  };
  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? (g.nodes ?? []).map((_, i) => i);
  for (const r of roots) visit(r, new THREE.Matrix4());
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

// ---------------- the layers ----------------

/**
 * The two plate layers' alphas where the frame's feathered edge is `f`, the arena's opacity (See my room, the edge
 * fade) `room`, the floor's filmed weight `filmed` (the light field's lightFilmedFloor: 1 at the seat, 0 walking off
 * F's view, the floor plate only) and the video layer is at opacity `v`: with e = f room filmed, the video's plates
 * (over the splats) at v e;
 * the 3D's (under them) at e(1 - v) / (1 - v e), so the two stacked always add up to the one plate at alpha e (the
 * feathered edge never brightens), while whatever the splats add round the cards fades in with the cards. The plate
 * shader computes exactly this.
 */
export function plateAlphas(v: number, f: number, room = 1, filmed = 1): { video: number; background: number } {
  const e = f * room * filmed;
  return { video: v * e, background: v >= 1 ? 0 : (e * (1 - v)) / Math.max(1 - v * e, 1e-4) };
}

/** The floor plate's half extent in x and z, metres: well past the court, so the cinema mask covers it all round. */
const FLOOR_HALF: [number, number] = [40, 30];

/** A stands plane the floor plate stops at: its plane (normal toward the court, offset), its span along its base, its heights. */
export interface FloorClip {
  plane: [number, number, number, number];
  span: [number, number, number, number];
  y: [number, number];
}

/** The stands planes as floor clips; `inside` is a court point (the floor behind a plane, seen from it, is cut). */
export function floorClips(quads: readonly (readonly Vec3[])[], inside: Vec3): FloorClip[] {
  return quads.map((q) => {
    const [p0, p1, , p3] = q;
    const u: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const w: Vec3 = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
    let n: Vec3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    n = n.map((x) => x / len) as Vec3;
    if (n[0] * (inside[0] - p0[0]) + n[1] * (inside[1] - p0[1]) + n[2] * (inside[2] - p0[2]) < 0) n = n.map((x) => -x) as Vec3;
    // the span along the base, horizontal
    const h = Math.hypot(u[0], u[2]) || 1;
    const a: [number, number] = [u[0] / h, u[2] / h];
    const along = q.map((c) => c[0] * a[0] + c[2] * a[1]);
    return {
      plane: [n[0], n[1], n[2], -(n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2])],
      span: [a[0], a[1], Math.min(...along), Math.max(...along)],
      y: [Math.min(...q.map((c) => c[1])), Math.max(...q.map((c) => c[1]))],
    };
  });
}

/**
 * The plate surface a view ray meets first: the floor (kind 0, inside its extent and in front of the stands) or a
 * stands plane (kind 1), or nothing (-1). The cinema mask's shader does the same per pixel, so its dark is judged on
 * the surface whose footage shows there.
 */
export function maskSurfaceHit(eye: Vec3, dir: Vec3, clips: readonly FloorClip[]): { kind: number; point: Vec3 } {
  let best = Infinity;
  let kind = -1;
  let point: Vec3 = [0, 0, 0];
  const at = (t: number): Vec3 => [eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t];
  if (dir[1] < -1e-9) {
    const t = -eye[1] / dir[1];
    const q = at(t);
    if (Math.abs(q[0]) <= FLOOR_HALF[0] && Math.abs(q[2]) <= FLOOR_HALF[1] && !behindStands(q, clips)) [best, kind, point] = [t, 0, q];
  }
  for (const { plane: n, span, y } of clips) {
    const den = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2];
    if (Math.abs(den) < 1e-9) continue;
    const t = -(n[0] * eye[0] + n[1] * eye[1] + n[2] * eye[2] + n[3]) / den;
    if (!(t > 0 && t < best)) continue;
    const q = at(t);
    const along = q[0] * span[0] + q[2] * span[1];
    if (along >= span[2] && along <= span[3] && q[1] >= y[0] && q[1] <= y[1]) [best, kind, point] = [t, 1, q];
  }
  return { kind, point };
}

/** True where a floor point lies behind a stands plane, within its span (the plate shader's twin). */
export function behindStands(p: Vec3, clips: readonly FloorClip[]): boolean {
  return clips.some(({ plane: n, span: s }) => {
    const along = p[0] * s[0] + p[2] * s[1];
    return n[0] * p[0] + n[1] * p[1] + n[2] * p[2] + n[3] < 0 && along >= s[2] && along <= s[3];
  });
}

/** Stands planes the floor plate's shader takes. */
const MAX_CLIPS = 8;
/** The cinema mask's shell round the court, metres (past the floor plate's corners). */
const SHELL_RADIUS = 80;

/** What each layer draws at the video layer's opacity and the cinema mask's level (0 = the watch's edge, 1 = lifted). */
export function layerVisibility(opacity: number, mask: number): { plates: boolean; cards: boolean; background: boolean } {
  return { plates: opacity > 0 || mask < 1, cards: opacity > 0, background: opacity < 1 };
}

/**
 * lightfield.ts's GLSL, with any helper this module calls that the field doesn't define filled in as "no change"
 * (the stub has only courtLight): lightDither(rgb), lightRoomStands(), lightRoomFloor(), lightPair(),
 * lightFilmedFloor(p).
 */
export function lightChunk(glsl: string): string {
  const has = (name: string) => new RegExp(`\\b(?:float|vec3)\\s+${name}\\s*\\(`).test(glsl);
  let out = glsl;
  if (!has("lightDither")) out += "vec3 lightDither(vec3 rgb) { return rgb; }\n";
  if (!has("lightRoomStands")) out += "float lightRoomStands() { return 1.0; }\n";
  if (!has("lightRoomFloor")) out += "float lightRoomFloor() { return 1.0; }\n";
  if (!has("lightPair")) out += "float lightPair() { return 1.0; }\n";
  if (!has("lightFilmedFloor")) out += "float lightFilmedFloor(vec3 p) { return 1.0; }\n";
  return out;
}

// ---------------- shaders ----------------

/** Camera k (the show frame on screen): camera-from-court rotation, the fixed centre, (f, cx, cy) in source pixels, source size; camera F's too. */
const CAMERA_GLSL = /* glsl */ `
  uniform mat3 uCamR; uniform mat3 uCamRT; uniform vec3 uCamC; uniform vec4 uCamK; uniform vec2 uSrc;
  uniform mat3 uCamFR; uniform vec4 uCamFK;
  vec3 toCam(vec3 p) { return uCamR * (p - uCamC); }
  vec2 camPx(vec3 p) { vec3 c = toCam(p); return vec2(uCamK.y + uCamK.x * c.x / c.z, uCamK.z + uCamK.x * c.y / c.z); }
  // camera F's frame coordinates of a court point (0-1 edge to edge, top-left origin; z <= 0 behind it)
  vec3 camFUv(vec3 p) { vec3 c = uCamFR * (p - uCamC); return vec3((vec2(uCamFK.y, uCamFK.z) + uCamFK.x * c.xy / c.z + 0.5) / uSrc, c.z); }`;

/** The footage's colour path (raw sRGB bytes in, raw out; the light field multiplies in linear light). */
const footageGlsl = (light: string) => /* glsl */ `
  ${light}
  uniform float uOpacity; uniform float uMask; uniform float uFeather; uniform float uWipe; uniform float uDim; uniform float uReality;
  uniform float uCinema; uniform float uDimAlpha;
  vec3 decodeSrgb(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
  vec3 encodeSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  vec3 relight(vec3 c, float k) { return abs(k - 1.0) < 1e-6 ? c : encodeSrgb(decodeSrgb(c) * k); }
  // region textures are written bottom-up; frame coordinates are 0-1 edge to edge from the top left
  vec4 region(sampler2D t, vec2 uv) { return texture2D(t, vec2(uv.x, 1.0 - uv.y)); }
  float frameFeather(vec2 uv) { vec2 e = min(uv, 1.0 - uv); return smoothstep(0.0, uFeather, e.x) * smoothstep(0.0, uFeather, e.y); }
  float outside(vec2 uv, float z) { if (z <= 0.0) return 1.0; vec2 e = min(uv, 1.0 - uv); return smoothstep(0.0, 0.15, -min(e.x, e.y)); }
  vec3 realityTint(vec3 c, float k) { return mix(c, vec3(0.22, 0.45, 1.0) * (0.35 + 0.65 * dot(c, vec3(0.2126, 0.7152, 0.0722))), 0.6 * k); }
  // the light field's parts (lightfield.ts PART); the courtside plate also dims off the camera ray (P30, perceived)
  float lightOfFloor(vec3 p) { return courtLight(vec3(p.x, 0.0, p.z), ${PART.floor.toFixed(1)}); }
  float crowdDim() { return pow(max(0.0, 1.0 - uDim), 2.2); }
  float lightOfCrowdLit(vec3 p) { return courtLight(p, ${PART.crowd.toFixed(1)}); }
  float lightOfCrowd(vec3 p) { return lightOfCrowdLit(p) * crowdDim(); }
  float lightOfPerson(vec3 foot) { return courtLight(vec3(foot.x, 0.0, foot.z), ${PART.person.toFixed(1)}); }
  // what the camera saw behind a point: the floor where its ray lands, else the crowd
  float lightBehind(vec3 p) { vec3 d = normalize(p - uCamC); return d.y < -1e-4 ? lightOfFloor(uCamC + d * (uCamC.y / -d.y)) : lightOfCrowd(p); }`;

const PLATE_VERT = /* glsl */ `
  varying vec3 vCourt; varying vec2 vUv;
  void main() {
    vCourt = position;
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const plateFrag = (light: string) => /* glsl */ `
  ${CAMERA_GLSL}
  ${footageGlsl(light)}
  uniform sampler2D uTex; uniform sampler2D uInpaint; uniform bool uHasInpaint; uniform sampler2D uStands; uniform bool uHasStands;
  uniform sampler2D uCardAlpha; uniform bool uHasCardAlpha; uniform int uKind; uniform int uLayer;
  uniform vec4 uClipPlane[${MAX_CLIPS}]; uniform vec4 uClipSpan[${MAX_CLIPS}]; uniform int uClips;
  varying vec3 vCourt; varying vec2 vUv;
  // the floor behind a stands plane is never seen (behindStands' twin): cut, or it shows through the stands from the seat
  bool behindStands(vec3 p) {
    for (int i = 0; i < ${MAX_CLIPS}; i++) {
      if (i >= uClips) break;
      float along = dot(p.xz, uClipSpan[i].xy);
      if (dot(uClipPlane[i].xyz, p) + uClipPlane[i].w < 0.0 && along >= uClipSpan[i].z && along <= uClipSpan[i].w) return true;
    }
    return false;
  }
  void main() {
    if (uKind == 0 && behindStands(vCourt)) discard;
    float z = toCam(vCourt).z;
    vec2 uv = (camPx(vCourt) + 0.5) / uSrc;
    float f = z > 0.0 ? frameFeather(uv) : 0.0;
    float card = uHasCardAlpha ? texture2D(uCardAlpha, vUv).a : 1.0;
    vec3 col = region(uTex, clamp(uv, 0.0, 1.0)).rgb;
    // the floor's light; the stands', the depth cards' and the crowd's pixels on the floor the crowd's (F's stands mask)
    vec3 uvF = camFUv(vCourt);
    float crowd = uKind == 1 ? 1.0 : uKind == 0 && uHasStands && uvF.z > 0.0 ? region(uStands, clamp(uvF.xy, 0.0, 1.0)).r : 0.0;
    // off the camera ray the crowd's pixels go dark (P30), or with a surround fade out to the bowl behind (uDimAlpha)
    col = relight(col, mix(lightOfFloor(vCourt), mix(lightOfCrowd(vCourt), lightOfCrowdLit(vCourt), uDimAlpha), crowd));
    if (uHasInpaint && uvF.z > 0.0) col = realityTint(col, uReality * step(0.5, region(uInpaint, clamp(uvF.xy, 0.0, 1.0)).r));
    col = lightDither(col * (1.0 - uWipe));
    // See my room and the edge fade: the arena's opacity, the stands' or the floor's, inside the layers' blend so the
    // two stacked stay the one plate (plateAlphas); the cinema mask's dark round the frame is the mask shell's
    float room = uKind == 1 ? lightRoomStands() : lightRoomFloor();
    // the floor plate is frame F's picture on the court plane: it holds only from near the seat; walking off F's view
    // the light field's clean court floor takes over (lightFilmedFloor, stream E). In edge, so both layers take it
    float edge = f * card * room * (uKind == 0 ? lightFilmedFloor(vCourt) : 1.0) * mix(1.0, crowdDim(), crowd * uDimAlpha);
    float a = uLayer == 0 ? uOpacity * edge : uOpacity >= 1.0 ? 0.0 : edge * (1.0 - uOpacity) / max(1.0 - uOpacity * edge, 1e-4);
    gl_FragColor = vec4(col * a, a);
  }`;

const SHELL_VERT = /* glsl */ `
  varying vec3 vCourt; varying vec3 vEye;
  void main() {
    vCourt = position;
    vEye = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/**
 * The cinema mask (House Lights' rig): the dark round the lit footage region, drawn on a shell round the court just
 * before the video layer's plates. Each pixel finds the plate surface its view ray meets (maskSurfaceHit's twin) and
 * is dark by how far outside camera k's frame that point is, so the dark meets the picture's feathered edge exactly
 * and covers every direction the plates don't (the bowl, the sky). It carries no footage.
 */
const shellFrag = (light: string) => /* glsl */ `
  ${CAMERA_GLSL}
  ${footageGlsl(light)}
  uniform vec4 uClipPlane[${MAX_CLIPS}]; uniform vec4 uClipSpan[${MAX_CLIPS}]; uniform vec2 uClipY[${MAX_CLIPS}]; uniform int uClips;
  varying vec3 vCourt; varying vec3 vEye;
  bool behindStands(vec3 p) {
    for (int i = 0; i < ${MAX_CLIPS}; i++) {
      if (i >= uClips) break;
      float along = dot(p.xz, uClipSpan[i].xy);
      if (dot(uClipPlane[i].xyz, p) + uClipPlane[i].w < 0.0 && along >= uClipSpan[i].z && along <= uClipSpan[i].w) return true;
    }
    return false;
  }
  void main() {
    vec3 dir = vCourt - vEye;
    float best = 1e9;
    float kind = -1.0;
    vec3 p = vCourt;
    if (dir.y < -1e-6) {
      float t = -vEye.y / dir.y;
      vec3 q = vEye + dir * t;
      if (abs(q.x) <= ${FLOOR_HALF[0].toFixed(1)} && abs(q.z) <= ${FLOOR_HALF[1].toFixed(1)} && !behindStands(q)) { best = t; kind = 0.0; p = q; }
    }
    for (int i = 0; i < ${MAX_CLIPS}; i++) {
      if (i >= uClips) break;
      float den = dot(uClipPlane[i].xyz, dir);
      if (abs(den) < 1e-6) continue;
      float t = -(dot(uClipPlane[i].xyz, vEye) + uClipPlane[i].w) / den;
      if (t <= 0.0 || t >= best) continue;
      vec3 q = vEye + dir * t;
      float along = dot(q.xz, uClipSpan[i].xy);
      if (along >= uClipSpan[i].z && along <= uClipSpan[i].w && q.y >= uClipY[i].x && q.y <= uClipY[i].y) { best = t; kind = 1.0; p = q; }
    }
    vec2 uv = (camPx(p) + 0.5) / uSrc;
    float room = kind == 0.0 ? lightRoomFloor() : lightRoomStands();
    float a = uMask * uCinema * (kind < 0.0 ? 1.0 : outside(uv, toCam(p).z)) * room;
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
  }`;

const FAR_VERT = /* glsl */ `
  attribute float aKind;
  varying vec3 vCourt; varying float vKind;
  void main() {
    vCourt = position;
    vKind = aKind;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/**
 * The far image (surround.far): the pan's far end, people removed, one pinhole image at camera F's centre, projected
 * onto the floor (kind 0: in front of the stands and the bowl's foot, held only near the seat as the floor plate is),
 * the stands proxy (1: the crowd's light; fading out off the camera ray, P30) and the backboard (2). Its alpha is
 * where the pan filmed. Under the plates in the 3D (their feathered edges blend into it), over the bowl.
 */
const farFrag = (light: string) => /* glsl */ `
  ${CAMERA_GLSL}
  ${footageGlsl(light)}
  uniform sampler2D uFar; uniform mat3 uFarR; uniform vec4 uFarK; uniform vec2 uFarSize;
  uniform vec4 uBowl; uniform float uBowlR;
  uniform vec4 uClipPlane[${MAX_CLIPS}]; uniform vec4 uClipSpan[${MAX_CLIPS}]; uniform int uClips;
  varying vec3 vCourt; varying float vKind;
  bool behindStands(vec3 p) {
    for (int i = 0; i < ${MAX_CLIPS}; i++) {
      if (i >= uClips) break;
      float along = dot(p.xz, uClipSpan[i].xy);
      if (dot(uClipPlane[i].xyz, p) + uClipPlane[i].w < 0.0 && along >= uClipSpan[i].z && along <= uClipSpan[i].w) return true;
    }
    return false;
  }
  // surround.ts bowlDistance: metres outside the bowl's foot (a rounded rectangle)
  float bowlDistance(vec2 p) {
    vec2 q = vec2(max(uBowl.x + uBowlR - p.x, p.x - (uBowl.y - uBowlR)), max(uBowl.z + uBowlR - p.y, p.y - (uBowl.w - uBowlR)));
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uBowlR;
  }
  void main() {
    bool floorKind = vKind < 0.5;
    bool stands = vKind > 0.5 && vKind < 1.5;
    vec3 c = uFarR * (vCourt - uCamC);
    vec2 uv = (vec2(uFarK.y, uFarK.z) + uFarK.x * c.xy / c.z + 0.5) / uFarSize;
    vec2 gx = dFdx(uv);
    vec2 gy = dFdy(uv);
    if (floorKind && (behindStands(vCourt) || bowlDistance(vCourt.xz) > 0.0)) discard;
    if (c.z <= 0.0 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard;
    vec4 t = textureGrad(uFar, uv, gx, gy); // rows from the top
    // the image's own edges fade over FAR_EDGE of it into the bowl behind, so the pan's end is never a hard line
    vec2 e = min(uv, 1.0 - uv);
    t.a *= smoothstep(0.0, ${FAR_EDGE.toFixed(3)}, e.x) * smoothstep(0.0, ${FAR_EDGE.toFixed(3)}, e.y);
    if (t.a <= 0.002) discard;
    vec3 col = relight(t.rgb, stands ? lightOfCrowdLit(vCourt) : lightOfFloor(vCourt));
    col = lightDither(col * (1.0 - uWipe));
    float room = stands ? lightRoomStands() : lightRoomFloor();
    float k = floorKind ? lightFilmedFloor(vCourt) : stands ? crowdDim() : 1.0;
    gl_FragColor = vec4(col, t.a * k * room);
  }`;

/** A person card's grid: vertices across and down its box. */
const CARD_GRID: [number, number] = [64, 128];

const CARD_VERT = /* glsl */ `
  ${CAMERA_GLSL}
  uniform vec4 uBox; uniform vec3 uPlaneP; uniform vec3 uPlaneN; uniform vec4 uTile; uniform sampler2D uMattes;
  uniform sampler2D uDepth; uniform bool uHasDepth; uniform float uDepthP; uniform float uDepthRef; uniform vec4 uDepthBox;
  varying vec3 vCourt;
  const vec2 CELL = vec2(${(1 / CARD_GRID[0]).toFixed(6)}, ${(1 / CARD_GRID[1]).toFixed(6)});
  // the ray through the box at st (0-1 from its top left; pixel edges -> pixel centres)
  vec3 rayAt(vec2 st) {
    vec2 px = mix(uBox.xy, uBox.zw, st) - 0.5;
    return normalize(uCamRT * vec3((px.x - uCamK.y) / uCamK.x, (px.y - uCamK.z) / uCamK.x, 1.0));
  }
  // the splat-depth proxy along that ray (the same ray in camera F: one fixed centre): distance, trust (0 = none)
  vec2 proxyAt(vec2 st) {
    vec3 cf = uCamFR * rayAt(st);
    vec2 pf = vec2(uCamFK.y + uCamFK.x * cf.x / cf.z, uCamFK.z + uCamFK.x * cf.y / cf.z) + 0.5;
    vec2 sf = (pf - uDepthBox.xy) / (uDepthBox.zw - uDepthBox.xy);
    if (cf.z <= 0.0 || any(lessThan(sf, vec2(0.0))) || any(greaterThan(sf, vec2(1.0)))) return vec2(0.0);
    vec2 dv = textureLod(uDepth, sf, 0.0).rg;
    return vec2(uDepthRef + dv.r, dv.g);
  }
  // this frame's matte for the card at st
  float matteAt(vec2 st) {
    vec2 tuv = mix(uTile.xy, uTile.zw, clamp(st, 0.0, 1.0));
    return textureLod(uMattes, vec2(tuv.x, 1.0 - tuv.y), 0.0).r;
  }
  void main() {
    vec2 st = vec2(uv.x, 1.0 - uv.y);
    vec3 d = rayAt(st);
    float t = dot(uPlaneP - uCamC, uPlaneN) / dot(d, uPlaneN);
    if (uHasDepth && uDepthP > 0.0) {
      vec2 z = proxyAt(st);
      // where the matte's edge crosses this vertex's cells, the silhouette is a contour of a round body: its depth is
      // the farthest of the body's samples there (the surface turns away steeply), not the nearer one inside, which
      // would pull the edge outward from any eye off camera F's ray; unless the samples span a depth step (a hand in
      // front of the torso across a narrow gap): then each part keeps its own
      float far = -1.0;
      float near = 1e9;
      bool edge = false;
      for (int j = -1; j <= 1; j++)
        for (int i = -1; i <= 1; i++) {
          vec2 sn = st + vec2(float(i), float(j)) * CELL;
          if (matteAt(sn) < 0.5) edge = true;
          else {
            vec2 zn = proxyAt(sn);
            if (zn.y > 0.5) {
              far = max(far, zn.x);
              near = min(near, zn.x);
            }
          }
        }
      if (edge && far > 0.0 && far - near < ${MAX_STEP.toFixed(3)}) z = vec2(far, 1.0);
      t = mix(t, z.x, uDepthP * z.y);
    }
    vCourt = uCamC + d * t;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(vCourt, 1.0);
  }`;

const cardFrag = (light: string) => /* glsl */ `
  ${CAMERA_GLSL}
  ${footageGlsl(light)}
  uniform sampler2D uLive; uniform sampler2D uMattes; uniform vec2 uMattesSize;
  uniform vec4 uBox; uniform vec4 uTile; uniform vec3 uAt; uniform float uPair;
  varying vec3 vCourt;
  void main() {
    float z = toCam(vCourt).z;
    vec2 px = camPx(vCourt) + 0.5;
    vec2 st = (px - uBox.xy) / (uBox.zw - uBox.xy);
    if (z <= 0.0 || any(lessThan(st, vec2(0.0))) || any(greaterThan(st, vec2(1.0)))) discard;
    // the tile's mips stop at 2 so neighbouring tiles never bleed in
    vec2 tuv = mix(uTile.xy, uTile.zw, st);
    tuv.y = 1.0 - tuv.y;
    vec2 tpx = tuv * uMattesSize;
    float lod = clamp(log2(max(max(length(dFdx(tpx)), length(dFdy(tpx))), 1e-6)), 0.0, 2.0);
    float m = textureLod(uMattes, tuv, lod).r;
    if (m <= 0.002) discard;
    vec2 uv = px / uSrc;
    vec3 col = region(uLive, uv).rgb;
    // the matte's soft edge still holds what was behind, lit as that; the person is lit where they stand, and the pair
    // as their splats are (lightPair: full through the time stop, whatever the pool under them is doing)
    float k = mix(lightBehind(vCourt), uPair > 0.5 ? lightPair() : lightOfPerson(uAt), smoothstep(0.3, 1.0, m));
    col = lightDither(relight(col, k) * (1.0 - uWipe));
    float a = m * frameFeather(uv) * uOpacity * lightRoomFloor();
    gl_FragColor = vec4(col * a, a);
  }`;

// ---------------- the proxies ----------------

/** One person card's mesh and its own uniforms; `used` when this frame has a card for it. */
interface CardSlot {
  mesh: THREE.Mesh;
  u: Record<string, THREE.IUniform>;
  used: boolean;
}

/** A pair player's splat-depth proxy as camera F sees it. */
interface PlayerDepth {
  texture: THREE.DataTexture;
  box: [number, number, number, number];
  ref: number;
}

export class Proxies {
  /** The projection surfaces and cards, in court space (a child of the world group). */
  readonly group = new THREE.Group();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly bundle: CourtBundle;
  private readonly video: ShowVideo;
  private readonly light: LightField;
  /** Uniforms every footage material shares (the light field's are shared too, by reference). */
  private readonly shared: Record<string, THREE.IUniform>;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly videoPlates: THREE.Mesh[] = [];
  private readonly backgroundPlates: THREE.Mesh[] = [];
  private readonly slots: CardSlot[] = [];
  private readonly depths = new Map<string, PlayerDepth>();
  private readonly pairIds: Set<string>;
  private readonly textures: THREE.Texture[] = [];
  private readonly warned = new Set<string>();
  private depthOverride = 0;
  private loaded = false;
  /** The far image's mesh (surround.far), null without one. */
  private far: THREE.Mesh | null = null;
  /** The bundle has a surround, and it is shown (`surround(on)`, dev: the e2e's before/after). */
  private readonly hasSurround: boolean;
  private surroundOn: boolean;
  /** The footage drawn on the 3D at all (screen.ts: off while the Screen view's cinema screen plays the watch). */
  private footageOn = true;
  /** The show frame last projected (-1 none). */
  private projected = -1;
  private readonly cameraF: PinholeCamera;

  /** Samples `video.regions`; multiplies by `light`. */
  constructor(renderer: THREE.WebGLRenderer, bundle: CourtBundle, video: ShowVideo, light: LightField) {
    this.renderer = renderer;
    this.bundle = bundle;
    this.video = video;
    this.light = light;
    this.group.name = "court-proxies";
    const { court, frames } = bundle;
    // camera F: the camera of every ease's last frame
    const ease = court.video.segments.eases[0];
    this.cameraF = cameraOf(court, frames[ease ? ease.frames[1] : court.video.segments.pass2[0]]);
    this.pairIds = new Set(court.freeze.players.map((p) => p.id));
    const camF = this.cameraF;
    this.shared = {
      uCamR: { value: new THREE.Matrix3() },
      uCamRT: { value: new THREE.Matrix3() },
      uCamC: { value: new THREE.Vector3(...court.camera.centre) },
      uCamK: { value: new THREE.Vector4() },
      uSrc: { value: new THREE.Vector2(court.camera.width, court.camera.height) },
      uCamFR: { value: camRotation(camF) },
      uCamFK: { value: new THREE.Vector4(camF.f, camF.cx, camF.cy, 0) },
      uOpacity: { value: 1 },
      uMask: { value: 1 },
      uFeather: { value: FEATHER },
      uWipe: { value: 0 },
      uDim: { value: 0 },
      uReality: { value: 0 },
      uCinema: { value: CINEMA },
      uDimAlpha: { value: 0 },
    };
    this.hasSurround = !!court.surround;
    this.surroundOn = this.hasSurround && !(import.meta.env?.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("surround") === "off");
    this.applySurround();
    this.setCamera(camF);
    video.listen(() => this.sync());
    this.sync();
    if (import.meta.env?.DEV && typeof window !== "undefined") {
      const w = window as unknown as { __courtLook?: Record<string, unknown> };
      (w.__courtLook ??= {}).proxies = this;
    }
  }

  /** Build the court plane, stands planes, backboard plane, depth cards and person cards; load proxy.glb, stands-mask.png, inpaint-mask.png and the depth cards' images. */
  async load(): Promise<void> {
    const { court } = this.bundle;
    const loader = new THREE.TextureLoader();
    const texture = async (path: string | undefined) => {
      if (!path) return null;
      const t = await loader.loadAsync(this.bundle.file(path));
      t.colorSpace = THREE.NoColorSpace; // masks and alphas, read raw
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      this.textures.push(t);
      return t;
    };
    const [stands, inpaint] = await Promise.all([texture(court.video.standsMask), texture(court.video.inpaintMask)]);
    const masks = { uStands: { value: stands }, uHasStands: { value: !!stands }, uInpaint: { value: inpaint }, uHasInpaint: { value: !!inpaint } };
    const clipList = floorClips(court.freeze.stands.proxy.map((p) => p.points), [0, 0, 0]).slice(0, MAX_CLIPS);
    if (court.freeze.stands.proxy.length > MAX_CLIPS) this.warnOnce(`${court.freeze.stands.proxy.length} stands planes; the floor stops at the first ${MAX_CLIPS}`);
    const pad = <T,>(list: T[], fill: T) => [...list, ...Array.from({ length: MAX_CLIPS - list.length }, () => fill)];
    const clips = {
      uClipPlane: { value: pad(clipList.map((c) => new THREE.Vector4(...c.plane)), new THREE.Vector4()) },
      uClipSpan: { value: pad(clipList.map((c) => new THREE.Vector4(...c.span)), new THREE.Vector4()) },
      uClipY: { value: pad(clipList.map((c) => new THREE.Vector2(...c.y)), new THREE.Vector2()) },
      uClips: { value: clipList.length },
    };
    // the cinema mask's shell, under the video layer's plates (it never writes or tests depth)
    const shellMat = this.material(shellFrag, SHELL_VERT, clips, true);
    shellMat.side = THREE.BackSide;
    const shell = new THREE.Mesh(new THREE.SphereGeometry(SHELL_RADIUS, 32, 16), shellMat);
    shell.name = "proxy-cinema-mask";
    shell.renderOrder = ORDER_VIDEO - 1;
    shell.frustumCulled = false;
    this.videoPlates.push(shell);
    this.group.add(shell);

    // the plates: the frame's background plate on both layers (the 3D's is the same pixels, so the fade is exact)
    const quad = (pts: Vec3[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts.flat(), 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      return g;
    };
    // painter's order within the video layer (it draws without depth, over the 3D): the floor, the stands, the backboard
    const surfaces: { geometry: THREE.BufferGeometry; kind: number; alpha: THREE.Texture | null; order: number }[] = [];
    // the floor, well past the court
    const [fx, fz] = FLOOR_HALF;
    surfaces.push({ geometry: quad([[-fx, 0, fz], [fx, 0, fz], [fx, 0, -fz], [-fx, 0, -fz]]), kind: 0, alpha: null, order: 0 });
    for (const s of court.freeze.stands.proxy) surfaces.push({ geometry: quad(s.points), kind: 1, alpha: null, order: 1 });
    surfaces.push({ geometry: quad(court.court.backboard), kind: 2, alpha: null, order: 2 });
    const cardImages = await Promise.all(court.freeze.stands.cards.map((c) => texture(c.image)));
    court.freeze.stands.cards.forEach((c, i) => surfaces.push({ geometry: quad(c.quad), kind: 1, alpha: cardImages[i], order: 3 }));
    for (const s of surfaces)
      for (const layer of [0, 1]) {
        const m = this.material(plateFrag, PLATE_VERT, {
          ...masks,
          ...clips,
          uTex: { value: this.video.regions.plate },
          uCardAlpha: { value: s.alpha },
          uHasCardAlpha: { value: !!s.alpha },
          uKind: { value: s.kind },
          uLayer: { value: layer },
        }, layer === 0);
        m.polygonOffset = true;
        m.polygonOffsetFactor = -1;
        m.polygonOffsetUnits = -4;
        m.side = THREE.DoubleSide;
        const mesh = new THREE.Mesh(s.geometry, m);
        mesh.name = `proxy-${["floor", "stands", "backboard"][s.kind]}${s.alpha ? "-card" : ""}-${layer === 0 ? "video" : "3d"}`;
        mesh.renderOrder = (layer === 0 ? ORDER_VIDEO : ORDER_BACKGROUND) + s.order;
        mesh.frustumCulled = false;
        (layer === 0 ? this.videoPlates : this.backgroundPlates).push(mesh);
        this.group.add(mesh);
      }

    // the far image (surround.far): one mesh over the floor, the stands planes and the backboard, under the plates
    if (court.surround?.far)
      this.far = await this.farMesh(court.surround.far, clips).catch((e: unknown) => {
        this.warnOnce(`the far image could not be loaded (${(e as Error)?.message ?? e}); the arena goes on without it`);
        return null;
      });

    // the pair's splat-depth proxies, seen from camera F
    const ball = court.freeze.ball;
    await Promise.all(
      court.freeze.players.map(async (p) => {
        const res = await fetch(this.bundle.file(p.proxy));
        if (!res.ok) throw new Error(`${p.proxy}: HTTP ${res.status}`);
        const { positions, indices } = parseGlb(await res.arrayBuffer());
        this.depths.set(p.id, this.playerDepth(positions, indices, ball.erase.some((e) => e.player === p.id) ? ball : undefined));
      }),
    );

    // the card pool: grids laid along camera rays in the vertex shader
    const grid = new THREE.PlaneGeometry(1, 1, ...CARD_GRID);
    const mattes = court.video.regions.mattes;
    for (let i = 0; i < MAX_CARDS; i++) {
      const m = this.material(cardFrag, CARD_VERT, {
        uLive: { value: this.video.regions.live },
        uMattes: { value: this.video.regions.mattes },
        uMattesSize: { value: new THREE.Vector2(mattes[2], mattes[3]) },
        uBox: { value: new THREE.Vector4() },
        uTile: { value: new THREE.Vector4() },
        uAt: { value: new THREE.Vector3() },
        uPair: { value: 0 },
        uPlaneP: { value: new THREE.Vector3() },
        uPlaneN: { value: new THREE.Vector3(1, 0, 0) },
        uDepth: { value: null },
        uHasDepth: { value: false },
        uDepthP: { value: 0 },
        uDepthRef: { value: 0 },
        uDepthBox: { value: new THREE.Vector4() },
      }, true);
      const mesh = new THREE.Mesh(grid, m);
      mesh.name = `proxy-card-${i}`;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.slots.push({ mesh, u: m.uniforms, used: false });
      this.group.add(mesh);
    }
    this.loaded = true;
    this.sync(); // a frame already on the textures (the show's first, decoded during the load) is projected now
  }

  /**
   * Project this display frame. The pixels on the textures are ShowVideo's `onScreen` frame's (a held frame keeps its
   * own camera), so its camera and cards are used; `frame` (the clock's) only before the first upload.
   */
  project(frame: number): void {
    const { court, frames, cards } = this.bundle;
    const onScreen = this.video.stats.onScreen;
    const index = Math.min(frames.length - 1, Math.max(0, onScreen >= 0 ? onScreen : frame));
    this.setCamera(cameraOf(court, frames[index]));
    this.projected = onScreen;
    const list = onScreen >= 0 ? cards[index]?.cards ?? [] : [];
    const fps = court.camera.sourceFps * court.camera.slow;
    const auto = onScreen >= 0 ? depthWeight(frames[index].src, court.video.freezeSource, fps) : 0;
    const n = list.length ? Math.max(...list.map((c) => c.order)) + 1 : 0;
    this.slots.forEach((slot, i) => {
      const c = list[i];
      slot.used = !!c;
      if (!c) return;
      const plane = cardPlane(c.at, court.camera.centre, c.kind);
      (slot.u.uBox.value as THREE.Vector4).set(...c.box);
      (slot.u.uTile.value as THREE.Vector4).set(...c.tile);
      (slot.u.uAt.value as THREE.Vector3).set(...c.at);
      (slot.u.uPlaneP.value as THREE.Vector3).set(...plane.point);
      (slot.u.uPlaneN.value as THREE.Vector3).set(...plane.normal);
      const pair = c.kind === "person" && this.pairIds.has(c.id);
      slot.u.uPair.value = pair ? 1 : 0;
      const depth = pair ? this.depths.get(c.id) : undefined;
      slot.u.uHasDepth.value = !!depth;
      if (depth) {
        slot.u.uDepth.value = depth.texture;
        slot.u.uDepthRef.value = depth.ref;
        (slot.u.uDepthBox.value as THREE.Vector4).set(...depth.box);
        slot.u.uDepthP.value = Math.max(auto, this.depthOverride);
      }
      // back to front: the nearest person last, the ball after everyone
      slot.mesh.renderOrder = ORDER_VIDEO + (c.kind === "ball" ? 40 : 10 + (n - c.order));
    });
    if (list.length > MAX_CARDS) this.warnOnce(`show frame ${index} has ${list.length} cards; ${MAX_CARDS} are drawn`);
    this.updateVisibility();
  }

  /** The courtside plate's dimming as the view leaves the camera ray: 0 = as filmed, 1 = dark (world.ts drives it, P30). */
  dim(p: number): void {
    this.shared.uDim.value = Math.min(1, Math.max(0, p));
  }

  /**
   * Show the bundle's surround or not (dev: `?surround=off` and the e2e's before/after): the far image, the cinema
   * mask's night-game level and the plate's fade off the camera ray (P30). Without a surround in the bundle, nothing.
   */
  surround(on: boolean): void {
    this.surroundOn = this.hasSurround && on;
    this.applySurround();
  }

  private applySurround(): void {
    this.shared.uCinema.value = this.surroundOn ? CINEMA_SURROUND : CINEMA;
    this.shared.uDimAlpha.value = this.surroundOn ? 1 : 0;
    if (this.far) this.far.visible = this.surroundOn && this.footageOn;
  }

  /**
   * The footage on the 3D (the plates on both layers, the cards, the far image) shown or not; the cinema mask's shell
   * stays (it dims the arena). The Screen view hides it while its screen plays the watch (screen.ts).
   */
  footage(on: boolean): void {
    if (on === this.footageOn) return;
    this.footageOn = on;
    this.applySurround();
    this.updateVisibility();
  }

  /** The Reality check: tint the inpainted plate behind the players and the filled holes. */
  reality(on: boolean): void {
    this.shared.uReality.value = on ? 1 : 0;
  }

  /** 0 = each pair player on a flat card at their foot (the watch), 1 = on their splat-depth proxy (as on F). Without a call it follows the show: 1 on F, 0 from DEPTH_TAU_S of real time away. */
  depth(p: number): void {
    this.depthOverride = p;
  }

  /** Free every geometry, material and texture this made (each once: the card grid is shared by the card pool). */
  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>(this.materials);
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      geometries.add(mesh.geometry);
      for (const m of ([] as THREE.Material[]).concat(mesh.material)) materials.add(m);
    });
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    for (const d of this.depths.values()) d.texture.dispose();
    for (const t of this.textures) t.dispose();
    this.group.clear();
  }

  /**
   * The video layer's state (ShowVideo: opacity, mask, wipe) into the shaders and the layers' visibility; a new frame
   * on the textures is projected at once with its own camera and cards, whoever uploaded it.
   */
  private sync(): void {
    this.shared.uOpacity.value = this.video.opacity;
    this.shared.uMask.value = 1 - this.video.maskLevel;
    this.shared.uWipe.value = this.video.wipeLevel;
    if (this.loaded && this.video.stats.onScreen >= 0 && this.video.stats.onScreen !== this.projected) this.project(this.video.stats.onScreen);
    this.updateVisibility();
  }

  private setCamera(cam: PinholeCamera): void {
    (this.shared.uCamR.value as THREE.Matrix3).copy(camRotation(cam));
    (this.shared.uCamRT.value as THREE.Matrix3).copy(this.shared.uCamR.value as THREE.Matrix3).transpose();
    (this.shared.uCamC.value as THREE.Vector3).set(...cam.centre);
    (this.shared.uCamK.value as THREE.Vector4).set(cam.f, cam.cx, cam.cy, 0);
    (this.shared.uSrc.value as THREE.Vector2).set(cam.width, cam.height);
  }

  private updateVisibility(): void {
    if (!this.loaded) return;
    const show = layerVisibility(this.video.opacity, this.video.maskLevel);
    const f = this.footageOn;
    for (const m of this.videoPlates) m.visible = show.plates && (f || m.name === "proxy-cinema-mask");
    for (const s of this.slots) s.mesh.visible = s.used && show.cards && f;
    for (const m of this.backgroundPlates) m.visible = show.background && f;
  }

  private warnOnce(msg: string): void {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    console.warn(`Court Side: ${msg}`);
  }

  /**
   * A footage material. The video layer is a composite over the 3D: it draws without the depth test (the 3D hoop
   * writes depth, and must never cut the picture), in renderOrder; the 3D's plates test depth like the rest of the 3D.
   */
  private material(frag: (light: string) => string, vert: string, own: Record<string, THREE.IUniform>, videoLayer: boolean): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      uniforms: { ...this.shared, ...(this.light.uniforms as Record<string, THREE.IUniform>), ...own },
      vertexShader: vert,
      fragmentShader: frag(lightChunk(this.light.glsl)),
      transparent: true,
      premultipliedAlpha: true,
      depthTest: !videoLayer,
      depthWrite: false,
    });
    this.materials.push(m);
    return m;
  }

  /**
   * The far image's layer: far.jpg with far-alpha.png as its alpha, at most FAR_TEXELS on its long side (mipmapped),
   * on one mesh of the floor quad, the stands planes and the backboard (aKind 0, 1, 2), drawn over the bowl and under
   * the 3D's plates. It blends like the arena (world.ts overRoom): the colour by its alpha, the alpha the larger.
   */
  private async farMesh(far: SurroundFar, clips: Record<string, THREE.IUniform>): Promise<THREE.Mesh> {
    const { court, frames } = this.bundle;
    const loader = new THREE.ImageLoader();
    const [img, alphaImg] = await Promise.all([loader.loadAsync(this.bundle.file(far.image)), loader.loadAsync(this.bundle.file(far.alpha))]);
    const s = Math.min(1, FAR_TEXELS / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * s));
    const h = Math.max(1, Math.round(img.height * s));
    const pixels = (src: HTMLImageElement) => {
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const g = cv.getContext("2d", { willReadFrequently: true })!;
      g.imageSmoothingQuality = "high";
      g.drawImage(src, 0, 0, w, h);
      return g.getImageData(0, 0, w, h).data;
    };
    const data = pixels(img);
    const a = pixels(alphaImg);
    for (let i = 3; i < data.length; i += 4) data[i] = a[i - 3];
    const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.colorSpace = THREE.NoColorSpace; // raw sRGB bytes, as the plates read theirs
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    this.textures.push(texture);
    // the floor, the stands planes and the backboard, one geometry
    const bowl = bowlLayout(court);
    const quads: { pts: readonly Vec3[]; kind: number }[] = [
      { pts: [[bowl.x0, 0, bowl.z1], [bowl.x1, 0, bowl.z1], [bowl.x1, 0, bowl.z0], [bowl.x0, 0, bowl.z0]], kind: 0 },
      ...court.freeze.stands.proxy.map((p) => ({ pts: p.points, kind: 1 })),
      { pts: court.court.backboard, kind: 2 },
    ];
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(quads.flatMap((q) => q.pts.flat()), 3));
    g.setAttribute("aKind", new THREE.Float32BufferAttribute(quads.flatMap((q) => [q.kind, q.kind, q.kind, q.kind]), 1));
    g.setIndex(quads.flatMap((_, i) => [0, 1, 2, 0, 2, 3].map((k) => 4 * i + k)));
    const cam = farCamera(court, frames, far);
    const m = new THREE.ShaderMaterial({
      uniforms: {
        ...this.shared,
        ...(this.light.uniforms as Record<string, THREE.IUniform>),
        ...clips,
        uFar: { value: texture },
        uFarR: { value: camRotation(cam) },
        uFarK: { value: new THREE.Vector4(cam.f, cam.cx, cam.cy, 0) },
        uFarSize: { value: new THREE.Vector2(cam.width, cam.height) },
        uBowl: { value: new THREE.Vector4(bowl.x0, bowl.x1, bowl.z0, bowl.z1) },
        uBowlR: { value: bowl.r },
      },
      vertexShader: FAR_VERT,
      fragmentShader: farFrag(lightChunk(this.light.glsl)),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.MaxEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -4;
    m.forceSinglePass = true; // one pass in index order (floor, stands, backboard), not three's back-then-front pair
    this.materials.push(m);
    const mesh = new THREE.Mesh(g, m);
    mesh.name = "proxy-far";
    mesh.renderOrder = ORDER_BACKGROUND - 2;
    mesh.frustumCulled = false;
    mesh.visible = this.surroundOn && this.footageOn;
    this.group.add(mesh);
    return mesh;
  }

  /** Rasterise a player's proxy from camera F into a dilated depth texture (distance along each ray, as an offset from its median). */
  private playerDepth(positions: Float32Array, indices: Uint32Array, ball?: { centre: Vec3; radius: number }): PlayerDepth {
    const cam = this.cameraF;
    const box = depthBox(cam, positions, 0.08);
    const aspect = (box[2] - box[0]) / (box[3] - box[1]);
    const w = Math.max(8, Math.round(aspect >= 1 ? DEPTH_TEXELS : DEPTH_TEXELS * aspect));
    const h = Math.max(8, Math.round(aspect >= 1 ? DEPTH_TEXELS / aspect : DEPTH_TEXELS));
    const raw = rasterDepth(positions, indices, cam, box, w, h, ball);
    const { depth, valid } = dilateDepth(raw, w, h, DEPTH_BAND);
    const hits = Array.from(raw).filter((v) => v > 0).sort((a, b) => a - b);
    const ref = hits.length ? hits[hits.length >> 1] : 0;
    const data = new Uint16Array(w * h * 2);
    for (let k = 0; k < w * h; k++) {
      data[2 * k] = THREE.DataUtils.toHalfFloat(valid[k] > 0 ? depth[k] - ref : 0);
      data[2 * k + 1] = THREE.DataUtils.toHalfFloat(valid[k]);
    }
    const texture = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.HalfFloatType);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true; // rows run from the top: texture t = row / h, sampled with the box's top-left coordinates
    return { texture, box, ref };
  }
}

/** Camera-from-court rotation as a three Matrix3 (the shaders' uCamR). */
function camRotation(cam: PinholeCamera): THREE.Matrix3 {
  const inv = conjugate(cam.q);
  const x = rotate(inv, [1, 0, 0]);
  const y = rotate(inv, [0, 1, 0]);
  const z = rotate(inv, [0, 0, 1]);
  // columns are the images of the court axes
  return new THREE.Matrix3().set(x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]);
}
