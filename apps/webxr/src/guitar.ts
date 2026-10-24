import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { Dream } from "./dream";
import type { Experience } from "./experience";
import { handIndex } from "./xr/menu";

// A real acoustic guitar worn on you, to play along with a guitar lesson. A dreadnought built from code at real size
// (about 1.05 m long, a 0.40 m lower bout, a 645 mm scale): spruce top with its sound hole and rosette, mahogany body
// and neck, a rosewood fretboard with 20 frets, a bridge and saddle, six strings. It rests against your body at waist
// height (worked out from your headset: below and in front of your head, turned the way your body faces); its neck
// lies in your left hand and follows it. Strum with your right hand: a fingertip or the thumb moving across the strings
// over the sound hole plays them, down (low to high) or up (high to low), as loud as you move. The sound is made on the
// spot (Karplus-Strong plucked strings), nothing downloaded. No gesture does anything else: chords come from the palm
// menu, or, in "Fingers", from where your left fingertips press the fretboard.

// ---------------- sizes (guitar frame: +X along the neck to the headstock, +Y toward the low E string, +Z out of
// the top; origin at the centre of the sound hole on the top)
const SCALE = 0.645;
const JOINT_X = 0.135; // where the neck meets the body (the 14th fret)
const NUT_X = JOINT_X + SCALE * (1 - Math.pow(2, -14 / 12));
const SADDLE_X = NUT_X - SCALE;
const fretX = (n: number) => NUT_X - SCALE * (1 - Math.pow(2, -n / 12));
const FRETS = 20;
const FB_Z = 0.0065; // the fretboard's top
const NUT_Z = FB_Z + 0.0013;
const SADDLE_Z = 0.012;
const NUT_SPAN = 0.0365; // low E to high E, at the nut
const SADDLE_SPAN = 0.053;
const HOLE_R = 0.051;
const DEPTH = 0.1;
const OPEN_HZ = [82.41, 110.0, 146.83, 196.0, 246.94, 329.63]; // E2 A2 D3 G3 B3 E4
const GAUGE = [0.00135, 0.00107, 0.00081, 0.00061, 0.00041, 0.0003]; // light gauge, metres across
const along = (x: number) => THREE.MathUtils.clamp((x - SADDLE_X) / (NUT_X - SADDLE_X), 0, 1);
/** String k (0 = low E) across the strings at x along the neck. */
const stringY = (k: number, x: number) => (2.5 - k) * THREE.MathUtils.lerp(SADDLE_SPAN, NUT_SPAN, along(x)) / 5;
const stringZ = (x: number) => THREE.MathUtils.lerp(SADDLE_Z, NUT_Z, along(x));
// where your right hand plays: over the sound hole, from near the bridge to the end of the fretboard
const STRUM = { x0: -0.13, x1: 0.18, y: 0.045, zBelow: 0.02, zAbove: 0.03 };

/** Frets for each string, low E to high E; -1 is not played. */
export const CHORDS: Record<string, number[]> = {
  G: [3, 2, 0, 0, 0, 3], C: [-1, 3, 2, 0, 1, 0], D: [-1, -1, 0, 2, 3, 2], Em: [0, 2, 2, 0, 0, 0], E: [0, 2, 2, 1, 0, 0],
  Am: [-1, 0, 2, 2, 1, 0], A: [-1, 0, 2, 2, 2, 0], Dm: [-1, -1, 0, 2, 3, 1], F: [1, 3, 3, 2, 1, 1], G7: [3, 2, 0, 0, 0, 1],
  C7: [-1, 3, 2, 3, 1, 0], D7: [-1, -1, 0, 2, 1, 2], E7: [0, 2, 0, 1, 0, 0], A7: [-1, 0, 2, 0, 2, 0], Am7: [-1, 0, 2, 0, 1, 0],
  Em7: [0, 2, 2, 0, 3, 0], Cadd9: [-1, 3, 2, 0, 3, 0], Fmaj7: [-1, -1, 3, 2, 1, 0], Bm: [-1, 2, 4, 4, 3, 2], B7: [-1, 2, 1, 2, 0, 2],
  Dsus2: [-1, -1, 0, 2, 3, 0], Dsus4: [-1, -1, 0, 2, 3, 3], Asus2: [-1, 0, 2, 2, 0, 0], Esus4: [0, 2, 2, 2, 0, 0], Bb: [-1, 1, 3, 3, 3, 1],
  "F#m": [2, 4, 4, 2, 2, 2],
};

