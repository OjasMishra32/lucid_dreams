import * as THREE from "three";
import { roomEnvironment } from "./xr/env";
import type { Dream } from "./dream";
import type { Experience } from "./experience";
import { liveJoints } from "./xr/hands";
import { handIndex } from "./xr/menu";

// A real 7-iron in your own hands, to copy a golf swing in your room, and a ball on a tee to hit with it. Built from
// code at real size (a men's steel 7-iron): 37 in long, a 27 cm black rubber grip, a tapered chrome shaft, a brushed
// steel blade at 34 degrees of loft and a 62.5 degree lie. It follows your hand joints (WebXR: -Z along each bone
// toward the fingertip, -Y out of the palm): both hands together on the grip and the shaft runs from the top hand
// through the lower one, one hand and it lies diagonally across that hand's fingers. No gesture does anything: close
// a hand round the grip and it's there, open your hands (or turn the left palm up for the menu) and it's put away.

const deg = THREE.MathUtils.degToRad;
export const CLUB = {
  length: 37 * 0.0254, // butt to where the shaft line meets the ground, along the shaft
  grip: 0.27,
  loft: deg(34),
  lie: deg(62.5),
  blade: 0.075, // heel to toe
};
const BALL_R = 0.04267 / 2; // a regulation ball, 1.68 in
const TEE_TOP = 0.012; // the cup sits 12 mm off the floor: a low tee, the way an iron is teed up
const BALL_TEED = TEE_TOP + BALL_R - 0.0015;
const TOP_HAND = 0.05; // the top hand's centre sits this far below the butt end
const LOW_HAND = 0.14; // and the lower hand's this far
const MAX_BALL_SPEED = 30; // m/s, about 67 mph: a real 7-iron launches near 50 m/s, a room doesn't need that
// hand tracking is never as precise as a real grip, so the club helps: it fits your height, stops at your floor, the ball
// comes to it, and a hit only needs the head to pass near the ball
const FIT = { min: 0.85, max: 1.3 }; // the club's length, fitted at address so its head just meets your floor
const HIT = { across: 0.1, up: 0.14, speed: 1.0 }; // how near the head must pass (m, sideways and up/down), how fast (m/s)
const LAUNCH = THREE.MathUtils.degToRad(22); // a 7-iron's launch angle
const ASSIST = 0.5; // how much the ball's line leans from your swing toward the target line
const OFFSET = 0.003; // the leading edge sits a little behind the shaft line, an iron's offset
const HEEL_X = 0.012; // head frame: the shaft line meets the ground at x = 0, the heel end of the blade is here

/** The dream is a golf lesson (or ?club=1): you get a club to swing along with them. ?club=0 turns it off. */
export function wantsClub(dream: Dream, experience: Experience | null, search = location.search): boolean {
  const q = new URLSearchParams(search).get("club");
  if (q !== null) return q !== "0" && q !== "false";
  const objects = (experience as { objects?: unknown } | null)?.objects;
  const text = [dream.intent, dream.name, experience?.intent, experience?.title, objects ? JSON.stringify(objects) : ""].join(" ");
  return /golf|club|swing/i.test(text);
}

// ---------------------------------------------------------------- the club, built from code

/**
 * The blade, lofted along the heel-to-toe line: one cross-section (in the head frame's z-y plane) per station, each
 * polygon side its own strip so the edges stay crisp (leading edge, top line) while the length stays smooth. Head
 * frame: x toward the heel (the golfer), y up at address, z toward the target (the face looks along +z, tilted up by
 * the loft). The face strip is material group 1.
 */
