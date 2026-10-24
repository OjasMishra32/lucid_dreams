import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

// A real chess clock for the table: a dark, minimal two-button clock with a lit time display for each side. Its
// local space is the table's: the "near" half (+z) is the player's, the "far" half the opponent's, and the readouts
// face up, read from the player's chair. The running side's button stands up; pressing it hands the time over.

export type Half = "near" | "far";

const BODY = { x: 0.095, y: 0.034, z: 0.18 };
const HALF_Z = 0.045; // each half's centre along z
const BUTTON = { x: 0.028, y: 0.012, z: 0.05, at: 0.031 };
const UP = 0.0065; // how far a standing button rises above a pressed one

export class ChessClock {
  readonly group = new THREE.Group();
  time: Record<Half, number>;
  running: Half | null = null;
  flagged: Half | null = null;
  onFlag: ((h: Half) => void) | null = null;
  /** Your button glows softly while it's waiting for you to press it. */
  prompt = false;
  private buttons: Record<Half, THREE.Mesh>;
  private displays: Record<Half, { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; shown: string }>;
  private wasInside: boolean[] = [];
  private cooldownUntil = 0;
  private local = new THREE.Vector3();
  private glow = 0;
  private phase = 0;

  constructor(private initial = 600) {
    this.time = { near: initial, far: initial };
    const dark = new THREE.MeshPhysicalMaterial({ color: 0x1c1c1e, roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.25 });
    const body = new THREE.Mesh(new RoundedBoxGeometry(BODY.x, BODY.y, BODY.z, 4, 0.009), dark);
    body.position.y = BODY.y / 2;
    this.group.add(body);
    const buttonMat = new THREE.MeshPhysicalMaterial({ color: 0x3a3a3c, roughness: 0.35, clearcoat: 0.8 });
    const buttonGeo = new RoundedBoxGeometry(BUTTON.x, BUTTON.y, BUTTON.z, 3, 0.0045);
    const make = (h: Half) => {
      const sz = h === "near" ? 1 : -1;
      const b = new THREE.Mesh(buttonGeo, h === "near" ? buttonMat.clone() : buttonMat);
      b.position.set(BUTTON.at, BODY.y + BUTTON.y / 2 - 0.004, sz * HALF_Z);
      this.group.add(b);
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 128;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.052, 0.026), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      face.rotation.x = -Math.PI / 2; // facing up, its text upright from the player's chair
      face.position.set(-0.014, BODY.y + 0.0004, sz * HALF_Z);
      this.group.add(face);
      return { b, display: { canvas, tex, shown: "" } };
    };
    const near = make("near");
    const far = make("far");
    this.buttons = { near: near.b, far: far.b };
    this.displays = { near: near.display, far: far.display };
    this.draw();
  }

  reset(seconds = this.initial) {
    this.initial = seconds;
    this.time = { near: seconds, far: seconds };
    this.running = null;
    this.flagged = null;
    this.draw();
  }

  /** Start h's time (the other side's stops). null stops both. */
  run(h: Half | null) {
    if (this.flagged) return;
    this.running = h;
    this.draw();
  }

  /** Seconds elapsed; settles the buttons and flags a side whose time runs out. */
  update(dt: number) {
    const r = this.running;
    if (r && !this.flagged) {
      this.time[r] = Math.max(0, this.time[r] - dt);
      if (this.time[r] === 0) {
        this.flagged = r;
        this.running = null;
        this.onFlag?.(r);
      }
    }
    for (const h of ["near", "far"] as Half[]) {
      const b = this.buttons[h];
      const want = BODY.y + BUTTON.y / 2 - 0.004 + (this.running === null ? UP / 2 : this.running === h ? UP : 0);
      b.position.y += (want - b.position.y) * Math.min(1, dt * 30);
    }
    this.phase += dt;
    this.glow += ((this.prompt ? 1 : 0) - this.glow) * Math.min(1, dt * 6);
    const mat = this.buttons.near.material as THREE.MeshPhysicalMaterial;
    mat.emissive.setRGB(0, 0.44, 0.89).multiplyScalar(this.glow * (0.28 + 0.22 * Math.sin(this.phase * 4)));
    this.draw();
  }

  /** The top of h's button, in the clock's parent space (the table). */
  buttonTop(h: Half): THREE.Vector3 {
    const b = this.buttons[h];
    this.group.updateMatrix();
    return new THREE.Vector3(b.position.x, BODY.y + BUTTON.y - 0.004 + UP, b.position.z).applyMatrix4(this.group.matrix);
  }

  /** World position of the clock, for its sounds. */
  worldPosition(h: Half = "near") {
    return this.buttons[h].getWorldPosition(new THREE.Vector3());
  }

  /** The near button under a ray (the mouse), if any. */
  hitNear(ray: THREE.Raycaster): boolean {
    return ray.intersectObject(this.buttons.near, false).length > 0;
  }

  /** Points in world space (fingertips, a palm, a piece in your hand): true once each time one comes down onto the
   * near button. The zone is a little bigger than the button: you hit a clock, you don't aim at it. */
  touch(points: (THREE.Vector3 | null)[], nowMs: number): boolean {
    let pressed = false;
    points.forEach((tip, i) => {
      let inside = false;
      if (tip) {
        this.local.copy(tip);
        this.group.worldToLocal(this.local);
        const b = this.buttons.near.position;
        inside = Math.abs(this.local.x - b.x) < BUTTON.x / 2 + 0.016 && Math.abs(this.local.z - b.z) < BUTTON.z / 2 + 0.014 && this.local.y < BODY.y + BUTTON.y + UP + 0.01 && this.local.y > BODY.y - 0.012;
      }
      if (inside && !this.wasInside[i] && nowMs > this.cooldownUntil) {
        this.cooldownUntil = nowMs + 350;
        pressed = true;
      }
      this.wasInside[i] = inside;
    });
    return pressed;
  }

  private draw() {
    for (const h of ["near", "far"] as Half[]) {
      const t = this.time[h];
      const text = t >= 60 ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}` : t >= 20 ? `0:${String(Math.floor(t)).padStart(2, "0")}` : t.toFixed(1);
      const state = this.flagged === h ? "flag" : this.running === h ? "on" : "off";
      const key = `${text}|${state}`;
      const d = this.displays[h];
      if (d.shown === key) continue;
      d.shown = key;
      const c = d.canvas.getContext("2d")!;
      c.fillStyle = "#0b0b0c";
      c.fillRect(0, 0, 256, 128);
      c.fillStyle = state === "flag" ? "#ff453a" : state === "on" ? "#f5f5f7" : "#6e6e73";
      c.font = '600 76px "SF Mono", ui-monospace, Menlo, monospace';
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(text, 128, 68);
      if (state === "on") {
        c.fillStyle = "#30d158"; // a small lamp on the running side
        c.beginPath();
        c.arc(18, 22, 7, 0, Math.PI * 2);
        c.fill();
      }
      d.tex.needsUpdate = true;
    }
  }
}