/** A guitar lesson (the intent / name / plan says guitar, strum or chord), or ?guitar=1. ?guitar=0: never. */
export function wantsGuitar(dream: Dream, experience: Experience | null, search = location.search): boolean {
  const q = new URLSearchParams(search).get("guitar");
  if (q !== null) return q !== "0" && q !== "false";
  const text = [dream.intent, dream.name, experience?.intent, experience?.title].join(" ");
  return /guitar|strum|chord/i.test(text);
}

/** The chords the lesson's plan names (in order of first mention), else G, C, D and Em. */
export function lessonChords(experience: Experience | null): string[] {
  const found: string[] = [];
  for (const st of experience?.steps ?? []) {
    const text = `${st.title ?? ""}. ${st.tip ?? ""}`.replace(/\b([A-G][#b]?) minor\b/g, "$1m").replace(/\b([A-G][#b]?) major\b/g, "$1");
    if (!/chord|strum|play|switch|change|progression|fret/i.test(text)) continue;
    for (const m of text.matchAll(/\b([A-G][#b]?(?:maj7|m7|sus2|sus4|add9|m|7)?)(?=$|[\s,.;:!?)/-])/g)) {
      const name = m[1];
      if (!CHORDS[name] || found.includes(name)) continue;
      if (name === "A" && !/^\s*(chord|major)/i.test(text.slice((m.index ?? 0) + 1))) continue; // "A" is mostly a word
      found.push(name);
    }
  }
  return found.length ? found.slice(0, 6) : ["G", "C", "D", "Em"];
}

// ---------------- building it

function woodTexture(base: string, line: string, lines: number, wave: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const x = c.getContext("2d")!;
  x.fillStyle = base;
  x.fillRect(0, 0, 512, 512);
  x.strokeStyle = line;
  for (let k = 0; k < lines; k++) {
    const y0 = (k + Math.random() * 0.6) * (512 / lines);
    x.globalAlpha = 0.25 + Math.random() * 0.45;
    x.lineWidth = 0.6 + Math.random() * 1.6;
    x.beginPath();
    for (let px = 0; px <= 512; px += 16) x.lineTo(px, y0 + Math.sin(px / 90 + k) * wave);
    x.stroke();
  }
  x.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2); // 512 px = 0.5 m of wood
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The body's outline (dreadnought), top half from the tail to the neck, then mirrored. */
function outline(): THREE.Vector2[] {
  const key: [number, number][] = [
    [-0.375, 0], [-0.364, 0.08], [-0.33, 0.152], [-0.265, 0.192], [-0.18, 0.2], [-0.1, 0.186], [-0.045, 0.155],
    [0.0, 0.138], [0.04, 0.14], [0.085, 0.146], [0.116, 0.138], [0.131, 0.11], [0.135, 0.06], [0.135, 0],
  ];
  const top = new THREE.SplineCurve(key.map(([x, y]) => new THREE.Vector2(x, y))).getPoints(90);
  const bottom = top.slice(1, -1).reverse().map((p) => new THREE.Vector2(p.x, -p.y));
  return [...top, ...bottom];
}

function buildGuitar(env: THREE.Texture) {
  const g = new THREE.Group();
  const gloss = (map: THREE.Texture | null, color: number, rough = 0.55) =>
    new THREE.MeshPhysicalMaterial({ map, color, roughness: rough, clearcoat: 0.9, clearcoatRoughness: 0.18, envMap: env, envMapIntensity: 0.8 });
  const spruce = gloss(woodTexture("#e6c690", "#b98c52", 140, 1.5), 0xffffff);
  const mahogany = gloss(woodTexture("#6a3519", "#3e1c0b", 90, 4), 0xffffff);
  const rosewood = new THREE.MeshStandardMaterial({ map: woodTexture("#3b2417", "#1d100a", 120, 2), roughness: 0.62, envMap: env, envMapIntensity: 0.4 });
  const bone = new THREE.MeshStandardMaterial({ color: 0xf1ead8, roughness: 0.45, envMap: env, envMapIntensity: 0.5 });
  const nickel = new THREE.MeshStandardMaterial({ color: 0xd9dadc, metalness: 1, roughness: 0.25, envMap: env, envMapIntensity: 1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x120b07, roughness: 0.9 });
  const black = new THREE.MeshPhysicalMaterial({ color: 0x0d0b0a, roughness: 0.35, clearcoat: 0.6, envMap: env, envMapIntensity: 0.5 });
  const cream = new THREE.MeshStandardMaterial({ color: 0xece2c6, roughness: 0.4, envMap: env, envMapIntensity: 0.5 });
  const pearl = new THREE.MeshStandardMaterial({ color: 0xe9f1ef, roughness: 0.25, metalness: 0.1, envMap: env, envMapIntensity: 1 });
  const tortoise = gloss(woodTexture("#3b1a0b", "#120703", 60, 6), 0xffffff, 0.4);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0, parent: THREE.Object3D = g) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  // the body: sides and back (mahogany), the top laid on it with the sound hole cut out, a cream binding round the edge
  const pts = outline();
  const bevel = 0.004;
  const body = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: DEPTH, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 12 });
  body.translate(0, 0, -(DEPTH + bevel + 0.0005));
  add(body, [mahogany, mahogany]);
  const topShape = new THREE.Shape(pts);
  topShape.holes.push(new THREE.Path().absarc(0, 0, HOLE_R, 0, Math.PI * 2, true));
  add(new THREE.ShapeGeometry(topShape, 48), spruce);
  add(new THREE.CircleGeometry(HOLE_R, 48), dark, 0, 0, -0.0003);
  const edge = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x, p.y, -0.0015)), true);
  add(new THREE.TubeGeometry(edge, 320, 0.0032, 6, true), cream);
  // rosette
  for (const [r0, r1, m] of [[0.0555, 0.0585, black], [0.0598, 0.0638, pearl], [0.065, 0.0672, black]] as const) add(new THREE.RingGeometry(r0, r1, 64), m, 0, 0, 0.0003);
  // pickguard on the treble side, hugging the sound hole
  const guard = new THREE.Shape();
  const gp: [number, number][] = [[0.048, -0.052], [0.066, -0.08], [0.06, -0.118], [0.02, -0.142], [-0.05, -0.138], [-0.092, -0.108], [-0.078, -0.072], [-0.05, -0.06]];
  guard.moveTo(gp[0][0], gp[0][1]);
  gp.slice(1).forEach(([x, y]) => guard.lineTo(x, y));
  guard.absarc(0, 0, 0.069, Math.atan2(-0.06, -0.05), Math.atan2(-0.052, 0.048), false);
  add(new THREE.ShapeGeometry(guard, 16), tortoise, 0, 0, 0.0004);

  // bridge, saddle and pins
  add(new THREE.BoxGeometry(0.03, 0.155, 0.008), rosewood, SADDLE_X - 0.004, 0, 0.004);
  add(new THREE.BoxGeometry(0.0028, 0.075, 0.0045), bone, SADDLE_X, 0, 0.008 + 0.00175);
  for (let k = 0; k < 6; k++) add(new THREE.CylinderGeometry(0.0026, 0.0026, 0.004, 10), bone, SADDLE_X - 0.012, stringY(k, SADDLE_X), 0.0095).rotation.x = Math.PI / 2;

  // the neck: a rounded back under the fretboard, and the heel at the body
  const neck = new THREE.CylinderGeometry(0.022, 0.028, NUT_X - JOINT_X + 0.01, 24, 1, false, Math.PI / 2, Math.PI);
  neck.rotateZ(-Math.PI / 2);
  add(neck, mahogany, (NUT_X + JOINT_X - 0.01) / 2, 0, 0);
  add(new THREE.BoxGeometry(0.035, 0.056, 0.075), mahogany, JOINT_X - 0.0075, 0, -0.0375);

  // fretboard (narrowing toward the nut), frets, dots, nut
  const fbEnd = fretX(FRETS) - 0.008;
  const halfW = (x: number) => THREE.MathUtils.lerp(0.028, 0.0215, (x - fbEnd) / (NUT_X - fbEnd));
  const fb = new THREE.BoxGeometry(NUT_X - fbEnd, 1, FB_Z);
  const cx = (NUT_X + fbEnd) / 2;
  const fp = fb.attributes.position;
  for (let i = 0; i < fp.count; i++) fp.setY(i, Math.sign(fp.getY(i)) * halfW(cx + fp.getX(i)));
  fb.computeVertexNormals();
  add(fb, rosewood, cx, 0, FB_Z / 2);
  for (let n = 1; n <= FRETS; n++) add(new THREE.BoxGeometry(0.0022, 2 * halfW(fretX(n)), 0.0012), nickel, fretX(n), 0, FB_Z + 0.0006);
  for (const n of [3, 5, 7, 9, 12, 15, 17]) {
    const x = (fretX(n) + fretX(n - 1)) / 2;
    for (const y of n === 12 ? [-0.009, 0.009] : [0]) add(new THREE.CircleGeometry(0.003, 16), pearl, x, y, FB_Z + 0.0002);
  }
  add(new THREE.BoxGeometry(0.005, 0.045, 0.0026), bone, NUT_X + 0.0025, 0, FB_Z + 0.0013);

  // the headstock, angled back 14 degrees, with six tuners
  const head = new THREE.Group();
  head.position.set(NUT_X + 0.005, 0, FB_Z - 0.003);
  head.rotation.y = THREE.MathUtils.degToRad(14);
  g.add(head);
  add(new THREE.BoxGeometry(0.19, 0.088, 0.014), mahogany, 0.095, 0, -0.007, head);
  add(new THREE.BoxGeometry(0.188, 0.086, 0.001), black, 0.095, 0, 0.0002, head);
  for (const x of [0.045, 0.095, 0.145])
    for (const s of [-1, 1]) {
      add(new THREE.CylinderGeometry(0.003, 0.0035, 0.012, 10), nickel, x, s * 0.027, 0.006, head).rotation.x = Math.PI / 2;
      add(new THREE.CylinderGeometry(0.0022, 0.0022, 0.016, 8), nickel, x, s * 0.05, -0.008, head);
      const button = add(new THREE.SphereGeometry(0.008, 12, 8), pearl, x, s * 0.062, -0.008, head);
      button.scale.set(1, 0.45, 0.75);
    }

  // the strings, nut to saddle, each with a faint blur that shows it ringing
  const strings: { blur: THREE.Mesh; mat: THREE.MeshBasicMaterial; base: number }[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < 6; k++) {
    const r = GAUGE[k] / 2;
    const a = new THREE.Vector3(NUT_X, stringY(k, NUT_X), NUT_Z + r);
    const b = new THREE.Vector3(SADDLE_X, stringY(k, SADDLE_X), SADDLE_Z + r);
    const len = a.distanceTo(b);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(up, a.clone().sub(b).normalize());
    const wound = k < 4;
    const mat = new THREE.MeshStandardMaterial({ color: wound ? 0xc4945a : 0xdadde0, metalness: 1, roughness: wound ? 0.42 : 0.25, envMap: env, envMapIntensity: 1 });
    add(new THREE.CylinderGeometry(r, r, len, 6), mat, mid.x, mid.y, mid.z).quaternion.copy(q);
    const blurMat = new THREE.MeshBasicMaterial({ color: wound ? 0xffd9a8 : 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    const blur = add(new THREE.CylinderGeometry(r + 0.0012, r + 0.0012, len * 0.96, 6), blurMat, mid.x, mid.y, mid.z);
    blur.quaternion.copy(q);
    strings.push({ blur, mat: blurMat, base: r });
  }

  // a soft glow over the strings where you strum, shown as your right hand comes near
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(STRUM.x1 - STRUM.x0, 2 * STRUM.y), new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.position.set((STRUM.x0 + STRUM.x1) / 2, 0, stringZ(0) + 0.0015);
  g.add(glow);

  // where the chord's fingers go: small dots on the fretboard
  const dotMat = new THREE.MeshBasicMaterial({ color: 0x2997ff, transparent: true, opacity: 0.9, depthWrite: false });
  const dots = Array.from({ length: 6 }, () => {
    const d = add(new THREE.CircleGeometry(0.0045, 16), dotMat);
    d.visible = false;
    return d;
  });
  return { group: g, strings, glow, dots, dotMat };
}

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, "rgba(140,200,255,0)");
  g.addColorStop(0.5, "rgba(140,200,255,0.9)");
  g.addColorStop(1, "rgba(140,200,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 64);
  const h = x.createLinearGradient(0, 0, 256, 0);
  h.addColorStop(0, "rgba(0,0,0,1)");
  h.addColorStop(0.15, "rgba(0,0,0,0)");
  h.addColorStop(0.85, "rgba(0,0,0,0)");
  h.addColorStop(1, "rgba(0,0,0,1)");
  x.globalCompositeOperation = "destination-out";
  x.fillStyle = h;
  x.fillRect(0, 0, 256, 64);
  return new THREE.CanvasTexture(c);
}

// ---------------- sound: Karplus-Strong, one buffer per string and fret, made when first needed

function pluckBuffer(ctx: BaseAudioContext, hz: number, k: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * (3.4 - k * 0.3));
  const buf = ctx.createBuffer(1, n, sr);
  const out = buf.getChannelData(0);
  const period = sr / hz;
  const N = Math.max(2, Math.floor(period - 0.6)); // the averaging filter adds half a sample, the allpass the rest
  const frac = period - N - 0.5;
  const C = (1 - frac) / (1 + frac);
  const t60 = 6 - k * 0.65; // a low E rings longer than a high E
  const rho = Math.pow(0.001, 1 / (t60 * hz));
  // the pluck: a softened noise burst, with the comb of a pick about a seventh of the way along the string
  const raw = new Float32Array(N);
  let lp = 0;
  for (let i = 0; i < N; i++) {
    lp += (Math.random() * 2 - 1 - lp) * 0.55;
    raw[i] = lp;
  }
  const line = new Float32Array(N);
  const pick = Math.max(1, Math.round(N * 0.13));
  let mean = 0;
  for (let i = 0; i < N; i++) mean += (line[i] = raw[i] - 0.9 * (i >= pick ? raw[i - pick] : 0)) / N;
  let peak = 1e-6;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs((line[i] -= mean)));
  for (let i = 0; i < N; i++) line[i] /= peak;
  let idx = 0, prev = 0, apX = 0, apY = 0;
  for (let i = 0; i < n; i++) {
    const cur = line[idx];
    const avg = 0.5 * (cur + prev);
    prev = cur;
    const y = C * avg + apX - C * apY;
    apX = avg;
    apY = y;
    out[i] = cur;
    line[idx] = y * rho;
    idx = idx + 1 === N ? 0 : idx + 1;
  }
  const fade = Math.floor(sr * 0.05);
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  return buf;
}

