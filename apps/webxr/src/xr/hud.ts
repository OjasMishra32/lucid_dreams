import * as THREE from "three";
import type { HandMenu } from "./menu";
import type { QualityGovernor } from "./quality";

// Small cards that stay in the middle of your view in the room, following it loosely (a little behind, so they never
// shake with your head): the first-time hint on how the controls work (the competition build, event.ts), and ?fps=1's
// frame-rate readout for checking a scene on the headset itself.

const FONT = '-apple-system, "SF Pro Text", "Inter", sans-serif';
const _head = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _to = new THREE.Vector3();

/** A card `dist` ahead of the eyes and `down` radians under where they look, eased toward it (snap: put it there). */
function followView(mesh: THREE.Object3D, camera: THREE.Camera, dist: number, down: number, dt: number, snap: boolean) {
  camera.getWorldPosition(_head);
  camera.getWorldQuaternion(_q);
  _dir.set(0, 0, -1).applyQuaternion(_q);
  _right.set(1, 0, 0).applyQuaternion(_q);
  _dir.applyAxisAngle(_right, -down);
  _to.copy(_head).addScaledVector(_dir, dist);
  if (snap) mesh.position.copy(_to);
  else mesh.position.lerp(_to, Math.min(1, dt * 3));
  mesh.lookAt(_head);
}

function card(w: number, h: number, px: [number, number]) {
  const canvas = document.createElement("canvas");
  [canvas.width, canvas.height] = px;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  // drawn over everything (a person or the board in front of it never hides it), and never in the depth buffer
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
  mesh.renderOrder = 20;
  mesh.visible = false;
  return { canvas, tex, mesh, ctx: canvas.getContext("2d")! };
}

const SEEN = "lucid.onboarded";
const HINT_MS = 10000;

/**
 * The first time someone enters the room (once a tab's session): "Turn your left palm up for the menu. Press with your
 * right index finger." 0.9 m ahead and a little under the middle of the view, about 20 degrees across, gone after the
 * first press on the palm menu or 10 s.
 */
export class PalmHint {
  readonly mesh: THREE.Mesh;
  private from = 0;
  private until = 0;
  private snap = true;

  constructor(parent: THREE.Object3D) {
    const c = card(0.34, 0.085, [1280, 320]);
    this.mesh = c.mesh;
    const g = c.ctx;
    g.fillStyle = "rgba(29,29,31,0.86)";
    g.beginPath();
    g.roundRect(8, 8, 1264, 304, 64);
    g.fill();
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#f5f5f7";
    g.font = `600 66px ${FONT}`;
    g.fillText("Turn your left palm up for the menu.", 640, 120, 1180);
    g.fillStyle = "#a1a1a6";
    g.font = `500 52px ${FONT}`;
    g.fillText("Press with your right index finger.", 640, 215, 1180);
    c.tex.needsUpdate = true;
    parent.add(this.mesh);
  }

  /** Entering the room: on, unless it's been shown before in this tab. */
  start(now: number) {
    let seen = false;
    try {
      seen = sessionStorage.getItem(SEEN) === "1";
      sessionStorage.setItem(SEEN, "1");
    } catch {
      // no storage: shown each time you enter
    }
    if (seen) return;
    this.from = now;
    this.until = now + HINT_MS;
    this.snap = true;
  }

  /** Leaving the room. */
  stop() {
    this.until = 0;
    this.mesh.visible = false;
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
  }

  /** Once a frame in the room. */
  update(camera: THREE.Camera, menu: HandMenu, now: number, dt: number) {
    if (this.until > now && menu.buttons.some((b) => b.pressedAt > this.from)) this.until = now; // they've found it
    const m = this.mesh.material as THREE.MeshBasicMaterial;
    m.opacity += ((now < this.until ? 1 : 0) - m.opacity) * Math.min(1, dt * 6);
    this.mesh.visible = m.opacity > 0.01;
    if (!this.mesh.visible) return;
    followView(this.mesh, camera, 0.9, 0.14, dt, this.snap);
    this.snap = false;
  }
}

/** ?fps=1 */
export const SHOW_FPS = typeof location !== "undefined" && new URLSearchParams(location.search).get("fps") === "1";

/**
 * The frame rate as the headset gets it, redrawn twice a second: the display rate the session runs at, frames per second
 * over the last 2 s, the 95th percentile frame time over the last 10 s, how many frames came late (over 1.25 frame
 * budgets, i.e. a missed refresh) in those 10 s, and the quality governor's level (0 sharpest). Small, low in the middle
 * of the view.
 */
export class FpsReadout {
  readonly mesh: THREE.Mesh;
  private canvas: HTMLCanvasElement;
  private tex: THREE.CanvasTexture;
  private times: number[] = []; // frame timestamps, the last 10 s
  private drawnAt = 0;
  private snap = true;

  constructor(parent: THREE.Object3D) {
    const c = card(0.15, 0.05, [600, 200]);
    this.mesh = c.mesh;
    this.canvas = c.canvas;
    this.tex = c.tex;
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    parent.add(this.mesh);
  }

  /** Once per rendered frame in the room; `on` false hides it (outside the room). */
  frame(now: number, governor: QualityGovernor, session: XRSession | null, camera: THREE.Camera, dt: number, on: boolean) {
    this.mesh.visible = on;
    if (!on) {
      this.times.length = 0;
      this.snap = true;
      return;
    }
    this.times.push(now);
    while (this.times.length && now - this.times[0] > 10000) this.times.shift();
    followView(this.mesh, camera, 0.75, 0.28, dt, this.snap);
    this.snap = false;
    if (now - this.drawnAt < 500) return;
    this.drawnAt = now;
    const t = this.times;
    const rate = (session as (XRSession & { frameRate?: number }) | null)?.frameRate ?? governor.target;
    let n2 = 0;
    for (let i = t.length - 1; i > 0 && now - t[i] <= 2000; i--) n2++;
    const span2 = n2 ? now - t[t.length - 1 - n2] : 0;
    const fps = span2 > 0 ? (n2 * 1000) / span2 : 0;
    const gaps = t.slice(1).map((x, i) => x - t[i]);
    const sorted = [...gaps].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    const budget = 1000 / (rate || 72);
    const late = gaps.length ? gaps.filter((g) => g > budget * 1.25).length / gaps.length : 0;
    const g = this.canvas.getContext("2d")!;
    g.clearRect(0, 0, 600, 200);
    g.fillStyle = "rgba(0,0,0,0.72)";
    g.beginPath();
    g.roundRect(4, 4, 592, 192, 36);
    g.fill();
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillStyle = fps >= rate * 0.97 ? "#30d158" : fps >= 60 ? "#ffd60a" : "#ff453a";
    g.font = `600 58px ${FONT}`;
    g.fillText(`${fps.toFixed(1)} fps`, 30, 64);
    g.fillStyle = "#a1a1a6";
    g.font = `500 40px ${FONT}`;
    g.fillText(`/ ${Math.round(rate)} Hz`, 330, 66);
    g.fillStyle = "#f5f5f7";
    g.font = `500 38px ${FONT}`;
    g.fillText(`p95 ${p95.toFixed(1)} ms · ${(late * 100).toFixed(1)}% late · level ${governor.level}`, 30, 142, 540);
    this.tex.needsUpdate = true;
  }
}