function bladeGeometry(): THREE.BufferGeometry {
  const t = Math.tan(CLUB.loft);
  const N = 30;
  const rings: [number, number][][] = []; // [y, z] per point
  const xs: number[] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    // the face outline: low at the heel, the top line rising toward the toe, then a round toe
    let h = 0.025 + 0.019 * Math.pow(u, 0.9);
    let w = 0.024; // sole, leading to trailing edge
    let lift = 0; // the sole curves up into the toe
    if (u < 0.1) {
      const k = 1 - u / 0.1;
      h -= 0.004 * k * k;
      w -= 0.007 * k * k;
    }
    if (u > 0.76) {
      const k = (u - 0.76) / 0.24;
      h = 0.006 + (h - 0.006) * Math.sqrt(Math.max(0, 1 - k * k));
      lift = 0.004 * k * k;
    }
    if (u > 0.84) {
      const k = (u - 0.84) / 0.16;
      w = 0.006 + (w - 0.006) * Math.sqrt(Math.max(0, 1 - k * k));
    }
    const zl = -OFFSET;
    const zf = (y: number) => zl - (y - 0.0015) * t; // the face plane
    const top = Math.max(h, lift + 0.0045);
    rings.push([
      [0.0015 + lift, zf(0.0015 + lift)], // leading edge
      [top, zf(top)], // top of the face
      [top - 0.0012, zf(top) - 0.0062], // the top line, about 6 mm thick
      [lift + (top - lift) * 0.5, zf(lift + (top - lift) * 0.5) - 0.0075], // back of the thin upper blade
      [lift + (top - lift) * 0.3, zl - w + 0.004], // the muscle low behind the sweet spot
      [lift + 0.004, zl - w], // trailing edge of the sole
      [lift, zl - w * 0.45], // the cambered sole
    ]);
    xs.push(HEEL_X - CLUB.blade * u);
  }
  const K = rings[0].length;
  const pos: number[] = [];
  const index: number[] = [];
  const g = new THREE.BufferGeometry();
  for (let k = 0; k < K; k++) {
    const first = pos.length / 3;
    const start = index.length;
    for (let i = 0; i <= N; i++)
      for (const kk of [k, (k + 1) % K]) {
        const [y, z] = rings[i][kk];
        pos.push(xs[i], y, z);
      }
    for (let i = 0; i < N; i++) {
      const a = first + i * 2, b = a + 1, c = a + 3, d = a + 2;
      index.push(a, b, c, a, c, d);
    }
    g.addGroup(start, index.length - start, k === 0 ? 1 : 0);
  }
  // end caps (heel faces +x, toe faces -x), triangulated as drawn and turned outward
  const capStart = index.length;
  for (const [i, out] of [[0, 1], [N, -1]] as const) {
    const first = pos.length / 3;
    const contour = rings[i].map(([y, z]) => new THREE.Vector2(z, y));
    rings[i].forEach(([y, z]) => pos.push(xs[i], y, z));
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
      const [ya, za] = rings[i][a], [yb, zb] = rings[i][b], [yc, zc] = rings[i][c];
      const nx = (yb - ya) * (zc - za) - (zb - za) * (yc - ya); // x of (B - A) x (C - A)
      if (nx * out >= 0) index.push(first + a, first + b, first + c);
      else index.push(first + a, first + c, first + b);
    }
  }
  g.addGroup(capStart, index.length - capStart, 0);
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** A lathe (profile [r, y] from bottom to top) with its texture's v running by height, so a pattern isn't stretched. */
function lathe(profile: [number, number][], segments: number): THREE.LatheGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);
  const y0 = profile[0][1], y1 = profile[profile.length - 1][1];
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let k = 0; k < p.count; k++) uv.setY(k, (p.getY(k) - y0) / (y1 - y0));
  return g;
}

function gripTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  x.fillStyle = "#141414";
  x.fillRect(0, 0, 128, 128);
  // the moulded diamond pattern of a rubber grip
  x.strokeStyle = "#232323";
  x.lineWidth = 6;
  for (let k = -128; k <= 256; k += 32) {
    x.beginPath();
    x.moveTo(k, 0);
    x.lineTo(k + 128, 128);
    x.moveTo(k + 128, 0);
    x.lineTo(k, 128);
    x.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 52);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function dimpleTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const x = c.getContext("2d")!;
  x.fillStyle = "#fff";
  x.fillRect(0, 0, 512, 256);
  const rows = 22, cols = 44;
  for (let r = 0; r <= rows; r++)
    for (let k = 0; k < cols; k++) {
      const cx = ((k + (r % 2) * 0.5) / cols) * 512;
      const cy = (r / rows) * 256;
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, 5);
      g.addColorStop(0, "#9a9a9a");
      g.addColorStop(1, "#fff");
      x.fillStyle = g;
      x.beginPath();
      x.arc(cx, cy, 5, 0, Math.PI * 2);
      x.fill();
    }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