type Joints = Record<string, THREE.Object3D>;
const jointsOf = (h: THREE.Object3D | undefined) => (h as unknown as { joints?: Joints } | undefined)?.joints ?? {};
const TIPS = ["thumb-tip", "index-finger-tip", "middle-finger-tip", "ring-finger-tip", "pinky-finger-tip"];
const FRET_TIPS = ["index-finger-tip", "middle-finger-tip", "ring-finger-tip", "pinky-finger-tip"];

export class Guitar {
  readonly group: THREE.Group;
  chord: string;
  fingers = false; // play what the left fingertips press instead of the chord
  onChange: () => void = () => {};
  private built: ReturnType<typeof buildGuitar>;
  private active = false;
  private ready = false;
  private torso = new THREE.Vector3(0, 0, -1); // the way your body faces (flat)
  private hold = 0; // 0 = the neck at rest, 1 = the neck in your left hand
  private prevTips = TIPS.map(() => new THREE.Vector3());
  private prevOk = TIPS.map(() => false);
  private lastPluck = new Array(6).fill(-1);
  private ring = new Array(6).fill(0); // how hard each string is ringing, for the blur
  private frets: number[] = [0, 0, 0, 0, 0, 0];
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private panner: PannerNode | null = null;
  private voices: ({ src: AudioBufferSourceNode; gain: GainNode } | null)[] = new Array(6).fill(null);
  private cache = new Map<string, AudioBuffer>();
  private handDir = new THREE.Vector3(-1, 0.3, 0); // where the neck last pointed in your hand
  private w = {
    pivot: new THREE.Vector3(),
    fwd: new THREE.Vector3(),
    right: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
    target: new THREE.Vector3(),
    neck: new THREE.Vector3(),
    zAxis: new THREE.Vector3(),
    yAxis: new THREE.Vector3(),
    grip: new THREE.Vector3(),
    tmp: new THREE.Vector3(),
    p: new THREE.Vector3(),
  };
  private q = new THREE.Quaternion();
  private m = new THREE.Matrix4();
  plucks = 0;
  lastStrum: { dir: string; strings: number[]; speed: number } | null = null;

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    private hands: THREE.Object3D[],
    private sideOf: (i: number) => XRHandedness | null,
    listener: THREE.AudioListener | undefined,
    readonly chords: string[],
  ) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.built = buildGuitar(env);
    this.group = this.built.group;
    this.group.visible = false;
    scene.add(this.group);
    this.chord = chords[0] ?? "G";
    if (listener) {
      const ctx = (this.ctx = listener.context);
      // a guitar body: a little warmth around 100 and 200 Hz, the very top softened; heard from the sound hole
      this.master = ctx.createGain();
      this.master.gain.value = 0.32;
      const low = ctx.createBiquadFilter();
      low.type = "peaking";
      low.frequency.value = 105;
      low.Q.value = 1.1;
      low.gain.value = 5;
      const mid = ctx.createBiquadFilter();
      mid.type = "peaking";
      mid.frequency.value = 215;
      mid.Q.value = 1.4;
      mid.gain.value = 3;
      const top = ctx.createBiquadFilter();
      top.type = "lowpass";
      top.frequency.value = 6500;
      this.panner = ctx.createPanner();
      this.panner.panningModel = "HRTF";
      this.panner.distanceModel = "inverse";
      this.panner.refDistance = 0.8;
      this.master.connect(low).connect(mid).connect(top).connect(this.panner).connect(listener.getInput());
    }
    this.setChord(this.chord);
  }

  setChord(name: string) {
    if (!CHORDS[name]) return;
    this.chord = name;
    this.fingers = false;
    this.warm(CHORDS[name]);
    this.onChange();
  }

  setFingers(on: boolean) {
    this.fingers = on;
    this.onChange();
  }

  setActive(on: boolean) {
    this.active = on;
    this.group.visible = on;
    this.ready = false;
    this.hold = 0;
    if (!on) for (let k = 0; k < 6; k++) this.stop(k, this.ctx?.currentTime ?? 0);
  }

  /** Make the chord's sounds ahead of the first strum (a few ms each). */
  private warm(frets: number[]) {
    if (!this.ctx) return;
    frets.forEach((f, k) => f >= 0 && this.buffer(k, f));
  }

  private buffer(k: number, fret: number): AudioBuffer {
    const key = `${k}:${fret}`;
    let b = this.cache.get(key);
    if (!b) this.cache.set(key, (b = pluckBuffer(this.ctx!, OPEN_HZ[k] * Math.pow(2, fret / 12), k)));
    return b;
  }

  /** Once a frame while presenting: your eyes (world) and the headset's turn. */
  update(dt: number, menuOpen: boolean, eye: THREE.Vector3, headQ: THREE.Quaternion) {
    if (!this.active) return;
    const { pivot, fwd, right, up, target, neck, zAxis, yAxis } = this.w;
    // your torso: the head turns about the top of the spine (a little below and behind your eyes); the body faces where
    // the head has been facing, followed slowly, since you turn your head far more than your body
    pivot.set(0, -0.1, 0.09).applyQuaternion(headQ).add(eye);
    const hf = fwd.set(0, 0, -1).applyQuaternion(headQ).setY(0);
    if (hf.lengthSq() > 1e-4) {
      hf.normalize();
      if (!this.ready) this.torso.copy(hf);
      else this.torso.lerp(hf, 1 - Math.exp(-dt / 0.5)).normalize();
    }
    fwd.copy(this.torso);
    right.set(-fwd.z, 0, fwd.x);
    // the sound hole: at your waist, in front of your belly, a touch to the right
    target.copy(pivot).addScaledVector(up, -0.49).addScaledVector(fwd, 0.2).addScaledVector(right, 0.05);
    if (!this.ready) this.group.position.copy(target);
    else this.group.position.lerp(target, 1 - Math.exp(-dt * 14));

    // the neck: at rest it rises 20 degrees to your left and comes 18 degrees forward; with your left hand on it, it
    // points at your hand (within what an arm can hold), and the hand can slide along it
    this.restNeck(neck, fwd, right, up);
    const grip = this.leftGrip(this.w.grip);
    let follow = false;
    if (grip && !menuOpen) {
      const d = grip.sub(this.group.position);
      const len = d.length();
      d.divideScalar(len);
      const el = Math.asin(THREE.MathUtils.clamp(d.dot(up), -1, 1));
      const az = Math.atan2(d.dot(fwd), -d.dot(right));
      const deg = THREE.MathUtils.radToDeg;
      follow = len > 0.22 && len < 0.85 && deg(el) > -45 && deg(el) < 75 && deg(az) > -45 && deg(az) < 85;
      if (follow) {
        const e = THREE.MathUtils.clamp(el, THREE.MathUtils.degToRad(-15), THREE.MathUtils.degToRad(55));
        const a = THREE.MathUtils.clamp(az, THREE.MathUtils.degToRad(5), THREE.MathUtils.degToRad(55)); // never back through you
        this.handDir.copy(right).multiplyScalar(-Math.cos(e) * Math.cos(a)).addScaledVector(fwd, Math.cos(e) * Math.sin(a)).addScaledVector(up, Math.sin(e));
      }
    }
    this.hold = THREE.MathUtils.clamp(this.hold + (follow ? dt : -dt) / 0.15, 0, 1);
    neck.lerp(this.handDir, this.hold).normalize();
    // the top faces forward, tipped back 12 degrees so you can see the strings
    zAxis.copy(fwd).multiplyScalar(Math.cos(0.21)).addScaledVector(up, Math.sin(0.21));
    zAxis.addScaledVector(neck, -zAxis.dot(neck)).normalize();
    yAxis.crossVectors(zAxis, neck);
    this.q.setFromRotationMatrix(this.m.makeBasis(neck, yAxis, zAxis));
    if (!this.ready) this.group.quaternion.copy(this.q);
    else this.group.quaternion.slerp(this.q, 1 - Math.exp(-dt * 20));
    this.group.updateMatrixWorld(true);
    this.ready = true;

    if (this.fingers) this.readFrets();
    this.showChord();
    this.strum(dt, menuOpen);
    this.ringOut(dt);
    if (this.panner) {
      const p = this.group.position;
      if (this.panner.positionX) {
        this.panner.positionX.value = p.x;
        this.panner.positionY.value = p.y;
        this.panner.positionZ.value = p.z;
      } else this.panner.setPosition(p.x, p.y, p.z);
    }
  }

  private restNeck(out: THREE.Vector3, fwd: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3): THREE.Vector3 {
    const e = THREE.MathUtils.degToRad(20), a = THREE.MathUtils.degToRad(18);
    return out.copy(right).multiplyScalar(-Math.cos(e) * Math.cos(a)).addScaledVector(fwd, Math.cos(e) * Math.sin(a)).addScaledVector(up, Math.sin(e)).normalize();
  }

  /** Where your left hand holds a neck: in the V between thumb and index finger. */
  private leftGrip(out: THREE.Vector3): THREE.Vector3 | null {
    const j = jointsOf(this.hands[handIndex(this.sideOf, "left")]);
    const a = j["thumb-phalanx-distal"], b = j["index-finger-phalanx-proximal"], c = j["middle-finger-phalanx-proximal"];
    if (!a?.visible || !b?.visible || !c?.visible) return null;
    const t = this.w.tmp;
    out.copy(a.getWorldPosition(t)).add(b.getWorldPosition(t)).add(c.getWorldPosition(t)).multiplyScalar(1 / 3);
    return out;
  }

  /** "Fingers": each left fingertip close above the fretboard frets the string under it. */
  private readFrets() {
    this.frets = [0, 0, 0, 0, 0, 0];
    const j = jointsOf(this.hands[handIndex(this.sideOf, "left")]);
    const p = this.w.p;
    for (const name of FRET_TIPS) {
      const tip = j[name];
      if (!tip?.visible) continue;
      this.group.worldToLocal(tip.getWorldPosition(p));
      if (p.x > NUT_X || p.x < fretX(15) || p.z - FB_Z < -0.012 || p.z - FB_Z > 0.022) continue;
      const span = THREE.MathUtils.lerp(SADDLE_SPAN, NUT_SPAN, along(p.x));
      if (Math.abs(p.y) > span / 2 + 0.005) continue;
      const k = THREE.MathUtils.clamp(Math.round(2.5 - (p.y / span) * 5), 0, 5);
      let n = 1;
      while (n < 15 && fretX(n) > p.x) n++;
      this.frets[k] = Math.max(this.frets[k], n);
    }
  }

  private currentFrets(): number[] {
    return this.fingers ? this.frets : CHORDS[this.chord];
  }

  private showChord() {
    const frets = CHORDS[this.chord];
    this.built.dots.forEach((d, k) => {
      const f = this.fingers ? 0 : frets[k];
      d.visible = f > 0;
      if (!d.visible) return;
      const x = (fretX(f) + fretX(f - 1)) / 2 + (fretX(f) - fretX(f - 1)) * 0.2; // just behind the fret, where a finger goes
      d.position.set(x, stringY(k, x), FB_Z + 0.0009);
    });
  }

  // ---------------- your right hand on the strings

  private strum(dt: number, menuOpen: boolean) {
    const j = jointsOf(this.hands[handIndex(this.sideOf, "right")]);
    const p = this.w.p;
    let near = Infinity;
    TIPS.forEach((name, i) => {
      const tip = j[name];
      if (!tip?.visible) return void (this.prevOk[i] = false);
      this.group.worldToLocal(tip.getWorldPosition(p));
      const zs = stringZ(p.x);
      const inX = p.x > STRUM.x0 && p.x < STRUM.x1;
      const dz = p.z - zs;
      const ok = inX && dz > -STRUM.zBelow && dz < STRUM.zAbove && Math.abs(p.y) < STRUM.y + 0.03;
      if (inX) near = Math.min(near, Math.max(0, Math.abs(dz) - 0.01, Math.abs(p.y) - STRUM.y));
      const prev = this.prevTips[i];
      const jump = prev.distanceTo(p) > 0.12; // tracking that jumps isn't a stroke
      if (ok && this.prevOk[i] && !menuOpen && dt > 0 && !jump) {
        const vy = (p.y - prev.y) / dt;
        // the strings this fingertip passed this frame, in the order it met them
        const crossed: { k: number; f: number }[] = [];
        for (let k = 0; k < 6; k++) {
          const yk = stringY(k, p.x);
          if ((prev.y - yk) * (p.y - yk) < 0) crossed.push({ k, f: (prev.y - yk) / (prev.y - p.y) });
        }
        crossed.sort((a, b) => a.f - b.f);
        if (crossed.length) this.play(crossed, vy, dt, p.x);
        else if (prev.z - stringZ(prev.x) > 0.002 && dz <= 0.002 && Math.abs(p.y) < STRUM.y) {
          // a fingertip pushed straight into the strings: the nearest one
          const k = THREE.MathUtils.clamp(Math.round(2.5 - (p.y / THREE.MathUtils.lerp(SADDLE_SPAN, NUT_SPAN, along(p.x))) * 5), 0, 5);
          this.pluck(k, 0, Math.min(1, Math.abs((prev.z - p.z) / dt) / 1.5));
        }
      }
      prev.copy(p);
      this.prevOk[i] = ok;
    });
    const glow = this.built.glow.material as THREE.MeshBasicMaterial;
    const target = menuOpen ? 0 : 0.22 * THREE.MathUtils.clamp(1 - near / 0.07, 0, 1);
    glow.opacity += (target - glow.opacity) * Math.min(1, dt * 10);
  }

  /** A fingertip crossed these strings: a strum carries on through the rest; a slow touch plays just those. */
  private play(crossed: { k: number; f: number }[], vy: number, dt: number, x: number) {
    const speed = Math.abs(vy);
    const vel = THREE.MathUtils.clamp(speed / 2.2, 0.12, 1);
    const lag = dt; // one frame behind, so the strings keep the order and spacing they were crossed in
    if (speed > 0.25) {
      const down = vy < 0; // toward the floor: low E to high E
      const first = crossed[0];
      const order = down ? [0, 1, 2, 3, 4, 5].filter((k) => k >= first.k) : [5, 4, 3, 2, 1, 0].filter((k) => k <= first.k);
      const y0 = stringY(first.k, x);
      for (const k of order) {
        const gap = THREE.MathUtils.clamp(Math.abs(stringY(k, x) - y0) / speed, 0.006 * Math.abs(k - first.k), 0.025 * Math.abs(k - first.k));
        this.pluck(k, lag * first.f + gap, vel);
      }
      this.lastStrum = { dir: down ? "down" : "up", strings: order, speed: +speed.toFixed(2) };
    } else for (const c of crossed) this.pluck(c.k, lag * c.f, Math.max(vel, 0.25));
  }

  private pluck(k: number, delay: number, vel: number) {
    const now = this.ctx?.currentTime ?? performance.now() / 1000;
    const when = now + delay;
    if (when - this.lastPluck[k] < 0.07) return; // already sounding from this stroke
    this.lastPluck[k] = when;
    const fret = this.currentFrets()[k];
    if (fret < 0) return; // a string the chord leaves out
    this.plucks++;
    this.ring[k] = Math.max(this.ring[k], vel);
    if (!this.ctx || !this.master || this.ctx.state !== "running") return;
    this.stop(k, when);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer(k, fret);
    const tone = this.ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 1200 + 7000 * vel; // softer is darker
    const gain = this.ctx.createGain();
    gain.gain.value = 0.15 + 0.7 * vel;
    src.connect(tone).connect(gain).connect(this.master);
    src.start(when);
    this.voices[k] = { src, gain };
  }

  /** A string struck again stops ringing first, as a real one does under the pick. */
  private stop(k: number, when: number) {
    const v = this.voices[k];
    if (!v) return;
    v.gain.gain.setTargetAtTime(0, when, 0.008);
    try {
      v.src.stop(when + 0.06);
    } catch {
      // already stopped
    }
    this.voices[k] = null;
  }

  private ringOut(dt: number) {
    this.built.strings.forEach((s, k) => {
      this.ring[k] *= Math.exp(-dt / (1.1 - k * 0.1));
      const a = this.ring[k];
      s.mat.opacity = 0.55 * a;
      s.blur.visible = a > 0.01;
      const w = 1 + 1.6 * a * (0.6 + 0.4 * Math.sin(performance.now() / 9 + k));
      s.blur.scale.set(w, 1, w);
    });
  }

  /** For checks (dev): string positions in the world, and what's going on. */
  stringPoint(k: number, x: number, dz = 0): THREE.Vector3 {
    return this.group.localToWorld(new THREE.Vector3(x, stringY(k, x), stringZ(x) + dz));
  }

  debug() {
    const r = (v: THREE.Vector3) => v.toArray().map((n) => +n.toFixed(3));
    const neck = new THREE.Vector3(1, 0, 0).transformDirection(this.group.matrixWorld);
    return { active: this.active, chord: this.fingers ? "fingers" : this.chord, frets: this.currentFrets(), hole: r(this.group.position), neck: r(neck), hold: +this.hold.toFixed(2), plucks: this.plucks, lastStrum: this.lastStrum, audio: this.ctx?.state };
  }
}
