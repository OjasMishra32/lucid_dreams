import * as THREE from "three";

// Keeps something where you put it in your real room: a WebXR anchor at its pose, read back every frame, so a headset
// recenter or tracking drift never slides it across your table. Without anchor support it stays put in the reference
// space, as before. The object's parent must be the scene (its local pose is its world pose).
//
// Given a name, it's also kept from one session to the next where the browser can (Quest Browser's persistent anchors:
// a handle saved in this browser's localStorage): restore() finds it again in the room. Elsewhere it quietly isn't.

type Persistent = XRAnchor & { requestPersistentHandle?: () => Promise<string> };
type PersistentSession = XRSession & { restorePersistentAnchor?: (handle: string) => Promise<XRAnchor>; deletePersistentAnchor?: (handle: string) => Promise<void> };

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // no storage: it's kept for this session only
    }
  },
};

export class WorldLock {
  private anchor: XRAnchor | null = null;
  private asked = 0;
  /** True while an anchor kept from an earlier session is being found again (restore). */
  restoring = false;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private obj: THREE.Object3D,
    private keep?: string, // a name to keep it under between sessions
  ) {}

  /** It has an anchor (it may not be tracked yet). */
  get anchored() {
    return !!this.anchor;
  }

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
        if (id === this.asked) {
          this.anchor = a;
          void this.save(a);
        } else a.delete();
      })
      .catch(() => {}); // no anchors here: it stays put in the reference space
  }

  /** Stop following the anchor (before moving the object by hand). */
  release() {
    this.asked++;
    this.anchor?.delete();
    this.anchor = null;
  }

  /**
   * Once a frame while presenting: the object goes back to where the room says it is. True when it did (the anchor
   * is tracked this frame).
   */
  update(): boolean {
    const frame = this.renderer.xr.getFrame();
    const space = this.renderer.xr.getReferenceSpace();
    if (!this.anchor || !frame || !space || (frame.trackedAnchors && !frame.trackedAnchors.has(this.anchor))) return false;
    const pose = frame.getPose(this.anchor.anchorSpace, space);
    if (!pose) return false;
    const { position: p, orientation: o } = pose.transform;
    this.obj.position.set(p.x, p.y, p.z);
    this.obj.quaternion.set(o.x, o.y, o.z, o.w);
    return true;
  }

  /** At the start of a session: the anchor kept last time, found again in the room (true), or none (false). */
  async restore(): Promise<boolean> {
    const session = this.renderer.xr.getSession() as PersistentSession | null;
    const handle = this.keep ? store.get(this.keep) : null;
    if (!session?.restorePersistentAnchor || !handle) return false;
    const id = ++this.asked;
    this.restoring = true;
    try {
      const a = await session.restorePersistentAnchor(handle);
      if (id !== this.asked) {
        a.delete(); // placed by hand meanwhile
        return false;
      }
      this.anchor = a;
      return true;
    } catch {
      store.set(this.keep!, null); // gone from this headset (cleared, or another room)
      return false;
    } finally {
      this.restoring = false;
    }
  }

  /** Keep this anchor for next time, in place of the one kept before. */
  private async save(a: Persistent) {
    if (!this.keep || !a.requestPersistentHandle) return;
    try {
      const handle = await a.requestPersistentHandle();
      const old = store.get(this.keep);
      store.set(this.keep, handle);
      if (old && old !== handle) await (this.renderer.xr.getSession() as PersistentSession | null)?.deletePersistentAnchor?.(old);
    } catch {
      // not kept: next session it's placed afresh
    }
  }
}
