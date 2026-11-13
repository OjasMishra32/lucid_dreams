import * as THREE from "three";

/**
 * Field-of-view help: when what you came for (the person, the board) has been more than 50 degrees off where you're
 * looking for 2 s, a small chevron appears 12 cm off the centre of your view, 60 cm out, pointing the way back. It goes
 * once they're back within 35 degrees. It sits well inside the narrowest Quest field of view, never at its edges.
 */
const SHOW_DEG = 50;
const HIDE_DEG = 35;
const WAIT_S = 2;

export class LookBack {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private away = 0;
  private shown = false;
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly inv = new THREE.Quaternion();
  private readonly to = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly spin = new THREE.Quaternion();
  private static readonly Z = new THREE.Vector3(0, 0, 1);

  constructor(scene: THREE.Scene) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    g.fillStyle = "rgba(10,10,12,0.55)";
    g.beginPath();
    g.arc(64, 64, 60, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#f5f5f7";
    g.lineWidth = 11;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath(); // a chevron pointing to +x
    g.moveTo(50, 34);
    g.lineTo(80, 64);
    g.lineTo(50, 94);
    g.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.045, 0.045),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
    );
    this.mesh.renderOrder = 1000;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Once a frame in the room: `camera` the headset's, `target` what you should be able to find (null: nothing). */
  update(camera: THREE.Camera, target: THREE.Vector3 | null, dt: number) {
    const m = this.mesh.material;
    if (!target) {
      this.away = 0;
      this.shown = false;
    } else {
      camera.getWorldPosition(this.pos);
      camera.getWorldQuaternion(this.quat);
      this.fwd.set(0, 0, -1).applyQuaternion(this.quat);
      this.to.copy(target).sub(this.pos).normalize();
      const deg = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(this.fwd.dot(this.to), -1, 1)));
      this.away = deg > SHOW_DEG ? this.away + dt : 0;
      if (this.away > WAIT_S) this.shown = true;
      if (deg < HIDE_DEG) this.shown = false;
      if (this.shown || m.opacity > 0.01) {
        // which way on the view plane: the target in the head's own frame, x right and y up
        this.inv.copy(this.quat).invert();
        const local = this.to.clone().applyQuaternion(this.inv);
        let dx = local.x;
        let dy = local.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-3) {
          dx = 1; // straight behind you: point to your right
          dy = 0;
        } else {
          dx /= len;
          dy /= len;
        }
        this.mesh.position.set(dx * 0.12, dy * 0.12, -0.6).applyQuaternion(this.quat).add(this.pos);
        this.spin.setFromAxisAngle(LookBack.Z, Math.atan2(dy, dx));
        this.mesh.quaternion.copy(this.quat).multiply(this.spin);
      }
    }
    m.opacity += ((this.shown ? 0.95 : 0) - m.opacity) * Math.min(1, dt * 6);
    this.mesh.visible = m.opacity > 0.01;
  }

  hide() {
    this.away = 0;
    this.shown = false;
    this.mesh.material.opacity = 0;
    this.mesh.visible = false;
  }
}
