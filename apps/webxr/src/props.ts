import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { type Dream, dreamUrl } from "./dream";

// The important objects around the person (AGENTS.md, "Props"): the real ball moving exactly as it did in the clip,
// a regulation hoop in your room. Same space as the person: meters, +Y up, floor at y = 0, their front faces -Z.
// Everything is built here from code, real size: nothing to download.

type Vec3 = [number, number, number];
export interface BallProp {
  kind: "basketball";
  radius?: number;
  track: (Vec3 | null)[]; // one entry per bundle frame, null where the ball isn't known
}
export interface HoopProp {
  kind: "hoop";
  rim: Vec3; // centre of the ring, y = rim height (3.05 regulation)
  facing?: Vec3; // unit direction from the rim toward the shooter; the backboard sits behind the rim, away from them
}
export interface PropsFile {
  fps?: number;
  objects: { kind: string }[];
}

// Regulation (FIBA / NBA): ring 0.457 m inside, its inner edge 0.151 m from the board; board 1.83 x 1.07 m with its
// bottom edge 0.15 m under the ring; the shooter's square 0.59 x 0.45 m, its base line level with the ring; 5 cm lines.
const RIM_R = 0.457 / 2;
const RIM_TUBE = 0.008;
const BOARD_GAP = 0.151;
const BOARD_W = 1.83;
const BOARD_H = 1.07;
const BOARD_T = 0.025;
const BOARD_BELOW_RIM = 0.15;
const SQUARE_W = 0.59;
const SQUARE_H = 0.45;
const LINE = 0.05;
const NET_LEN = 0.4;
/** The hoop's regulation sizes, for anything that plays with it (a ball you shoot: basketball.ts). */
export const HOOP = { RIM_R, RIM_TUBE, BOARD_GAP, BOARD_W, BOARD_H, BOARD_T, BOARD_BELOW_RIM, NET_LEN };
const FADE_S = 0.18; // the ball fades in and out over this long instead of popping
const BACKSPIN = 0.35; // spin as a fraction of rolling speed, turned backwards the way a shot leaves the fingers

const finite3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => Number.isFinite(x));

/** props.json for this dream, built; null when the bundle has none (or nothing in it we know how to show). */
export async function loadProps(dream: Dream, renderer: THREE.WebGLRenderer): Promise<Props | null> {
  if (!dream.props) return null;
  const r = await fetch(dreamUrl(dream.id, dream.props), { cache: "no-cache" }).catch(() => null);
  if (!r?.ok) return null;
  const file = (await r.json().catch(() => null)) as PropsFile | null;
  if (!file || !Array.isArray(file.objects)) return null;
  const props = new Props(file, file.fps && file.fps > 0 ? file.fps : dream.fps, renderer);
  return props.empty ? null : props;
}

export class Props {
  readonly group = new THREE.Group();
  /** Ring centres in the person's space, for framing the desktop view. */
  readonly hoops: THREE.Vector3[] = [];
  /** The hoops themselves (local frame: floor under the ring, +Z toward the shooter; userData.rimTop = ring height). */
  readonly hoopGroups: THREE.Group[] = [];
  private balls: Ball[] = [];
  private fader = new Fader();
  private reveal = -1;

