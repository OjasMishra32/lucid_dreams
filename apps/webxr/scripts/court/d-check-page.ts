// The in-page half of stream D's checks (scripts/court/d-check.mjs drives it through window.__d): the real show
// player (WebCodecs, both decoders) on the stand-in at 72 Hz wall-clock pacing for P4/P5, and mono renders from the
// dolly seat (19.5 px/deg, the Quest 3S centre) of the video layer, the 3D under it and the hand-off for P8, P43, P44.
// Vite serves it (scripts/court/d-check.html), so it imports the court modules as the app does.
import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { cameraOf, rotate } from "../../src/court/camera";
import { loadCourt, type CourtBundle, type Vec3 } from "../../src/court/format";
import { HANDOFF_END, handoff, type HandoffParts } from "../../src/court/handoff";
import { LightField } from "../../src/court/lightfield";
import { Proxies } from "../../src/court/proxies";
import { ShowVideo } from "../../src/court/video";

/** The Quest 3S centre's angular resolution: 0.05 deg is one pixel. */
export const PPD = 19.5;
const W = 1280;
const H = 800;
const FOCAL = (PPD * 180) / Math.PI;
const FOV_Y = (2 * Math.atan(H / 2 / FOCAL) * 180) / Math.PI;
/** The zoomed silhouette passes. */
const ZW = 2560;
const ZH = 1600;
const ZOOM_FOV = 30;
const SEATED_EYE = 1.15;

interface Rig {
  bundle: CourtBundle;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  proxies: Proxies;
  video: ShowVideo;
  light: LightField;
  gl: WebGL2RenderingContext;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rig(bundleUrl: string): Promise<Rig> {
  const bundle = await loadCourt(bundleUrl);
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H);
  renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV_Y, W / H, 0.05, 200);
  // court.ts's wiring: one light field, the video, then the proxies on both
  const light = new LightField(bundle.court);
  const video = new ShowVideo(renderer, bundle);
  const proxies = new Proxies(renderer, bundle, video, light);
  scene.add(proxies.group);
  await Promise.all([video.load(), proxies.load()]);
  light.set("watch", 0);
  return { bundle, renderer, scene, camera, proxies, video, light, gl: renderer.getContext() as WebGL2RenderingContext };
}

/** Decision W's dolly seat: on camera F's ray, D' from the pair, eye at the seated height, looking at the pair; `offset` in the eye's own axes (right, up). */
export function seatEye(bundle: CourtBundle, offset: [number, number] = [0, 0]): { eye: Vec3; target: Vec3; q: [number, number, number, number] } {
  const { court, frames } = bundle;
  const fIndex = court.video.segments.eases[0].frames[1];
  const camF = cameraOf(court, frames[fIndex]);
  const axis = rotate(camF.q, [0, 0, 1]);
  const h = Math.hypot(axis[0], axis[2]);
  const pc = court.seat.pairCentre;
  const d = court.seat.distance;
  const fwd: Vec3 = [axis[0] / h, 0, axis[2] / h];
  const right: Vec3 = [-fwd[2], 0, fwd[0]];
  const eye: Vec3 = [pc[0] - fwd[0] * d + right[0] * offset[0], SEATED_EYE + offset[1], pc[2] - fwd[2] * d + right[2] * offset[0]];
  const target: Vec3 = [pc[0] + right[0] * offset[0], 1.0 + offset[1], pc[2] + right[2] * offset[0]];
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(...eye), new THREE.Vector3(...target), new THREE.Vector3(0, 1, 0));
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return { eye, target, q: [q.x, q.y, q.z, q.w] };
}

function place(r: Rig, offset: [number, number] = [0, 0]): ReturnType<typeof seatEye> {
  const s = seatEye(r.bundle, offset);
  r.camera.position.set(...s.eye);
  r.camera.quaternion.set(...s.q);
  r.camera.fov = FOV_Y;
  r.camera.updateProjectionMatrix();
  r.camera.updateMatrixWorld(true);
  return s;
}

/** Camera F itself: its centre, its rotation (OpenCV axes turned to three's), its focal (the principal point is the image centre). */
function placeAtF(r: Rig, fIndex: number): void {
  const cam = cameraOf(r.bundle.court, r.bundle.frames[fIndex]);
  const q = new THREE.Quaternion(...cam.q).multiply(new THREE.Quaternion(1, 0, 0, 0));
  r.camera.position.set(...cam.centre);
  r.camera.quaternion.copy(q);
  r.camera.fov = (2 * Math.atan(cam.height / 2 / cam.f) * 180) / Math.PI;
  r.camera.updateProjectionMatrix();
  r.camera.updateMatrixWorld(true);
}

