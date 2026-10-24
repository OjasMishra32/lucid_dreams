import * as THREE from "three";

// Keeps something where you put it in your real room: a WebXR anchor at its pose, read back every frame, so a headset
// recenter or tracking drift never slides it across your table. Without anchor support it stays put in the reference
// space, as before. The object's parent must be the scene (its local pose is its world pose).

export class WorldLock {
  private anchor: XRAnchor | null = null;
  private asked = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private obj: THREE.Object3D,
  ) {}

  /** Pin the object where it stands now. Call inside the frame loop, right after placing or moving it. */
  lock() {
    this.release();
    const frame = this.renderer.xr.getFrame();
    const space = this.renderer.xr.getReferenceSpace();
    if (!frame?.createAnchor || !space) return;
    const id = this.asked;
    const p = this.obj.position;
    const q = this.obj.quaternion;
    frame
      .createAnchor(new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w }), space)
      ?.then((a) => {
        if (id === this.asked) this.anchor = a;
        else a.delete();
      })
      .catch(() => {}); // no anchors here: it stays put in the reference space
  }

  /** Stop following the anchor (before moving the object by hand). */
  release() {
    this.asked++;
    this.anchor?.delete();
    this.anchor = null;
  }

  /** Once a frame while presenting: the object goes back to where the room says it is. */
  update() {
    const frame = this.renderer.xr.getFrame();
    const space = this.renderer.xr.getReferenceSpace();
    if (!this.anchor || !frame || !space || (frame.trackedAnchors && !frame.trackedAnchors.has(this.anchor))) return;
    const pose = frame.getPose(this.anchor.anchorSpace, space);
    if (!pose) return;
    const { position: p, orientation: o } = pose.transform;
    this.obj.position.set(p.x, p.y, p.z);
    this.obj.quaternion.set(o.x, o.y, o.z, o.w);
  }
}