  constructor(file: PropsFile, fps: number, renderer: THREE.WebGLRenderer) {
    const known = file.objects.filter((o) => (o?.kind === "basketball" && Array.isArray((o as BallProp).track)) || (o?.kind === "hoop" && finite3((o as HoopProp).rim)));
    if (!known.length) return;
    // a soft studio light of its own: the splats carry their own light, only these solid objects need it
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    const sky = new THREE.HemisphereLight(0xffffff, 0x8a8178, 0.6);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1.2, 4.5, -2.5);
    key.target.position.set(0, 1, 0);
    this.group.add(sky, key, key.target);
    const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    for (const o of known) {
      if (o.kind === "basketball") {
        const ball = new Ball(o as BallProp, fps, env, anisotropy);
        this.balls.push(ball);
        this.group.add(ball.mesh, ball.shadow);
      } else {
        const h = o as HoopProp;
        const hoop = buildHoop(h, env, this.fader);
        this.group.add(hoop);
        this.hoopGroups.push(hoop);
        this.hoops.push(new THREE.Vector3(h.rim[0], h.rim[1], h.rim[2]));
      }
    }
  }

  get empty(): boolean {
    return this.balls.length === 0 && this.hoops.length === 0;
  }

  /** t: the same clip time the person is posed at; reveal: the person's materialise fade, 0 -> 1. */
  update(t: number, dt: number, reveal: number) {
    if (reveal !== this.reveal) this.fader.set((this.reveal = reveal));
    for (const b of this.balls) b.update(t, dt, reveal);
  }
}

/** Fades a set of materials together; opaque ones go transparent only while they're fading. */
class Fader {
  private items: { m: THREE.Material; base: number; transparent: boolean }[] = [];
  add<M extends THREE.Material>(m: M): M {
    this.items.push({ m, base: m.opacity, transparent: m.transparent });
    return m;
  }
  set(k: number) {
    for (const it of this.items) {
      const transparent = it.transparent || k < 1;
      if (it.m.transparent !== transparent) {
        it.m.transparent = transparent;
        it.m.needsUpdate = true;
      }
      it.m.opacity = it.base * k;
    }
  }
}

// ---------------- the ball ----------------

class Ball {
  readonly mesh: THREE.Mesh;
  readonly shadow: THREE.Mesh;
  private pts: (THREE.Vector3 | null)[];
  private r: number;
  private fader = new Fader();
  private alpha = 0;
  private prevT = NaN;
  private known = false;
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private last = new THREE.Vector3();
  private lastVel = new THREE.Vector3();
  private lastT = 0;
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private ends = [new THREE.Vector3(), new THREE.Vector3()];
  private axis = new THREE.Vector3();
  private spin = new THREE.Quaternion();

