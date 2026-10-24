import * as THREE from "three";

// Your hands on the court. In the full venue the headset's passthrough is covered, so your tracked hands are drawn:
// a soft light-grey sphere at each joint and a capsule along each bone (two instanced draws for both hands). In your
// room they turn into depth-only stand-ins, so your real hands (seen through passthrough) stay in front of the court.

const CHAINS = [
  ["wrist", "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
  ...["index-finger", "middle-finger", "ring-finger", "pinky-finger"].map((f) => ["wrist", `${f}-metacarpal`, `${f}-phalanx-proximal`, `${f}-phalanx-intermediate`, `${f}-phalanx-distal`, `${f}-tip`]),
];
const JOINTS = [...new Set(CHAINS.flat())];
const BONES = CHAINS.flatMap((c) => c.slice(1).map((n, k) => [c[k], n] as const));

export class HandsView {
  private joints: THREE.InstancedMesh;
  private bones: THREE.InstancedMesh;
  private mat: THREE.MeshLambertMaterial;
  private m = new THREE.Matrix4();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(
    scene: THREE.Scene,
    private hands: THREE.Object3D[],
  ) {
    this.mat = new THREE.MeshLambertMaterial({ color: 0xdedfe3, emissive: 0x2a2a2e });
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), this.mat, JOINTS.length * 2);
    this.bones = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), this.mat, BONES.length * 2);
    for (const m of [this.joints, this.bones]) {
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
    }
  }

  /** In your room: depth only (your real hands show through); on the court: drawn. */
  setRoom(room: boolean) {
    this.mat.colorWrite = !room;
    this.joints.renderOrder = this.bones.renderOrder = room ? -1 : 0;
    this.mat.needsUpdate = true;
  }

  update() {
    let nj = 0;
    let nb = 0;
    for (const h of this.hands) {
      const joints = (h as unknown as { joints?: Record<string, THREE.Object3D & { jointRadius?: number }> }).joints ?? {};
      if (!h.visible || !joints.wrist?.visible) continue; // tracking lost: three hides the hand, not its joints
      const r = (n: string) => Math.max(0.006, joints[n]?.jointRadius ?? 0.008);
      for (const n of JOINTS) {
        const j = joints[n];
        if (!j?.visible) continue;
        j.getWorldPosition(this.a);
        this.m.compose(this.a, this.q.identity(), this.s.setScalar(r(n)));
        this.joints.setMatrixAt(nj++, this.m);
      }
      for (const [x, y] of BONES) {
        const ja = joints[x];
        const jb = joints[y];
        if (!ja?.visible || !jb?.visible) continue;
        ja.getWorldPosition(this.a);
        jb.getWorldPosition(this.b);
        const len = this.a.distanceTo(this.b);
        const rad = Math.min(r(x), r(y)) * 0.92;
        this.q.setFromUnitVectors(this.up, this.b.clone().sub(this.a).normalize());
        this.m.compose(this.a.add(this.b).multiplyScalar(0.5), this.q, this.s.set(rad, len, rad));
        this.bones.setMatrixAt(nb++, this.m);
      }
    }
    this.joints.count = nj;
    this.bones.count = nb;
    this.joints.instanceMatrix.needsUpdate = true;
    this.bones.instanceMatrix.needsUpdate = true;
  }
}