/** The current canvas, top row first, as base64 RGBA. */
function read(r: Rig): string {
  const { width: w, height: h } = r.renderer.getDrawingBufferSize(new THREE.Vector2());
  const px = new Uint8Array(w * h * 4);
  r.gl.readPixels(0, 0, w, h, r.gl.RGBA, r.gl.UNSIGNED_BYTE, px);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  let bin = "";
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** One display frame of the show: what the clock would show, and the jump the second decoder should prime. */
interface Step {
  frame: number;
  jump: number | null;
}

/** A press in pass 1 (armed, so pass 2 takes the first ease), the freeze held, then the resume; or (`between`) a press in pass 2 between the first two ease starts. */
function schedule(bundle: CourtBundle, between: boolean, freezeFrames: number): Step[] {
  const seg = bundle.court.video.segments;
  const out: Step[] = [];
  const e = between ? seg.eases[1] : seg.eases[0];
  for (let i = seg.pass1[0]; i <= seg.pass1[1]; i++) out.push({ frame: i, jump: between ? seg.eases[0].frames[0] : e.frames[0] });
  for (let i = seg.pass2[0]; i <= e.start; i++) out.push({ frame: i, jump: between && i >= seg.eases[0].start ? e.frames[0] : seg.eases[0].frames[0] });
  for (let i = e.frames[0]; i <= e.frames[1]; i++) out.push({ frame: i, jump: seg.resume[0] });
  for (let k = 0; k < freezeFrames; k++) out.push({ frame: e.frames[1], jump: seg.resume[0] });
  for (let i = seg.resume[0]; i <= seg.resume[1]; i++) out.push({ frame: i, jump: null });
  return out;
}

const pct = (list: number[], p: number) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)].toFixed(3));
};

/** P4/P5: the show at wall-clock 72 Hz through a press, the freeze and the resume; every display frame logged. */
async function cadence(opts: { bundle: string; between?: boolean; freezeS?: number }) {
  const r = await rig(opts.bundle);
  place(r);
  const hz = r.bundle.court.video.displayHz;
  const steps = schedule(r.bundle, !!opts.between, Math.round((opts.freezeS ?? 1) * hz));
  const period = 1000 / hz;
  // the arrival (2.5 s in the show): pass 1's first frame up and drawn, the shaders compiled, the queue full
  for (let k = 0; k < 1.5 * hz; k++) {
    r.video.show(steps[0].frame);
    r.proxies.project(steps[0].frame);
    r.renderer.render(r.scene, r.camera);
    await sleep(period);
  }
  const wrong: { k: number; want: number; on: number }[] = [];
  const cpu: number[] = [];
  const late: number[] = [];
  const t0 = performance.now() + 50;
  for (let k = 0; k < steps.length; k++) {
    const due = t0 + k * period;
    const wait = due - performance.now();
    if (wait <= 0) late.push(-wait);
    await sleep(Math.max(0, wait)); // a browser yields between frames even when late
    const s = performance.now();
    r.video.show(steps[k].frame);
    r.proxies.project(steps[k].frame);
    r.video.prime(steps[k].jump);
    r.renderer.render(r.scene, r.camera);
    cpu.push(performance.now() - s);
    if (r.video.stats.onScreen !== steps[k].frame) wrong.push({ k, want: steps[k].frame, on: r.video.stats.onScreen });
  }
  const st = r.video.stats;
  const out = {
    displayFrames: steps.length, shown: st.shown, held: st.held, heldAt: st.heldAt.slice(0, 20), skipped: st.skipped, dropped: st.dropped,
    startup: st.startup, queueMax: st.queueMax, queueMin: st.queueMin, resets: st.resets, switches: st.switches,
    decodeMs: { p50: pct(st.decodeMs, 0.5), p99: pct(st.decodeMs, 0.99), max: pct(st.decodeMs, 1) },
    uploadMs: { p50: pct(st.uploadMs, 0.5), p99: pct(st.uploadMs, 0.99) },
    frameCpuMs: { p50: pct(cpu, 0.5), p99: pct(cpu, 0.99) }, pacingLateFrames: late.length,
    wrong: wrong.length, wrongAt: wrong.slice(0, 10), errors: st.errors,
  };
  r.video.dispose();
  r.renderer.dispose();
  r.renderer.domElement.remove();
  return out;
}