  constructor(p: BallProp, private fps: number, env: THREE.Texture, anisotropy: number) {
    this.r = Number.isFinite(p.radius) && p.radius! > 0 ? p.radius! : 0.12;
    this.pts = p.track.map((v) => (finite3(v) ? new THREE.Vector3(v[0], v[1], v[2]) : null));
    const { map, bump } = basketballTextures(this.r);
    map.anisotropy = bump.anisotropy = anisotropy;
    const mat = new THREE.MeshPhysicalMaterial({
      map,
      bumpMap: bump,
      bumpScale: 1.6,
      roughness: 0.66,
      metalness: 0,
      clearcoat: 0.12,
      clearcoatRoughness: 0.5,
      envMap: env,
      envMapIntensity: 0.7,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(this.r, 64, 40), this.fader.add(mat));
    this.mesh.quaternion.setFromEuler(new THREE.Euler(0.35, 0.6, 0.2)); // seams at a natural angle, not square on
    this.mesh.visible = false;
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, opacity: 0, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = -1;
    this.shadow.visible = false;
  }

  /** Where the ball is at clip time t, smoothly between frames (centripetal Catmull-Rom). False where it isn't known. */
  private sample(t: number, out: THREE.Vector3): boolean {
    const n = this.pts.length;
    const f = t * this.fps;
    if (!(f >= 0) || f > n) return false;
    const i = Math.min(Math.floor(f), n - 1);
    const u = i === n - 1 ? 0 : f - i;
    const p1 = this.pts[i];
    if (!p1) return false;
    if (u === 0) {
      out.copy(p1);
      return true;
    }
    const p2 = this.pts[i + 1];
    if (!p2) return false;
    // past either end of a known stretch, mirror the neighbour so the curve carries straight on
    const p0 = this.pts[i - 1] ?? this.ends[0].copy(p1).multiplyScalar(2).sub(p2);
    const p3 = this.pts[i + 2] ?? this.ends[1].copy(p2).multiplyScalar(2).sub(p1);
    catmullRom(p0, p1, p2, p3, u, out);
    // a bounce between two frames: the smooth curve would turn round in mid-air above the floor. Follow the way in
    // and the way out as straight lines instead; they meet at (or under, clamped to) the floor.
    const before = this.pts[i - 1], after = this.pts[i + 2];
    if (before && after) {
      const down = p1.y - before.y, up = after.y - p2.y;
      if (down < 0 && up > 0 && Math.min(p1.y, p2.y) < this.r + 0.3) out.y = Math.max(p1.y + down * u, p2.y - up * (1 - u));
    }
    return true;
  }

  update(t: number, dt: number, reveal: number) {
    const h = 0.5 / this.fps;
    const wasKnown = this.known;
    this.known = this.sample(t, this.pos);
    if (this.known) {
      // a jump (the clip looping, a scrub) fades in at the new place rather than flying across the room
      if (wasKnown && this.pos.distanceTo(this.last) > 0.8) this.alpha = 0;
      const ahead = this.sample(t + h, this.a);
      const behind = this.sample(t - h, this.b);
      if (ahead && behind) this.vel.subVectors(this.a, this.b).divideScalar(2 * h);
      else if (ahead) this.vel.subVectors(this.a, this.pos).divideScalar(h);
      else if (behind) this.vel.subVectors(this.pos, this.b).divideScalar(h);
      else this.vel.set(0, 0, 0);
      this.last.copy(this.pos);
      this.lastVel.copy(this.vel);
      this.lastT = t;
    } else {
      // lost: it keeps going the way it was going while it fades out
      const since = THREE.MathUtils.clamp(t - this.lastT, 0, 0.3);
      this.pos.copy(this.last).addScaledVector(this.lastVel, since);
      this.vel.copy(this.lastVel);
    }
    this.pos.y = Math.max(this.pos.y, this.r); // never through the floor
    this.alpha = THREE.MathUtils.clamp(this.alpha + (this.known ? dt : -dt) / FADE_S, 0, 1);

    // backspin about (velocity x up), proportional to how fast it travels; follows clip time, so it slows with playback
    const dtc = t - this.prevT;
    this.prevT = t;
    if (Number.isFinite(dtc) && Math.abs(dtc) < 0.25 && dtc !== 0) {
      this.axis.set(-this.vel.z, 0, this.vel.x); // velocity x up: the top of the ball turns back toward the shooter
      const speed = this.axis.length();
      if (speed > 1e-4) {
        this.spin.setFromAxisAngle(this.axis.divideScalar(speed), ((speed * BACKSPIN) / this.r) * dtc);
        this.mesh.quaternion.premultiply(this.spin);
      }
    }

    const k = this.alpha * reveal;
    this.mesh.position.copy(this.pos);
    this.mesh.visible = k > 0.002;
    this.fader.set(k);
    // a soft contact shadow, wider and fainter the higher it is
    const above = this.pos.y - this.r;
    const m = this.shadow.material as THREE.MeshBasicMaterial;
    m.opacity = k * 0.75 * Math.max(0, 1 - above / 2.5);
    this.shadow.visible = m.opacity > 0.002;
    this.shadow.position.set(this.pos.x, 0.003, this.pos.z);
    this.shadow.scale.setScalar(this.r * 3.2 * (1 + above * 0.5));
  }
}

/** Centripetal Catmull-Rom between p1 and p2 (u in 0..1): no overshoot or loops when samples bunch up at a bounce. */
function catmullRom(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, u: number, out: THREE.Vector3) {
  let d0 = Math.pow(p0.distanceToSquared(p1), 0.25);
  let d1 = Math.pow(p1.distanceToSquared(p2), 0.25);
  let d2 = Math.pow(p2.distanceToSquared(p3), 0.25);
  if (d1 < 1e-4) d1 = 1;
  if (d0 < 1e-4) d0 = d1;
  if (d2 < 1e-4) d2 = d1;
  const u2 = u * u;
  const u3 = u2 * u;
  for (const c of ["x", "y", "z"] as const) {
    const x0 = p0[c], x1 = p1[c], x2 = p2[c], x3 = p3[c];
    const t1 = ((x1 - x0) / d0 - (x2 - x0) / (d0 + d1) + (x2 - x1) / d1) * d1;
    const t2 = ((x2 - x1) / d1 - (x3 - x1) / (d1 + d2) + (x3 - x2) / d2) * d1;
    out[c] = x1 + t1 * u + (-3 * x1 + 3 * x2 - 2 * t1 - t2) * u2 + (2 * x1 - 2 * x2 + t1 + t2) * u3;
  }
}

/**
 * The ball's skin as an equirectangular map: pebbled orange-brown composite with the classic 8-panel seams (two
 * great circles at right angles, and two curved seams: circles around the points where the first crosses 90 degrees
 * from the second, which splits each of the 4 lunes in two). Plus a bump map: pebbles up, seams sunk in as channels.
 */
export function basketballTextures(r: number): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const W = 1024, H = 512;
  const mk = () => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d")!;
    return { c, ctx, img: ctx.createImageData(W, H) };
  };
  const col = mk();
  const bmp = mk();
  const curve = Math.acos(0.5); // the curved seams' angular radius: 60 degrees gives all 8 panels the same area
  const half = 0.0032 / r; // half the seam channel (6.4 mm wide), in radians on the ball
  const pebbles = r / 0.0026; // about one pebble every 2.6 mm
  const smooth = (e0: number, e1: number, x: number) => {
    const k = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
    return k * k * (3 - 2 * k);
  };
  for (let y = 0; y < H; y++) {
    const th = (Math.PI * (y + 0.5)) / H;
    const st = Math.sin(th), py = Math.cos(th);
    for (let x = 0; x < W; x++) {
      const ph = (2 * Math.PI * (x + 0.5)) / W;
      // the same point SphereGeometry puts at this uv
      const px = -Math.cos(ph) * st, pz = Math.sin(ph) * st;
      const ax = Math.min(1, Math.abs(px));
      const d = Math.min(Math.asin(Math.min(1, Math.abs(py))), Math.asin(ax), Math.abs(Math.acos(ax) - curve));
      const seam = 1 - smooth(half * 0.75, half * 1.2, d);
      const groove = 1 - smooth(half * 0.9, half * 2.1, d); // the panel edge rolls down into the channel
      const n = valueNoise(px * pebbles, py * pebbles, pz * pebbles);
      const pebble = smooth(0.3, 0.75, n);
      const shade = 0.9 + 0.1 * pebble - 0.12 * groove;
      const o = (y * W + x) * 4;
      col.img.data[o] = (196 * shade) * (1 - seam) + 24 * seam;
      col.img.data[o + 1] = (88 * shade) * (1 - seam) + 19 * seam;
      col.img.data[o + 2] = (38 * shade) * (1 - seam) + 16 * seam;
      col.img.data[o + 3] = 255;
      const v = 255 * ((0.62 + 0.38 * pebble) * (1 - groove) + 0.1 * groove);
      bmp.img.data[o] = bmp.img.data[o + 1] = bmp.img.data[o + 2] = v;
      bmp.img.data[o + 3] = 255;
    }
  }
  col.ctx.putImageData(col.img, 0, 0);
  bmp.ctx.putImageData(bmp.img, 0, 0);
  const map = new THREE.CanvasTexture(col.c);
  map.colorSpace = THREE.SRGBColorSpace;
  return { map, bump: new THREE.CanvasTexture(bmp.c) };
}

