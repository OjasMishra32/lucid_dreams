import * as THREE from "three";

// Hands-only XR, shared by the viewer and chess: buttons you press by pushing a fingertip through them, and
// depth-only stand-ins that keep your real hands in front of virtual things in passthrough.

/** Index fingertips of both hands in world space, or null for a hand that isn't tracked. */
export function fingertips(hands: THREE.Object3D[]): (THREE.Vector3 | null)[] {
  return hands.map((h) => {
    const t = (h as unknown as { joints: Record<string, THREE.Object3D> }).joints?.["index-finger-tip"];
    return t && t.visible ? t.getWorldPosition(new THREE.Vector3()) : null;
  });
}

const FINGER_CHAINS = [
  ["wrist", "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
  ...["index-finger", "middle-finger", "ring-finger", "pinky-finger"].map((f) =>
    ["wrist", `${f}-metacarpal`, `${f}-phalanx-proximal`, `${f}-phalanx-intermediate`, `${f}-phalanx-distal`, `${f}-tip`]),
];

/**
 * Invisible, depth-only stand-ins for a tracked hand (a capsule per finger bone), drawn before everything else, so
 * your real fingers in passthrough stay in front of a piece you reach behind. Returns the per-frame update.
 */
export function handOccluder(hand: THREE.Object3D, scene: THREE.Scene): () => void {
  const mat = new THREE.MeshBasicMaterial({ colorWrite: false });
  const unitBone = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
  const unitJoint = new THREE.SphereGeometry(1, 10, 8);
  const group = new THREE.Group();
  group.visible = false; // shown only while the hand is tracked (unit-size stand-ins would hide the board)
  scene.add(group);
  const bones = FINGER_CHAINS.flatMap((c) => c.slice(1).map((name, k) => [c[k], name] as const));
  const boneMeshes = bones.map(() => new THREE.Mesh(unitBone, mat));
  const jointNames = [...new Set(FINGER_CHAINS.flat())];
  const jointMeshes = jointNames.map(() => new THREE.Mesh(unitJoint, mat));
  [...boneMeshes, ...jointMeshes].forEach((m) => {
    m.renderOrder = -1;
    group.add(m);
  });
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const radius = (j: THREE.Object3D) => Math.max(0.006, (j as unknown as { jointRadius?: number }).jointRadius ?? 0.008);
  return () => {
    const joints = (hand as unknown as { joints: Record<string, THREE.Object3D> }).joints ?? {};
    const tracked = joints.wrist?.visible === true;
    group.visible = tracked;
    if (!tracked) return;
    jointNames.forEach((n, k) => {
      const j = joints[n];
      const m = jointMeshes[k];
      m.visible = !!j?.visible;
      if (!m.visible) return;
      j.getWorldPosition(m.position);
      m.scale.setScalar(radius(j));
    });
    bones.forEach(([from, to], k) => {
      const ja = joints[from];
      const jb = joints[to];
      const m = boneMeshes[k];
      m.visible = !!(ja?.visible && jb?.visible);
      if (!m.visible) return;
      ja.getWorldPosition(a);
      jb.getWorldPosition(b);
      const len = a.distanceTo(b);
      const r = Math.min(radius(ja), radius(jb));
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(up, b.sub(a).normalize());
      m.scale.set(r, len, r);
    });
  };
}

/** A soft, glassy button floating over the table. Pressed by pushing an index fingertip through it. */
export class XrButton {
  mesh: THREE.Mesh;
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;
  private pressedUntil = 0;
  private cooldownUntil = 0;
  private wasInside = [false, false];
  private on = false;
  private local = new THREE.Vector3();
  constructor(
    public id: string,
    private label: string,
    private onPress: () => void,
  ) {
    this.canvas.width = 512;
    this.canvas.height = 160;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8; // stays sharp seen at an angle (a palm menu always is)
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.028), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.draw(false);
  }
  setLabel(label: string) {
    this.label = label;
    this.draw(false);
  }
  /** A toggle's state: an "on" button stays blue, the way a selected control does on the web. */
  setOn(on: boolean) {
    this.on = on;
    this.draw(false);
  }
  private hover = false;
  private draw(pressed: boolean) {
    const c = this.canvas.getContext("2d")!;
    c.clearRect(0, 0, 512, 160);
    c.fillStyle = pressed || this.on ? "rgba(0,113,227,0.95)" : this.hover ? "rgba(99,99,102,0.92)" : "rgba(44,44,46,0.82)";
    c.beginPath();
    c.roundRect(6, 6, 500, 148, 74);
    c.fill();
    c.fillStyle = "#f5f5f7";
    let size = 58;
    do c.font = `600 ${size}px -apple-system, "SF Pro Text", "Inter", sans-serif`;
    while (c.measureText(this.label).width > 450 && (size -= 3) > 30); // a long label gets smaller, never cut off
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(this.label, 256, 84);
    this.tex.needsUpdate = true;
  }
  /** Both index fingertips in world space (null when not tracked). Fires once each time a tip pushes into the face. */
  touch(fingertips: (THREE.Vector3 | null)[], now: number) {
    if (!this.mesh.visible) return;
    let hover = false;
    fingertips.forEach((tip, h) => {
      let inside = false;
      if (tip) {
        this.local.copy(tip);
        this.mesh.worldToLocal(this.local);
        const over = Math.abs(this.local.x) < 0.045 && Math.abs(this.local.y) < 0.014;
        inside = over && this.local.z < 0.004 && this.local.z > -0.02;
        hover ||= over && this.local.z >= 0.004 && this.local.z < 0.04; // a fingertip just in front: it lights up
      }
      if (inside && !this.wasInside[h] && now > this.cooldownUntil) {
        this.cooldownUntil = now + 300;
        this.pressedUntil = now + 180;
        this.draw(true);
        this.onPress();
      }
      this.wasInside[h] = inside;
    });
    if (hover !== this.hover) {
      this.hover = hover;
      if (!this.pressedUntil) this.draw(false);
    }
    if (this.pressedUntil && now > this.pressedUntil) {
      this.pressedUntil = 0;
      this.draw(false);
    }
  }
}