/** Play the show at 72 Hz until frame F is on screen (through the first ease), the time stop at its end. */
async function toFreeze(r: Rig): Promise<number> {
  const seg = r.bundle.court.video.segments;
  const e = seg.eases[0];
  const steps: number[] = [];
  for (let i = e.start - 72; i <= e.start; i++) steps.push(i);
  for (let i = e.frames[0]; i <= e.frames[1]; i++) steps.push(i);
  for (const f of steps) {
    r.video.show(f);
    r.video.prime(f < e.frames[0] ? e.frames[0] : seg.resume[0]);
    await sleep(1000 / 72);
  }
  for (let k = 0; k < 200 && r.video.stats.onScreen !== e.frames[1]; k++) {
    r.video.show(e.frames[1]);
    await sleep(10);
  }
  r.proxies.project(e.frames[1]);
  r.light.set("ease", e.seconds); // the time stop at the ease's end, as court.ts leaves it on F
  return e.frames[1];
}

/** Stand-ins for the parts stream D doesn't own (the hand-off only needs their hooks; the splats are always drawn here). */
const quiet = { open() {}, reveal() {}, timeStop() {}, release() {}, dim() {} };

/**
 * P8 / P44 renders from the seat: the video layer alone on F, the 3D alone (the freeze splats over F's plate), a mask
 * of the players' cards, the same at head offsets, and the hand-off stepped at 72 Hz (luma per display frame).
 */