function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** 3D value noise in 0..1 (sampled on the sphere itself, so pebbles don't stretch toward the map's poles). */
function valueNoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const f = (v: number) => v * v * (3 - 2 * v);
  const u = f(x - xi), v = f(y - yi), w = f(z - zi);
  const l = (a: number, b: number, k: number) => a + (b - a) * k;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

let shadowTex: THREE.CanvasTexture | null = null;
/** The same soft radial falloff as the person's contact shadow. */
export function shadowTexture(): THREE.CanvasTexture {
  if (shadowTex) return shadowTex;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(0,0,0,0.42)");
  g.addColorStop(0.45, "rgba(0,0,0,0.18)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return (shadowTex = new THREE.CanvasTexture(canvas));
}

// ---------------- the hoop ----------------

/**
 * A regulation hoop. Local frame: origin on the floor under the ring's centre, +Z toward the shooter. The ring, a
 * diamond-mesh net, a glass board with its white border and shooter's square, and a dark pole on a base behind it.
 */
function buildHoop(h: HoopProp, env: THREE.Texture, fader: Fader): THREE.Group {
  const g = new THREE.Group();
  const top = h.rim[1]; // the top of the ring
  g.userData.rimTop = top;
  const ringY = top - RIM_TUBE;
  const face = -(RIM_R + BOARD_GAP); // the board's front face
  const back = face - BOARD_T;
  g.position.set(h.rim[0], 0, h.rim[2]);
  const f = finite3(h.facing) ? new THREE.Vector3(h.facing[0], 0, h.facing[2]) : new THREE.Vector3(0, 0, 1);
  if (f.lengthSq() < 1e-8) f.set(0, 0, 1);
  g.rotation.y = Math.atan2(f.x, f.z); // local +Z turned to face the shooter

  const orange = fader.add(new THREE.MeshStandardMaterial({ color: 0xd4501c, metalness: 0.5, roughness: 0.38, envMap: env, envMapIntensity: 0.8 }));
  const steel = fader.add(new THREE.MeshStandardMaterial({ color: 0x1d1e21, metalness: 0.35, roughness: 0.5, envMap: env, envMapIntensity: 0.3 }));
  const base = fader.add(new THREE.MeshStandardMaterial({ color: 0x161618, metalness: 0.05, roughness: 0.85, envMap: env, envMapIntensity: 0.25 }));
  const paint = fader.add(new THREE.MeshStandardMaterial({ color: 0xf5f5f3, roughness: 0.55, side: THREE.DoubleSide, envMap: env, envMapIntensity: 0.6 }));
  const glass = fader.add(
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.09, depthWrite: false, envMap: env, envMapIntensity: 1.2 }),
  );
  const edge = fader.add(new THREE.MeshStandardMaterial({ color: 0x9cc7bd, roughness: 0.15, transparent: true, opacity: 0.55, depthWrite: false, envMap: env }));
  const cordMat = fader.add(new THREE.MeshStandardMaterial({ color: 0xf7f7f5, roughness: 0.9, transparent: true, opacity: 0.9, envMap: env, envMapIntensity: 0.5 }));
  const box = (w: number, hgt: number, d: number, m: THREE.Material | THREE.Material[], x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d), m);
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };

  // the ring, its bracket back to the board, and the mounting plate
  const ring = new THREE.Mesh(new THREE.TorusGeometry(RIM_R + RIM_TUBE, RIM_TUBE, 12, 96), orange);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = ringY;
  g.add(ring);
  const reach = BOARD_GAP - RIM_TUBE;
  box(0.1, 0.018, reach, orange, 0, ringY, -(RIM_R + RIM_TUBE) - reach / 2);
  box(0.02, 0.07, 0.09, orange, 0, ringY - 0.04, face + 0.045);
  box(0.18, 0.12, 0.012, orange, 0, ringY - 0.03, face + 0.006);

  // the net: a tapered tube of thin cords knotted into diamonds, 12 loops on the ring
  const N = 12, ROWS = 6;
  const r0 = RIM_R + RIM_TUBE * 0.5, r1 = 0.135;
  const at = (j: number, k: number) => {
    const s = j / ROWS;
    const rad = r0 + (r1 - r0) * (1 - Math.pow(1 - s, 1.8)); // narrows quickly under the ring, then hangs straight
    const a = (2 * Math.PI * (k + (j % 2) * 0.5)) / N;
    return new THREE.Vector3(Math.cos(a) * rad, ringY - RIM_TUBE - s * NET_LEN, Math.sin(a) * rad);
  };
  const cords: THREE.BufferGeometry[] = [];
  for (let j = 0; j < ROWS; j++)
    for (let k = 0; k < N; k++) {
      const p = at(j, k);
      const side = j % 2 ? k + 1 : k - 1;
      cords.push(cord(p, at(j + 1, k)), cord(p, at(j + 1, (side + N) % N)));
    }
  g.add(new THREE.Mesh(mergeGeometries(cords), cordMat));
  cords.forEach((c) => c.dispose());

  // the glass: faces see-through, edges a touch green like real tempered glass
  const boardY = top - BOARD_BELOW_RIM + BOARD_H / 2;
  box(BOARD_W, BOARD_H, BOARD_T, [edge, edge, edge, edge, glass, glass], 0, boardY, face - BOARD_T / 2);
  const frame = (w: number, hgt: number, cy: number) => {
    const s = new THREE.Shape();
    s.moveTo(-w / 2, -hgt / 2).lineTo(w / 2, -hgt / 2).lineTo(w / 2, hgt / 2).lineTo(-w / 2, hgt / 2).closePath();
    const hole = new THREE.Path();
    const iw = w / 2 - LINE, ih = hgt / 2 - LINE;
    hole.moveTo(-iw, -ih).lineTo(-iw, ih).lineTo(iw, ih).lineTo(iw, -ih).closePath();
    s.holes.push(hole);
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(s), paint);
    mesh.position.set(0, cy, face + 0.0015);
    g.add(mesh);
  };
  frame(BOARD_W, BOARD_H, boardY); // the border
  frame(SQUARE_W, SQUARE_H, top - LINE + SQUARE_H / 2); // the shooter's square, base line level with the ring

  // behind the glass: the support frame, two parallel arms back to the pole, the pole, its base
  const frameY = boardY - 0.08;
  box(0.9, 0.05, 0.05, steel, 0, frameY - 0.28, back - 0.03);
  box(0.9, 0.05, 0.05, steel, 0, frameY + 0.28, back - 0.03);
  box(0.05, 0.61, 0.05, steel, -0.42, frameY, back - 0.03);
  box(0.05, 0.61, 0.05, steel, 0.42, frameY, back - 0.03);
  const poleZ = back - 1.0;
  const armLen = back - 0.055 - poleZ;
  for (const y of [frameY - 0.2, frameY + 0.2]) box(0.06, 0.06, armLen, steel, 0, y, poleZ + armLen / 2);
  const poleTop = frameY + 0.32;
  box(0.14, poleTop, 0.14, steel, 0, poleTop / 2, poleZ);
  box(0.7, 0.14, 1.0, base, 0, 0.07, poleZ - 0.12);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.6), fader.add(new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, opacity: 0.9, depthWrite: false })));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.002, poleZ - 0.12);
  shadow.renderOrder = -1;
  g.add(shadow);
  return g;
}

/** A regulation hoop on its own (a basketball dream without one): ring at 3.05 m over the origin, facing +Z. */
export function standaloneHoop(renderer: THREE.WebGLRenderer): THREE.Group {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return buildHoop({ kind: "hoop", rim: [0, 3.05, 0], facing: [0, 0, 1] }, env, new Fader());
}

/** One cord of the net: a thin open cylinder from a to b. */
function cord(a: THREE.Vector3, b: THREE.Vector3, radius = 0.0028): THREE.BufferGeometry {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(radius, radius, len, 5, 1, true);
  geo.translate(0, len / 2, 0);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.divideScalar(len)));
  geo.translate(a.x, a.y, a.z);
  return geo;
}
