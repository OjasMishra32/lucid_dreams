import * as THREE from "three";
import type { SparkRenderer } from "@sparkjsdev/spark";

// Spark sorts asynchronously: after a frame it generates the visible splats for that view, reads their depths back from
// the GPU and sorts them in a worker; the new order is uploaded when the worker returns and is first drawn on the next
// display frame. Spark 2.4 has no timing hooks, so this wraps two of its (private) methods on the instance:
// readbackDepth (the GPU readback) and driveSort (one whole sort). Lag = display frames from the frame whose view was
// sorted to the first frame drawn with that order (1 is the minimum for an async sort).

type Internals = {
  driveSort: () => Promise<void>;
  readbackDepth: (args: { current: unknown }) => Promise<unknown>;
  lastSortTime: number;
  activeSplats: number;
  current: { viewOrigin: THREE.Vector3; viewDirection: THREE.Vector3 };
  sortedCenter: THREE.Vector3;
  sortedDir: THREE.Vector3;
};

export type SortRecord = { stage: number; viewFrame: number; doneFrame: number; ms: number; readbackMs: number; lagFrames: number; activeSplats: number };
export type Reveal = { label: string; stage: number; frame: number; want: number; drawnBefore: number; drawnAfterFrames: number | null; firstSort: SortRecord | null };

export class SortWatch {
  frame = 0; // display frames so far
  stage = -1;
  readonly sorts: SortRecord[] = [];
  readonly reveals: Reveal[] = [];
  readonly staleDeg = new Map<number, number[]>();
  readonly staleCm = new Map<number, number[]>();
  private s: Internals;
  private seen: unknown = null;
  private seenOrigin = new THREE.Vector3();
  private seenFrame = 0;
  private shown = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), valid: false };

  constructor(spark: SparkRenderer) {
    const s = spark as unknown as Internals;
    this.s = s;
    const sort = s.driveSort.bind(spark);
    const readback = s.readbackDepth.bind(spark);
    let pending: { viewFrame: number; started: number; pos: THREE.Vector3; dir: THREE.Vector3; readbackMs: number } | null = null;
    s.readbackDepth = (args) => {
      // the sort's view is fixed by now (Spark copies it into sortedCenter just before the readback)
      const t0 = performance.now();
      const p = pending;
      if (p) {
        p.pos.copy(s.sortedCenter);
        p.dir.copy(s.sortedDir);
        // the accumulator was generated after the frame we last saw it change in, or (same task) after this frame
        p.viewFrame = args.current === this.seen ? this.seenFrame : this.frame;
      }
      return readback(args).then((r) => {
        if (p) p.readbackMs = performance.now() - t0;
        return r;
      });
    };
    s.driveSort = () => {
      const before = s.lastSortTime;
      const result = sort();
      if (s.lastSortTime !== before) {
        const rec = { viewFrame: this.frame, started: s.lastSortTime, pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), readbackMs: 0 };
        pending = rec;
        const stage = this.stage;
        void result.then(
          () => {
            const done: SortRecord = {
              stage, viewFrame: rec.viewFrame, doneFrame: this.frame, ms: performance.now() - rec.started, readbackMs: rec.readbackMs,
              lagFrames: this.frame + 1 - rec.viewFrame, activeSplats: s.activeSplats,
            };
            this.sorts.push(done);
            this.shown.pos.copy(rec.pos);
            this.shown.dir.copy(rec.dir);
            this.shown.valid = true;
            for (const r of this.reveals) if (!r.firstSort && rec.viewFrame >= r.frame) r.firstSort = done;
          },
          () => {},
        );
      }
      return result;
    };
  }

  get activeSplats() {
    return this.s.activeSplats;
  }

  /** At the start of every display frame, with the head's world position and gaze. */
  beginFrame(stage: number, head: THREE.Vector3, gaze: THREE.Vector3) {
    const cur = this.s.current;
    if (cur !== this.seen || !cur.viewOrigin.equals(this.seenOrigin)) {
      this.seen = cur;
      this.seenOrigin.copy(cur.viewOrigin);
      this.seenFrame = this.frame; // generated after the previous frame
    }
    this.frame++;
    this.stage = stage;
    if (this.shown.valid && this.s.activeSplats > 0) {
      const push = (map: Map<number, number[]>, v: number) => (map.get(stage) ?? map.set(stage, []).get(stage)!).push(v);
      push(this.staleDeg, THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, gaze.dot(this.shown.dir))))));
      push(this.staleCm, head.distanceTo(this.shown.pos) * 100);
    }
    for (const r of this.reveals) {
      if (r.drawnAfterFrames === null && this.s.activeSplats >= r.want * 0.5) r.drawnAfterFrames = this.frame - r.frame;
    }
  }

  /** Splats that should be on screen from this display frame on; `want` is how many. */
  reveal(label: string, want: number): Reveal {
    // drawnBefore: Spark's active count at the reveal (a "cold" reveal that is already drawn would show it here)
    const r: Reveal = { label, stage: this.stage, frame: this.frame, want, drawnBefore: this.s.activeSplats, drawnAfterFrames: this.s.activeSplats >= want * 0.5 ? 0 : null, firstSort: null };
    this.reveals.push(r);
    return r;
  }

  clear() {
    this.sorts.length = 0;
    this.reveals.length = 0;
    this.staleDeg.clear();
    this.staleCm.clear();
  }
}