async function seat(opts: { bundle: string; offsets?: [number, number][]; sequence?: boolean }) {
  const r = await rig(opts.bundle);
  const spark = new SparkRenderer({ renderer: r.renderer, autoUpdate: false, enableLod: false } as ConstructorParameters<typeof SparkRenderer>[0]);
  r.scene.add(spark);
  const splats: SplatMesh[] = [];
  for (const p of r.bundle.court.freeze.players) {
    const m = new SplatMesh({ url: r.bundle.file(p.splats) });
    await m.initialized;
    r.scene.add(m);
    splats.push(m);
  }
  const fIndex = await toFreeze(r);
  const draw = async () => {
    r.scene.updateMatrixWorld(true);
    await spark.update({ scene: r.scene, camera: r.camera });
    r.renderer.render(r.scene, r.camera);
  };
  const isPairCard = (m: THREE.Mesh) => m.name.startsWith("proxy-card-") && !!(m.material as THREE.ShaderMaterial).uniforms.uHasDepth?.value;
  /** One render: the video layer at `opacity` (1 = alone, 0 = the 3D alone), or a coverage pass on a clear background. */
  const pass = async (opacity: number, splatsOn: boolean, only?: (m: THREE.Mesh) => boolean, mask = 1) => {
    r.video.opacity = opacity;
    r.video.mask(mask); // 1 lifted: no dark outside the frame; 0 the watch's
    splats.forEach((s) => (s.visible = splatsOn));
    const meshes = r.proxies.group.children as THREE.Mesh[];
    const was = meshes.map((m) => m.visible);
    if (only) meshes.forEach((m) => (m.visible = m.visible && only(m)));
    r.renderer.setClearColor(0x000000, only ? 0 : 1);
    await draw();
    const img = read(r);
    meshes.forEach((m, k) => (m.visible = was[k]));
    r.renderer.setClearColor(0x000000, 1);
    r.video.opacity = 1;
    return img;
  };
  const ball = r.bundle.court.freeze.ball;
  const views: Record<string, { video: string; d3: string; mask: string; pair: string; splat: string; ball: [number, number, number]; watch: string }> = {};
  const poses: Record<string, { eye: number[]; q: [number, number, number, number]; focal: number }> = {};
  for (const off of [...(opts.offsets ?? [[0, 0]]), "F"] as ([number, number] | "F")[]) {
    if (off === "F") placeAtF(r, fIndex);
    else place(r, off);
    r.proxies.project(fIndex);
    // the ball's disc in this view (the 3D ball is stream E's: left out of the comparison)
    const c = new THREE.Vector3(...ball.centre).project(r.camera);
    const edge = new THREE.Vector3(...ball.centre).add(new THREE.Vector3(0, ball.radius, 0)).project(r.camera);
    const bpx: [number, number, number] = [(c.x * 0.5 + 0.5) * W, (0.5 - c.y * 0.5) * H, Math.abs(edge.y - c.y) * 0.5 * H];
    poses[off === "F" ? "F" : `${off[0]},${off[1]}`] = { eye: r.camera.position.toArray(), q: r.camera.quaternion.toArray() as [number, number, number, number], focal: H / 2 / Math.tan((r.camera.fov * Math.PI) / 360) };
    views[off === "F" ? "F" : `${off[0]},${off[1]}`] = {
      video: await pass(1, false),
      d3: await pass(0, true),
      mask: await pass(1, false, (m) => m.name.startsWith("proxy-card-")),
      pair: await pass(1, false, isPairCard),
      splat: await pass(1, true, () => false),
      ball: bpx,
      watch: await pass(1, true, undefined, 0),
    };
  }
  // the silhouettes again, zoomed onto the pair (2560 x 1600 over 30 deg: ~3x the Quest's px/deg), so a twentieth of a
  // degree is several pixels
  const zoom: Record<string, { pair: string; splat: string; ball: [number, number, number]; eye: number[]; q: [number, number, number, number]; focal: number }> = {};
  r.renderer.setSize(ZW, ZH);
  for (const off of [...(opts.offsets ?? [[0, 0]]), "F"] as ([number, number] | "F")[]) {
    if (off === "F") placeAtF(r, fIndex);
    else {
      place(r, off);
      r.camera.fov = ZOOM_FOV;
    }
    r.camera.aspect = ZW / ZH;
    r.camera.updateProjectionMatrix();
    r.proxies.project(fIndex);
    const c = new THREE.Vector3(...ball.centre).project(r.camera);
    const edge = new THREE.Vector3(...ball.centre).add(new THREE.Vector3(0, ball.radius, 0)).project(r.camera);
    zoom[off === "F" ? "F" : `${off[0]},${off[1]}`] = {
      pair: await pass(1, false, isPairCard),
      splat: await pass(1, true, () => false),
      ball: [(c.x * 0.5 + 0.5) * ZW, (0.5 - c.y * 0.5) * ZH, Math.abs(edge.y - c.y) * 0.5 * ZH],
      eye: r.camera.position.toArray(),
      q: r.camera.quaternion.toArray() as [number, number, number, number],
      focal: ZH / 2 / Math.tan((r.camera.fov * Math.PI) / 360),
    };
  }
  r.renderer.setSize(W, H);
  r.camera.aspect = W / H;
  r.camera.updateProjectionMatrix();
  // the hand-off at 72 Hz from the seat: mean luma and per-pixel luma steps between display frames
  let sequence: { t: number; meanLuma: number; maxStep: number; p99Step: number; p999Step: number }[] = [];
  if (opts.sequence) {
    place(r);
    r.proxies.project(fIndex);
    splats.forEach((s) => (s.visible = true));
    const parts = { video: r.video, proxies: r.proxies, world: quiet, freeze: quiet, sound: quiet, light: r.light } as unknown as HandoffParts;
    // the ball's and the other people's 3D are stream E's (not drawn here): their pixels are left out of the steps
    const seatView = views["0,0"];
    const others = Uint8Array.from(atob(seatView.mask), (c) => c.charCodeAt(0));
    const pairCov = Uint8Array.from(atob(seatView.pair), (c) => c.charCodeAt(0));
    const ignore = new Uint8Array(W * H);
    const [bx, by, br] = seatView.ball;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (Math.hypot(x - bx, y - by) < br * 1.8 + 3) ignore[i] = 1;
        if (others[4 * i + 3] > 8 && pairCov[4 * i + 3] <= 8)
          for (let dy = -6; dy <= 6; dy++)
            for (let dx = -6; dx <= 6; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < W && yy < H) ignore[yy * W + xx] = 1;
            }
      }
    const counted = ignore.reduce((n, v) => n + (v ? 0 : 1), 0);
    let prev: Float32Array | null = null;
    const px = new Uint8Array(W * H * 4);
    for (let k = -7; k <= Math.round(HANDOFF_END * 72); k++) {
      const t = k / 72;
      handoff(Math.max(0, t), parts); // on F from the start (the frames before it are the ease's)
      await draw();
      r.gl.readPixels(0, 0, W, H, r.gl.RGBA, r.gl.UNSIGNED_BYTE, px);
      const luma = new Float32Array(W * H);
      let sum = 0;
      for (let i = 0; i < W * H; i++) {
        luma[i] = 0.2126 * px[4 * i] + 0.7152 * px[4 * i + 1] + 0.0722 * px[4 * i + 2];
        sum += luma[i];
      }
      let maxStep = 0;
      const steps: number[] = [];
      if (prev) {
        const hist = new Uint32Array(256);
        for (let i = 0; i < W * H; i++) {
          if (ignore[i]) continue;
          const d = Math.abs(luma[i] - prev[i]);
          if (d > maxStep) maxStep = d;
          hist[Math.min(255, Math.floor(d * 4))]++;
        }
        // p99 and p99.9 from a quarter-level histogram
        const at = (p: number) => {
          let n = 0;
          for (let b = 0; b < 256; b++) if ((n += hist[b]) >= p * counted) return b / 4;
          return 63.75;
        };
        steps.push(at(0.99), at(0.999));
      }
      sequence.push({ t: Number(t.toFixed(4)), meanLuma: Number((sum / (W * H)).toFixed(3)), maxStep: Number(maxStep.toFixed(2)), p99Step: steps[0] ?? 0, p999Step: steps[1] ?? 0 });
      prev = luma;
    }
  }
  const camF = cameraOf(r.bundle.court, r.bundle.frames[fIndex]);
  const ppdF = ((H / 2) * (camF.f / (camF.height / 2)) * Math.PI) / 180; // camera F's own view: H rows over 2 atan(height/2f)
  const zoomPpd = ((ZH / 2 / Math.tan((ZOOM_FOV * Math.PI) / 360)) * Math.PI) / 180;
  // what the pair's cards were drawn with (the report shows it: depth on, its weight, its box)
  const cards = (r.proxies.group.children as THREE.Mesh[]).filter((m) => m.name.startsWith("proxy-card-") && m.visible).map((m) => {
    const u = (m.material as THREE.ShaderMaterial).uniforms;
    return { name: m.name, hasDepth: u.uHasDepth.value, depthP: u.uDepthP.value, ref: u.uDepthRef.value, at: (u.uAt.value as THREE.Vector3).toArray() };
  });
  return { width: W, height: H, ppd: PPD, ppdF, fovY: FOV_Y, fIndex, eye: seatEye(r.bundle), views, poses, sequence, zoom, zoomSize: [ZW, ZH], zoomPpd, cards };
}