function softShadow(size: number, alpha: number): THREE.Mesh {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, `rgba(0,0,0,${alpha})`);
  g.addColorStop(0.5, `rgba(0,0,0,${alpha * 0.4})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.001;
  m.renderOrder = -1;
  return m;
}

/** The club in its own frame: butt end at the origin, the shaft down -Y, the square face looking along +Z. */
function buildClub(env: THREE.Texture, fade: THREE.Material[]) {
  const mat = <T extends THREE.Material>(m: T) => {
    m.transparent = true;
    fade.push(m);
    return m;
  };
  const L = CLUB.length;
  const club = new THREE.Group();
  const rubber = mat(new THREE.MeshStandardMaterial({ color: 0xffffff, map: gripTexture(), roughness: 0.88, metalness: 0, envMap: env, envMapIntensity: 0.35 }));
  const chrome = mat(new THREE.MeshStandardMaterial({ color: 0xe4e6ea, roughness: 0.12, metalness: 1, envMap: env, envMapIntensity: 1.15 }));
  const steel = mat(new THREE.MeshStandardMaterial({ color: 0xc3c6cb, roughness: 0.34, metalness: 1, envMap: env, envMapIntensity: 1.05 }));
  const face = mat(new THREE.MeshStandardMaterial({ color: 0xb4b7bc, roughness: 0.5, metalness: 1, envMap: env, envMapIntensity: 0.9 }));
  const groove = mat(new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.65, metalness: 0.6, envMap: env, envMapIntensity: 0.4 }));
  const black = mat(new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.3, metalness: 0, envMap: env, envMapIntensity: 0.6 }));

  // grip: 27 cm, 11 mm radius at the butt tapering to 9, a lip at the bottom, a rounded cap on top
  const G = CLUB.grip;
  const gripProfile: [number, number][] = [[0.0074, -G], [0.0094, -G + 0.002], [0.0096, -G + 0.008], [0.0091, -G + 0.015]];
  for (let k = 1; k <= 24; k++) {
    const s = k / 24;
    gripProfile.push([0.0091 + (0.0111 - 0.0091) * s, -G + 0.015 + (G - 0.027) * s]);
  }
  gripProfile.push([0.0113, -0.006], [0.0108, -0.002], [0.0085, 0], [0.0001, 0.0004]);
  club.add(new THREE.Mesh(lathe(gripProfile, 32), rubber));

  // shaft: chrome steel, 7.5 mm radius under the grip down to 4.5 mm at the tip, with the step-downs of a steel shaft
  const tipY = -L + 0.078;
  const shaft: [number, number][] = [[0.0045, tipY], [0.0045, -0.7]];
  const steps = [-0.66, -0.6, -0.54, -0.48, -0.42, -0.36];
  steps.forEach((y, k) => {
    const r = 0.0047 + 0.00045 * k;
    shaft.push([r, y - 0.0015], [r + 0.00045, y + 0.0015]);
  });
  shaft.push([0.0074, -G + 0.004]);
  const shaftMesh = new THREE.Mesh(lathe(shaft, 24), chrome);
  club.add(shaftMesh);

  // ferrule and hosel on the shaft line
  const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.0062, 0.0066, 0.014, 24), black);
  ferrule.position.y = -L + 0.071;
  club.add(ferrule);
  const hosel = new THREE.Mesh(new THREE.CylinderGeometry(0.0068, 0.0086, 0.058, 24), steel);
  hosel.position.y = -L + 0.037;
  club.add(hosel);

  // the head frame: origin where the shaft line meets the ground, turned so the shaft stands at the lie angle
  const head = new THREE.Group();
  head.position.y = -L;
  head.rotation.z = Math.PI / 2 - CLUB.lie;
  club.add(head);
  head.add(new THREE.Mesh(bladeGeometry(), [steel, face]));
  // face grooves: nine, 3.5 mm apart up the face, 5 cm long
  const up = new THREE.Vector3(0, Math.cos(CLUB.loft), -Math.sin(CLUB.loft));
  const out = new THREE.Vector3(0, Math.sin(CLUB.loft), Math.cos(CLUB.loft));
  const grooveGeo = new THREE.BoxGeometry(0.05, 0.0008, 0.0004);
  for (let k = 0; k < 9; k++) {
    const g = new THREE.Mesh(grooveGeo, groove);
    const s = 0.0055 + k * 0.0035;
    g.position.set(-0.028, 0.0015, -OFFSET).addScaledVector(up, s).addScaledVector(out, 0.00012);
    g.rotation.x = -CLUB.loft;
    head.add(g);
  }
  return { club, head, shaft: shaftMesh, ferrule, hosel };
}

/** The club at another length (fitted to you, or shortened to stop at the floor): only the shaft stretches; the grip,
 * the hosel and the head keep their real size. */
function setClubLength(parts: { shaft: THREE.Mesh; ferrule: THREE.Mesh; hosel: THREE.Mesh; head: THREE.Group }, L: number) {
  const top = -CLUB.grip + 0.004; // where the shaft meets the grip
  const k = (top - (-L + 0.078)) / (top - (-CLUB.length + 0.078));
  parts.shaft.scale.y = k;
  parts.shaft.position.y = top * (1 - k);
  parts.ferrule.position.y = -L + 0.071;
  parts.hosel.position.y = -L + 0.037;
  parts.head.position.y = -L;
}

// ---------------------------------------------------------------- hands

type Joints = Record<string, THREE.Object3D>;
const FINGERS = ["index-finger", "middle-finger", "ring-finger", "pinky-finger"] as const;
const PARTS = ["phalanx-proximal", "phalanx-intermediate", "phalanx-distal", "tip"] as const;
const NEEDED = ["wrist", "middle-finger-metacarpal", ...FINGERS.flatMap((f) => PARTS.map((p) => `${f}-${p}`))];

/** One hand read for holding a club: is it closed round a grip, where the grip runs, which way the palm faces. */
class HandGrip {
  tracked = false;
  closed = false;
  readonly center = new THREE.Vector3(); // the middle of the grip inside the fist
  readonly axis = new THREE.Vector3(); // along the grip toward the clubhead (out past the index finger and thumb)
  readonly palm = new THREE.Vector3(); // out of the palm
  readonly frame = new THREE.Quaternion(); // the hand's own frame (across the knuckles, wrist to knuckles)
  // where the club sat in this hand the last time both hands held it, kept while this hand stays closed: when the
  // other hand drops out of tracking (hands overlap on a grip), the club stays exactly where it was in this one
  held = false;
  readonly heldQ = new THREE.Quaternion(); // the club's turn relative to `frame`
  readonly heldAt = new THREE.Vector3(); // this hand's centre in the club's own space
  private p: Record<string, THREE.Vector3> = Object.fromEntries(NEEDED.map((n) => [n, new THREE.Vector3()]));
  private f = new THREE.Vector3();
  private a = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private m = new THREE.Matrix4();
  private z = new THREE.Vector3();

  read(hand: THREE.Object3D | undefined) {
    const joints = liveJoints(hand);
    this.tracked = NEEDED.every((n) => joints[n]?.visible);
    if (!this.tracked) {
      this.closed = this.held = false;
      return;
    }
    for (const n of NEEDED) joints[n].getWorldPosition(this.p[n]);
    const p = this.p;
    const curl = (f: string) => {
      const [a, b, c, d] = PARTS.map((part) => p[`${f}-${part}`]);
      return a.distanceTo(d) / Math.max(1e-4, a.distanceTo(b) + b.distanceTo(c) + c.distanceTo(d)); // 1 = straight
    };
    const rest = (curl("middle-finger") + curl("ring-finger") + curl("pinky-finger")) / 3;
    const index = curl("index-finger"); // a trail hand's index lies along the grip, half curled
    if (!this.closed) this.closed = rest < 0.8 && index < 0.9; // hand tracking rarely sees a tight fist: close earlier
    else if (rest > 0.88 || index > 0.96) this.closed = false;
    if (!this.closed) this.held = false;

    const mcp = (f: string) => p[`${f}-phalanx-proximal`];
    this.f.subVectors(mcp("middle-finger"), p.wrist).normalize(); // wrist to knuckles
    this.a.subVectors(mcp("index-finger"), mcp("pinky-finger")); // across the knuckles, little finger to index
    this.a.addScaledVector(this.f, -this.a.dot(this.f)).normalize();
    this.frame.setFromRotationMatrix(this.m.makeBasis(this.a, this.f, this.z.crossVectors(this.a, this.f)));
    joints["middle-finger-metacarpal"].getWorldQuaternion(this.q);
    this.palm.set(0, -1, 0).applyQuaternion(this.q);
    // a golf grip runs diagonally across the fingers: from the heel pad under the little finger out past the index
    this.axis.copy(this.a).addScaledVector(this.f, 0.6).normalize();
    this.center.set(0, 0, 0);
    for (const f of FINGERS) this.center.add(mcp(f));
    this.center.multiplyScalar(0.25).addScaledVector(this.palm, 0.022).addScaledVector(this.f, -0.006);
  }
}

// ---------------------------------------------------------------- sound

function clickBuffer(ctx: BaseAudioContext, thud: boolean): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * (thud ? 0.08 : 0.1));
  const b = ctx.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const noise = Math.random() * 2 - 1;
    if (thud) {
      lp += (noise - lp) * 0.08;
      d[i] = (lp * 2.2 * Math.exp(-t / 0.006) + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.018) * 0.5) * 0.7;
    } else {
      // a crisp compression click, the ball's ring and a little of the steel
      const click = noise * Math.exp(-t / 0.0035);
      const ring = Math.sin(2 * Math.PI * 3150 * t) * Math.exp(-t / 0.011) * 0.45;
      const body = Math.sin(2 * Math.PI * 1150 * t) * Math.exp(-t / 0.022) * 0.3;
      d[i] = (click * 0.85 + ring + body) * 0.8;
    }
  }
  return b;
}

// ---------------------------------------------------------------- the club, the tee and the ball

type BallState = "teed" | "flying" | "rolling" | "resting" | "returning";

export class Golf {
  /** The club, in world space (it follows your hands, never anchored). */
  readonly club: THREE.Group;
  /** The tee and the ball, on your floor: anchor this (WorldLock) after place(). Floor is y = 0 in its own space. */
  readonly range = new THREE.Group();
  private head: THREE.Group;
  private parts: Parameters<typeof setClubLength>[0];
  private fit = CLUB.length; // the length fitted to you
  private addressT = 0; // seconds the club has been held still, head down (address)
  private lastButt = new THREE.Vector3();
  private teeSpot = new THREE.Group(); // the tee and its shadow: they move to where you address
  private follow = 0; // seconds the head has rested near the ball
  private turnFrom = new THREE.Quaternion();
  private sinceAway = Infinity; // seconds since the head was last well away from the ball (a backswing)
  private turnSpeed = 0; // rad/s, how fast the shown club is turning (smoothed)
  private restAt = new THREE.Vector3(); // where the head came to rest (hand tracking jitters it by a centimetre or so)
  private headV = new THREE.Vector3(); // the head's velocity, smoothed over a few frames: jitter cancels, a swing doesn't
  private ready: THREE.Mesh; // a soft ring under the ball while you're addressing it
  private fade: THREE.Material[] = [];
  private ballFade: THREE.Material[] = [];
  private grips = [new HandGrip(), new HandGrip()];
  private opacity = 0;
  private shown = false; // the club had a real pose last frame (a held or faded pose doesn't swing)
  private liveFrames = 0; // frames in a row the club has been in your hands (a club that just appeared doesn't hit)
  private lostFor = 0;
  private mode: "none" | "one" | "two" = "none";
  private lefty = false;
  private ball: THREE.Mesh;
  private ballShadow: THREE.Mesh;
  private state: BallState = "teed";
  private v = new THREE.Vector3();
  private spin = 0;
  private stateT = 0; // seconds in this state
  private sinceHit = 0;
  private ballAlpha = 1;
  private hits = 0;
  private click: THREE.PositionalAudio | null = null;
  private clickBuf: AudioBuffer | null = null;
  private thudBuf: AudioBuffer | null = null;
  // the three points along the face that meet the ball (heel side, middle, toe side), head frame and last frame's
  private spots = [-0.01, -0.028, -0.046].map((x) => new THREE.Vector3(x, 0.018, -OFFSET - 0.0165 * Math.tan(CLUB.loft)));
  private prev = this.spots.map(() => new THREE.Vector3());
  private cur = this.spots.map(() => new THREE.Vector3());
  private tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3(), x: new THREE.Vector3(), m: new THREE.Matrix4(), q: new THREE.Quaternion() };

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    private hands: THREE.Object3D[],
    private sideOf: (i: number) => XRHandedness | null,
    listener?: THREE.AudioListener,
  ) {
    const env = roomEnvironment(renderer);
    const built = buildClub(env, this.fade);
    this.club = built.club;
    this.head = built.head;
    this.parts = built;
    this.club.visible = false;
    scene.add(this.club);

    // the tee: a short white one, just its cup and a little of its peg above the floor
    const tee = new THREE.Mesh(
      lathe([[0.0021, 0], [0.0023, 0.006], [0.0042, 0.0102], [0.0058, TEE_TOP], [0.0053, TEE_TOP + 0.0002], [0.0001, TEE_TOP - 0.0006]], 20),
      new THREE.MeshStandardMaterial({ color: 0xf3f1ec, roughness: 0.55, envMap: env, envMapIntensity: 0.8, transparent: true }),
    );
    this.ballFade.push(tee.material as THREE.Material);
    this.teeSpot.add(tee, softShadow(0.03, 0.35));
    this.range.add(this.teeSpot);
    this.ready = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.062, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
    this.ready.rotation.x = -Math.PI / 2;
    this.ready.position.y = 0.0015;
    this.range.add(this.ready);
    const dimples = dimpleTexture();
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 40, 28),
      new THREE.MeshPhysicalMaterial({ color: 0xf8f8f5, roughness: 0.42, clearcoat: 0.65, clearcoatRoughness: 0.3, bumpMap: dimples, bumpScale: 1.2, envMap: env, envMapIntensity: 0.9, transparent: true }),
    );
    this.ballFade.push(this.ball.material as THREE.Material);
    this.ballShadow = softShadow(0.07, 0.5);
    this.range.add(this.ball, this.ballShadow);
    this.range.visible = false;
    scene.add(this.range);
    if (listener) {
      this.click = new THREE.PositionalAudio(listener);
      this.click.setRefDistance(1.5);
      this.clickBuf = clickBuffer(listener.context, false);
      this.thudBuf = clickBuffer(listener.context, true);
      this.range.add(this.click);
    }
    this.tee();
  }

  /** On the floor in front of where you stand, the target line running across in front of you (to your left). */
  place(head: THREE.Vector3, forward: THREE.Vector3) {
    this.range.position.set(head.x + forward.x * 0.55, 0, head.z + forward.z * 0.55);
    this.range.rotation.set(0, Math.atan2(forward.x, forward.z), 0);
    this.teeSpot.position.set(0, 0, 0);
    this.tee();
  }

  /** In your room or not: the club and the tee only exist there. */
  setActive(on: boolean) {
    this.range.visible = on;
    if (!on) {
      this.club.visible = false;
      this.opacity = 0;
      this.shown = false;
      this.mode = "none";
      this.tee();
    }
  }

  /** Once a frame while presenting, after the hands are updated. menuOpen: the left palm is up, so the club goes. */
  update(dt: number, menuOpen: boolean) {
    this.range.updateMatrixWorld(); // its anchor may have just moved it
    this.holdClub(dt, menuOpen);
    this.physics(dt);
  }

  private tee() {
    this.state = "teed";
    this.v.set(0, 0, 0);
    this.headV.set(0, 0, 0);
    this.sinceAway = Infinity;
    this.spin = 0;
    this.stateT = 0;
    this.ball.position.set(this.teeSpot.position.x, BALL_TEED, this.teeSpot.position.z);
    this.ball.quaternion.identity();
    this.placeShadow();
  }

  private holdClub(dt: number, menuOpen: boolean) {
    const L = handIndex(this.sideOf, "left");
    const R = handIndex(this.sideOf, "right");
    this.grips[0].read(this.hands[L]);
    this.grips[1].read(this.hands[R]);
    const [gl, gr] = this.grips;
    const { y: Y, z: Z, x: X, m, q, a } = this.tmp;
    let grip: HandGrip | null = null;
    let low: HandGrip | null = null;
    let lefty = this.lefty;
    if (!menuOpen) {
      if (gl.closed && gr.closed && gl.center.distanceTo(gr.center) < 0.16) {
        // both hands on the grip: the top hand is the one the grips point away from
        a.copy(gl.axis).add(gr.axis);
        const along = this.tmp.b.subVectors(gr.center, gl.center);
        const cos = a.dot(along) / (a.length() * along.length() + 1e-9);
        // a grip doesn't change hands mid-swing, and a new one needs clear evidence to: tracking jitter on hands this
        // close together would otherwise flip the club end over end for a frame
        const leftOnTop = gl.held && gr.held ? !this.lefty : this.lefty ? cos > 0.3 : cos > -0.3;
        grip = leftOnTop ? gl : gr;
        low = leftOnTop ? gr : gl;
        lefty = !leftOnTop;
      } else if (gl.closed || gr.closed) {
        grip = gl.closed ? gl : gr; // both closed but apart: the lead (left) hand holds it
        if (!grip.held) lefty = false;
      }
    }
    if (grip) {
      // the hand's centre in the club's own space: the club is placed so that point lands on the hand, whatever the turn
      const at = this.tmp.c;
      if (low) {
        // the shaft from the top hand through the lower one; the face: the back of the top hand and the palm of the
        // lower hand both look at the target
        const line = this.tmp.b.subVectors(low.center, grip.center);
        const d = line.length();
        const w = THREE.MathUtils.clamp((d - 0.025) / 0.04, 0, 1) * 0.7; // hands overlapping: trust the grips
        a.copy(grip.axis).add(low.axis).normalize().multiplyScalar(1 - w).addScaledVector(line.divideScalar(Math.max(d, 1e-6)), w);
        Z.copy(low.palm).sub(grip.palm);
        at.set(0, -TOP_HAND, 0);
      } else if (!grip.held) {
        // one hand from the start: along its own grip, as the top hand (a left hand: its back to the target) or the
        // lower one (a right hand: its palm to the target)
        a.copy(grip.axis);
        Z.copy(grip.palm).multiplyScalar(grip === gr ? 1 : -1);
        at.set(0, grip === gr ? -LOW_HAND : -TOP_HAND, 0);
      }
      if (low || !grip.held) {
        Y.copy(a).normalize().negate(); // the club's +Y runs up the shaft to the butt
        Z.addScaledVector(Y, -Z.dot(Y));
        if (Z.lengthSq() < 1e-8) Z.set(0, 0, 1).addScaledVector(Y, -Y.z);
        Z.normalize();
        X.crossVectors(Y, Z);
        q.setFromRotationMatrix(m.makeBasis(X, Y, Z));
      } else {
        q.copy(grip.frame).multiply(grip.heldQ);
        at.copy(grip.heldAt);
      }
      const mode = low ? "two" : "one";
      if (!this.club.visible || this.opacity < 0.02 || (mode !== this.mode && !grip.held)) this.club.quaternion.copy(q);
      else {
        // smoothing on the turn only (the hands stay on it), set by how fast the club itself is turning: held still at
        // address, tracking jitter (a few degrees a frame, two hands 9 cm apart) is filtered out; in a swing, at tens of
        // radians a second, it follows within a fraction of a frame. A big gap (a quick move from rest) closes at once.
        const err = this.club.quaternion.angleTo(q);
        this.turnFrom.copy(this.club.quaternion);
        this.club.quaternion.slerp(q, 1 - Math.exp(-dt * (12 + 6 * this.turnSpeed + 400 * Math.max(0, err - 0.25))));
        const turned = this.turnFrom.angleTo(this.club.quaternion) / Math.max(dt, 1 / 120);
        this.turnSpeed += (turned - this.turnSpeed) * (1 - Math.exp(-Math.max(dt, 1 / 120) / 0.04));
      }
      if (lefty !== this.lefty) this.head.scale.x = lefty ? -1 : 1; // a left-handed golfer gets a left-handed club
      this.lefty = lefty;
      this.club.position.copy(grip.center).sub(at.applyQuaternion(this.club.quaternion));
      this.fitToFloor(dt);
      this.club.updateMatrixWorld(true);
      if (low)
        for (const h of [grip, low]) {
          h.held = true;
          h.heldQ.copy(h.frame).invert().multiply(this.club.quaternion);
          this.club.worldToLocal(h.heldAt.copy(h.center));
        }
      this.mode = mode;
      this.lostFor = 0;
    } else {
      // tracking drops for a moment in a fast swing: hold the last pose briefly before putting it away
      this.lostFor += dt;
      if (this.lostFor > 0.35 || menuOpen) this.mode = "none";
    }
    const target = this.mode === "none" ? 0 : 1;
    this.opacity = THREE.MathUtils.clamp(this.opacity + (target ? dt / 0.12 : -dt / 0.3), 0, 1);
    for (const mat of this.fade) mat.opacity = this.opacity;
    this.club.visible = this.opacity > 0.01;

    // the face through the ball: points along the face, this frame and last, in the range's own space
    const live = !!grip && this.opacity > 0.5;
    this.spots.forEach((s, k) => this.range.worldToLocal(this.head.localToWorld(this.cur[k].copy(s))));
    this.liveFrames = live ? this.liveFrames + 1 : 0;
    if (live && this.shown && this.liveFrames > 3) this.contact(dt);
    this.prev.forEach((p, k) => p.copy(this.cur[k]));
    this.shown = live;
  }

  /** The club fits you and stops at your floor. Held still with its head down (address), its length eases toward the
   * reach from your hands to the floor along the shaft; whenever the head would go under the floor the shaft is that
   * much shorter, so it rests on the floor instead of passing through it. */
  private fitToFloor(dt: number) {
    const down = this.tmp.z.set(0, -1, 0).applyQuaternion(this.club.quaternion); // butt to head, world
    const butt = this.club.position;
    // held still: within a few centimetres of where the hands have been lately (a per-frame speed is mostly jitter)
    const moved = this.lastButt.distanceTo(butt);
    this.lastButt.lerp(butt, 1 - Math.exp(-dt / 0.25));
    if (moved > 0.15) this.lastButt.copy(butt);
    const reach = down.y < -0.2 ? butt.y / -down.y : Infinity; // butt to the floor along the shaft
    if (down.y < -0.5 && moved < 0.04 && reach < FIT.max + 0.4) this.addressT += dt;
    else this.addressT = 0;
    if (this.addressT > 0.4) this.fit += (THREE.MathUtils.clamp(reach, FIT.min, FIT.max) - this.fit) * Math.min(1, dt * 2.5);
    setClubLength(this.parts, Math.max(0.3, Math.min(this.fit, reach - 0.004)));
  }

  /** At address the ball comes to the club: rest the head near it a moment and it slides in front of the face. */
  private toAddress(dt: number) {
    const h = this.cur[1];
    const ball = this.ball.position;
    // resting: the head stays within a few centimetres of where it settled (a per-frame speed is mostly jitter)
    const near = Math.hypot(h.x - ball.x, h.z - ball.z) < 0.7 && h.y < 0.16;
    if (!near || h.distanceTo(this.restAt) > 0.08) {
      this.restAt.copy(h);
      this.follow = 0;
    } else {
      this.restAt.lerp(h, 1 - Math.exp(-dt / 0.3));
      this.follow += dt;
    }
    const mat = this.ready.material as THREE.MeshBasicMaterial;
    mat.opacity += ((this.follow > 0.15 ? 0.55 : 0) - mat.opacity) * Math.min(1, dt * 8);
    this.ready.position.set(ball.x, 0.0015, ball.z);
    if (this.follow < 0.5) return;
    // in front of the face, on the floor line under the head
    const n = this.faceNormal(this.tmp.c);
    n.y = 0;
    if (n.lengthSq() < 1e-6) return;
    n.normalize();
    const want = this.tmp.a.set(h.x, 0, h.z).addScaledVector(n, BALL_R + 0.012);
    const k = Math.min(1, dt * 6);
    this.teeSpot.position.lerp(want.setY(0), k);
    ball.x = this.teeSpot.position.x;
    ball.z = this.teeSpot.position.z;
  }

  /** The face's lofted normal, in the range's space. */
  private faceNormal(out: THREE.Vector3) {
    out.set(0, Math.sin(CLUB.loft), Math.cos(CLUB.loft)).transformDirection(this.head.matrixWorld);
    return out.transformDirection(this.tmp.m.copy(this.range.matrixWorld).invert());
  }

  private contact(dt: number) {
    if (this.state !== "teed" && this.state !== "resting") return;
    if (this.state === "teed") this.toAddress(dt);
    const c = this.ball.position;
    // a shot needs a backswing: the head away from the ball and back within a moment. Resting or waggling the club
    // at the ball (and hand tracking's jitter on it) never knocks it off the tee
    if (this.cur[1].distanceTo(c) > 0.3) this.sinceAway = 0;
    else this.sinceAway += dt;
    if (this.sinceAway > 0.6) return;
    const { a, b } = this.tmp;
    // the head's path this frame (the middle of the face), and where it came nearest the ball
    const p0 = this.prev[1], p1 = this.cur[1];
    if (p0.distanceTo(p1) > 0.5) return; // a jump (tracking came back somewhere else), not a swing
    a.subVectors(p1, p0);
    this.headV.lerp(b.copy(a).divideScalar(Math.max(dt, 1 / 120)), 1 - Math.exp(-Math.max(dt, 1 / 120) / 0.03));
    const len2 = a.lengthSq();
    const s = len2 > 1e-10 ? THREE.MathUtils.clamp(b.subVectors(c, p0).dot(a) / len2, 0, 1) : 0;
    b.copy(p0).addScaledVector(a, s);
    if (Math.hypot(b.x - c.x, b.z - c.z) > HIT.across || Math.abs(b.y - c.y) > HIT.up) return;
    const vClub = a.divideScalar(Math.max(dt, 1 / 120));
    const speed = vClub.length();
    // resting the club behind it at address isn't a shot, nor is a centimetre of tracking jitter in one frame
    if (speed < HIT.speed || this.headV.length() < HIT.speed) return;
    // only the swing through, the way the face looks (the takeaway goes back past it, never hits it)
    const face = this.faceNormal(this.tmp.c).setY(0);
    const flat = this.tmp.y.set(vClub.x, 0, vClub.z);
    if (face.lengthSq() > 1e-6 && flat.lengthSq() > 1e-6 && flat.dot(face) / Math.sqrt(face.lengthSq() * flat.lengthSq()) < 0.2) return;
    // the line: along your swing, leaned toward the target line (the range's x axis), at an iron's launch angle
    if (flat.lengthSq() < 1e-6) flat.copy(face);
    flat.normalize();
    const target = this.tmp.x.set(Math.sign(flat.x) || 1, 0, 0);
    flat.lerp(target, ASSIST).normalize();
    const ballSpeed = THREE.MathUtils.clamp(speed * 1.35, 3, MAX_BALL_SPEED);
    this.v.copy(flat).multiplyScalar(Math.cos(LAUNCH)).setY(Math.sin(LAUNCH)).multiplyScalar(ballSpeed);
    this.follow = 0;
    this.spin = Math.min(1, ballSpeed / 20) * (0.55 + Math.sin(CLUB.loft)); // backspin from the loft
    this.state = "flying";
    this.stateT = 0;
    this.sinceHit = 0;
    this.hits++;
    this.sound(false, ballSpeed);
  }

  private sound(thud: boolean, speed: number) {
    const buf = thud ? this.thudBuf : this.clickBuf;
    if (!this.click || !buf || this.click.context.state !== "running") return;
    if (this.click.isPlaying) this.click.stop();
    this.click.position.copy(this.ball.position);
    this.click.setBuffer(buf);
    this.click.setVolume(THREE.MathUtils.clamp(speed / (thud ? 14 : 18), thud ? 0.08 : 0.3, thud ? 0.45 : 1));
    this.click.play();
  }

  private physics(dt: number) {
    this.stateT += dt;
    this.sinceHit += dt;
    const p = this.ball.position;
    const v = this.v;
    const steps = 4;
    const h = dt / steps;
    const { a, b } = this.tmp;
    for (let s = 0; s < steps && (this.state === "flying" || this.state === "rolling"); s++) {
      if (this.state === "flying") {
        const sp = v.length();
        // gravity, drag (Cd 0.25) and the backspin's lift (Cl up to ~0.2) for a 45.9 g, 42.7 mm ball
        a.set(0, -9.81, 0).addScaledVector(v, -0.0047 * sp);
        if (sp > 0.1) {
          b.set(0, 1, 0).addScaledVector(v, -v.y / (sp * sp));
          if (b.lengthSq() > 1e-8) a.addScaledVector(b.normalize(), 0.0034 * this.spin * sp * sp);
        }
        v.addScaledVector(a, h);
        p.addScaledVector(v, h);
        this.spin *= Math.exp(-h / 6);
        if (p.y < BALL_R) {
          p.y = BALL_R;
          if (v.y < -0.6) {
            this.sound(true, -v.y);
            v.y = -v.y * 0.42;
            v.x *= 0.72;
            v.z *= 0.72;
            this.spin *= 0.4;
          } else {
            v.y = 0;
            this.state = "rolling";
          }
        }
      } else {
        const sp = Math.hypot(v.x, v.z);
        const slow = 1.4 * h; // rolling resistance on a room floor
        if (sp <= slow) {
          v.set(0, 0, 0);
          this.state = "resting";
          this.stateT = 0;
        } else v.multiplyScalar((sp - slow) / sp);
        p.addScaledVector(v, h);
      }
      // the ball turns as it goes: backspin in the air, rolling on the floor
      const sp = Math.hypot(v.x, v.z);
      if (sp > 1e-4) {
        b.set(v.z, 0, -v.x).divideScalar(sp); // (up x v) / |v|: the axis it rolls about
        const w = this.state === "rolling" ? sp / BALL_R : -this.spin * 60;
        this.tmp.q.setFromAxisAngle(b, w * h);
        this.ball.quaternion.premultiply(this.tmp.q);
      }
    }
    // back on the tee a few seconds later
    const far = Math.hypot(p.x, p.z) > 40;
    const done = (this.state === "resting" && this.stateT > 2.5) || (this.state !== "teed" && this.state !== "returning" && (this.sinceHit > 7 || far));
    if (done) {
      this.state = "returning";
      this.stateT = 0;
    }
    if (this.state === "returning") {
      this.ballAlpha = Math.max(0, this.ballAlpha - dt / 0.3);
      if (this.ballAlpha === 0) this.tee();
    } else this.ballAlpha = Math.min(1, this.ballAlpha + dt / 0.3);
    for (const m of this.ballFade) m.opacity = this.ballAlpha;
    this.placeShadow();
  }

  private placeShadow() {
    const p = this.ball.position;
    const up = Math.max(0, p.y - BALL_R);
    this.ballShadow.position.set(p.x, 0.0012, p.z);
    this.ballShadow.scale.setScalar(1 + up * 1.5);
    (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = this.ballAlpha * THREE.MathUtils.clamp(1 - up / 1.2, 0, 1);
  }

  /** For checks (dev): what the club and ball are doing. */
  debug() {
    const head = this.head.localToWorld(new THREE.Vector3(-0.028, 0.018, 0));
    return {
      mode: this.mode,
      opacity: +this.opacity.toFixed(2),
      lefty: this.lefty,
      butt: this.club.position.toArray().map((x) => +x.toFixed(3)),
      head: head.toArray().map((x) => +x.toFixed(3)),
      ball: { state: this.state, hits: this.hits, at: this.range.localToWorld(this.ball.position.clone()).toArray().map((x) => +x.toFixed(3)), speed: +this.v.length().toFixed(2) },
      grips: this.grips.map((g) => ({ tracked: g.tracked, closed: g.closed })),
    };
  }
}
