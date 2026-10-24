import * as THREE from "three";
import { blobShadow } from "./court";
import { type Ball, BALL_R } from "./physics";

// What you see of the ball: optic-yellow felt with its white seam, turning with its spin, a soft shadow on the grass
// (darker and tighter as it comes down to it), and a faint trail when it's really moving.

/** The felt and the seam, on an equirectangular map: the seam is the classic two-lobed curve on the sphere. */
function feltTexture(): THREE.CanvasTexture {
  const W = 512;
  const H = 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#d4e157";
  g.fillRect(0, 0, W, H);
  let s = 7;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 14000; i++) {
    g.fillStyle = r() < 0.5 ? `rgba(255,255,200,${r() * 0.18})` : `rgba(120,140,20,${r() * 0.16})`;
    g.fillRect(r() * W, r() * H, 1.5, 1.5);
  }
  g.strokeStyle = "rgba(250,250,240,0.95)";
  g.lineWidth = 7;
  g.lineCap = "round";
  const a = 0.78;
  const b = 1 - a;
  let last: [number, number] | null = null;
  for (let i = 0; i <= 720; i++) {
    const t = (i / 720) * Math.PI * 2;
    const x = a * Math.cos(t) + b * Math.cos(3 * t);
    const y = a * Math.sin(t) - b * Math.sin(3 * t);
    const z = 2 * Math.sqrt(a * b) * Math.sin(2 * t);
    const n = Math.hypot(x, y, z);
    const lon = Math.atan2(y / n, x / n);
    const lat = Math.asin(z / n);
    const px = ((lon + Math.PI) / (2 * Math.PI)) * W;
    const py = (0.5 - lat / Math.PI) * H;
    if (last && Math.abs(px - last[0]) < W / 2) {
      g.beginPath();
      g.moveTo(last[0], last[1]);
      g.lineTo(px, py);
      g.stroke();
    }
    last = [px, py];
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const TRAIL = 14;

export class BallView {
  readonly mesh: THREE.Mesh;
  readonly shadow: THREE.Mesh;
  readonly trail: THREE.Mesh;
  private trailPos: THREE.Vector3[] = Array.from({ length: TRAIL }, () => new THREE.Vector3());
  private trailN = 0;
  private alpha = 1;
  private q = new THREE.Quaternion();
  private axis = new THREE.Vector3();
  private mats: THREE.Material[];

  constructor(parent: THREE.Object3D) {
    const mat = new THREE.MeshLambertMaterial({ map: feltTexture(), transparent: true, emissive: 0x1c2008 });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 22, 16), mat);
    this.shadow = blobShadow(0.16, 0.55);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL * 2 * 3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(TRAIL * 2 * 4), 4));
    const idx: number[] = [];
    for (let i = 0; i < TRAIL - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    this.trail = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 11;
    parent.add(this.mesh, this.shadow, this.trail);
    this.mats = [mat, this.shadow.material as THREE.Material];
  }

  /** Fade the ball in or out (between points); 0 hides it. */
  setAlpha(a: number) {
    this.alpha = a;
    for (const m of this.mats) (m as THREE.MeshBasicMaterial).opacity = a;
    this.mesh.visible = this.shadow.visible = a > 0.01;
    if (a < 0.01) this.trailN = 0;
  }

  /** Once a frame: where the ball is (court space), its spin, and where your eyes are (court space). */
  update(b: Ball, dt: number, eye: THREE.Vector3) {
    this.mesh.position.copy(b.p);
    const ws = b.w.length();
    if (ws > 0.1) {
      this.q.setFromAxisAngle(this.axis.copy(b.w).divideScalar(ws), ws * dt);
      this.mesh.quaternion.premultiply(this.q);
    }
    const up = Math.max(0, b.p.y - BALL_R);
    this.shadow.position.set(b.p.x, 0.004, b.p.z);
    this.shadow.scale.setScalar(0.5 + up * 0.35);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = this.alpha * THREE.MathUtils.clamp(1 - up / 6, 0.15, 1);

    // the trail: the last few positions, a ribbon turned to your eyes, fading toward its tail
    const speed = b.v.length();
    if (this.trailN === 0 || this.trailPos[0].distanceTo(b.p) > 0.002) {
      for (let i = TRAIL - 1; i > 0; i--) this.trailPos[i].copy(this.trailPos[i - 1]);
      this.trailPos[0].copy(b.p);
      this.trailN = Math.min(TRAIL, this.trailN + 1);
    }
    const strength = this.alpha * THREE.MathUtils.clamp((speed - 9) / 14, 0, 1) * 0.5;
    this.trail.visible = strength > 0.01 && this.trailN > 3;
    if (!this.trail.visible) return;
    const pos = this.trail.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.trail.geometry.attributes.color as THREE.BufferAttribute;
    const side = new THREE.Vector3();
    const toEye = new THREE.Vector3();
    const tan = new THREE.Vector3();
    for (let i = 0; i < TRAIL; i++) {
      const k = Math.min(i, this.trailN - 1);
      const p = this.trailPos[k];
      tan.subVectors(this.trailPos[Math.max(0, k - 1)], this.trailPos[Math.min(this.trailN - 1, k + 1)]);
      toEye.subVectors(eye, p);
      side.crossVectors(tan, toEye).normalize();
      const u = i / (TRAIL - 1);
      const wdt = BALL_R * 0.85 * (1 - u);
      pos.setXYZ(i * 2, p.x + side.x * wdt, p.y + side.y * wdt, p.z + side.z * wdt);
      pos.setXYZ(i * 2 + 1, p.x - side.x * wdt, p.y - side.y * wdt, p.z - side.z * wdt);
      const a = strength * (1 - u) * (1 - u);
      col.setXYZW(i * 2, 0.95, 1, 0.75, a);
      col.setXYZW(i * 2 + 1, 0.95, 1, 0.75, a);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }
}