/**
 * P43 renders from the seat at show frame `frame`: the video layer, its plates alone, its cards' coverage alone (the
 * truth to compare with comes from standin.mjs's renderer in node, from the same eye).
 */
async function layers(opts: { bundle: string; frames: number[] }) {
  const r = await rig(opts.bundle);
  const seg = r.bundle.court.video.segments;
  const out: Record<string, { video: string; plates: string; cards: string }> = {};
  const s = place(r);
  let i = seg.pass2[0];
  for (const want of [...opts.frames].sort((a, b) => a - b)) {
    // play to the frame at 72 Hz (the decoder runs as it would)
    for (; i <= want; i++) {
      r.video.show(i);
      await sleep(1000 / 72);
    }
    for (let k = 0; k < 100 && r.video.stats.onScreen !== want; k++) {
      r.video.show(want);
      await sleep(10);
    }
    r.proxies.project(want);
    r.video.mask(1); // lifted: the plates compared outside the frame too
    const pass = (show: (m: THREE.Mesh) => boolean, clearAlpha: number) => {
      const meshes = r.proxies.group.children as THREE.Mesh[];
      const was = meshes.map((m) => m.visible);
      meshes.forEach((m) => (m.visible = m.visible && show(m)));
      r.renderer.setClearColor(0x000000, clearAlpha);
      r.renderer.render(r.scene, r.camera);
      const img = read(r);
      meshes.forEach((m, k) => (m.visible = was[k]));
      r.renderer.setClearColor(0x000000, 1);
      return img;
    };
    out[want] = {
      video: pass(() => true, 1),
      plates: pass((m) => !m.name.startsWith("proxy-card-"), 1),
      cards: pass((m) => m.name.startsWith("proxy-card-"), 0),
    };
  }
  return { width: W, height: H, ppd: PPD, eye: s.eye, q: s.q, focal: FOCAL, frames: opts.frames, views: out, src: opts.frames.map((f) => r.bundle.frames[f].src) };
}

declare global {
  interface Window {
    __d?: { ready: boolean; cadence: typeof cadence; seat: typeof seat; layers: typeof layers };
  }
}
window.__d = { ready: true, cadence, seat, layers };
