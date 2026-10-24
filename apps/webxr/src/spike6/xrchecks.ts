// What the headset's browser allows in each session mode: reference spaces, the guardian boundary, the frame rate,
// anchors (and Meta's persistent anchors), and what happens to the session when the headset comes off.

const STORE = "s6-quest-anchor-handles"; // persistent-anchor handles this page created (only these are ever deleted)

type PersistentSession = XRSession & {
  persistentAnchors?: readonly string[];
  restorePersistentAnchor?: (uuid: string) => Promise<XRAnchor>;
  deletePersistentAnchor?: (uuid: string) => Promise<void>;
};
type PersistentAnchor = XRAnchor & { requestPersistentHandle?: () => Promise<string> };

const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 90);
const round = (v: number, d = 1) => Number(v.toFixed(d));

function stored(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function store(handles: string[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(handles));
  } catch {
    // private window: the next run just finds nothing to restore
  }
}

export type SpaceCheck = { localFloor: string; used: XRReferenceSpaceType; boundedFloor: string; boundsM: { w: number; d: number; points: number } | null };
export type Boundary = { space: XRReferenceSpace; points: { x: number; z: number }[] };

/** local-floor (falls back to local), and bounded-floor's boundary, before three takes the session. */
export async function checkSpaces(s: XRSession): Promise<{ check: SpaceCheck; boundary: Boundary | null }> {
  const out: SpaceCheck = { localFloor: "?", used: "local-floor", boundedFloor: "?", boundsM: null };
  let boundary: Boundary | null = null;
  try {
    await s.requestReferenceSpace("local-floor");
    out.localFloor = "ok";
  } catch (e) {
    out.localFloor = `no: ${msg(e)}`;
    out.used = "local";
  }
  try {
    const b = (await s.requestReferenceSpace("bounded-floor")) as XRBoundedReferenceSpace;
    const pts = b.boundsGeometry ?? [];
    out.boundedFloor = "ok";
    if (pts.length) {
      const xs = pts.map((p) => p.x);
      const zs = pts.map((p) => p.z);
      out.boundsM = { w: round(Math.max(...xs) - Math.min(...xs), 2), d: round(Math.max(...zs) - Math.min(...zs), 2), points: pts.length };
      if (pts.length >= 3) boundary = { space: b, points: pts.map((p) => ({ x: p.x, z: p.z })) };
    }
  } catch (e) {
    out.boundedFloor = `no: ${msg(e)}`;
  }
  return { check: out, boundary };
}

// ---------------- optional features ----------------

export const OPTIONAL_FEATURES = ["local-floor", "bounded-floor", "plane-detection", "anchors", "hand-tracking"];

export type FeatureCheck = {
  requested: string[];
  enabledFeatures: string[] | null; // XRSession.enabledFeatures, when the browser has it
  granted: Record<string, boolean | null>; // from enabledFeatures, else inferred (null: can't tell)
  planes: { max: number; labels: string[] };
};

type PlaneFrame = XRFrame & { detectedPlanes?: Set<{ semanticLabel?: string }> };

/** Which optional features the session granted, and what plane detection finds while it runs. */
export class Features {
  readonly out: FeatureCheck;
  private n = 0;

  constructor(s: XRSession, spaces: SpaceCheck) {
    const enabled = (s as unknown as { enabledFeatures?: readonly string[] }).enabledFeatures;
    const list = enabled ? Array.from(enabled) : null;
    const inferred: Record<string, boolean | null> = {
      "local-floor": spaces.localFloor === "ok", "bounded-floor": spaces.boundedFloor === "ok", "plane-detection": null, anchors: null, "hand-tracking": null,
    };
    this.out = {
      requested: OPTIONAL_FEATURES, enabledFeatures: list,
      granted: Object.fromEntries(OPTIONAL_FEATURES.map((f) => [f, list ? list.includes(f) : inferred[f]])),
      planes: { max: 0, labels: [] },
    };
  }

  /** Every frame: fills in what enabledFeatures couldn't say, and tallies detected planes now and then. */
  frame(frame: XRFrame) {
    const f = frame as PlaneFrame;
    const g = this.out.granted;
    if (this.n++ === 0 && !this.out.enabledFeatures) {
      g["plane-detection"] = f.detectedPlanes !== undefined;
      g.anchors = typeof frame.createAnchor === "function";
    }
    if (!this.out.enabledFeatures && g["hand-tracking"] !== true) {
      g["hand-tracking"] = Array.from(frame.session.inputSources).some((src) => !!src.hand) || null;
    }
    if (this.n % 36 === 1 && f.detectedPlanes) {
      this.out.planes.max = Math.max(this.out.planes.max, f.detectedPlanes.size);
      for (const plane of f.detectedPlanes) {
        const label = plane.semanticLabel ?? "unlabelled";
        if (!this.out.planes.labels.includes(label)) this.out.planes.labels.push(label);
      }
    }
  }

  line(): string {
    const g = this.out.granted;
    const yn = (v: boolean | null) => (v === null ? "?" : v ? "yes" : "NO");
    const planes = g["plane-detection"] ? ` (${this.out.planes.max} planes${this.out.planes.labels.length ? `: ${this.out.planes.labels.slice(0, 4).join(" ")}` : ""})` : "";
    return `Granted: bounded-floor ${yn(g["bounded-floor"])}  plane-detection ${yn(g["plane-detection"])}${planes}  anchors ${yn(g.anchors)}  hands ${yn(g["hand-tracking"])}${this.out.enabledFeatures ? "" : " (inferred)"}`;
  }
}

export type RateCheck = { api: boolean; requested: number; ok: boolean | null; error: string | null; before: number | null; after: number | null; supported: number[] | null };

export async function setRate(s: XRSession, hz: number): Promise<RateCheck> {
  const out: RateCheck = {
    api: typeof s.updateTargetFrameRate === "function", requested: hz, ok: null, error: null, before: s.frameRate ?? null, after: null,
    supported: s.supportedFrameRates ? Array.from(s.supportedFrameRates) : null,
  };
  if (out.api) {
    try {
      await s.updateTargetFrameRate(hz);
      out.ok = true;
    } catch (e) {
      out.ok = false;
      out.error = msg(e);
    }
  }
  out.after = s.frameRate ?? null;
  return out;
}

export type AnchorCheck = {
  create: string; createMs: number | null; tracked: boolean; persistentApi: boolean; handle: string;
  oldFound: number; otherFound: number; restoredOld: string; deletedOld: number; errors: string[];
};

/** createAnchor, then (Meta) restore the handle the last run left, delete every old handle of ours, and leave a new one. */
export class AnchorTest {
  readonly out: AnchorCheck = { create: "not run", createMs: null, tracked: false, persistentApi: false, handle: "n/a", oldFound: 0, otherFound: 0, restoredOld: "none", deletedOld: 0, errors: [] };
  private anchor: XRAnchor | null = null;
  private started = false;

  constructor(private done: () => void) {}

  /** Call from the frame loop every frame; the test starts on the first call. */
  frame(frame: XRFrame, space: XRReferenceSpace) {
    if (this.anchor && !this.out.tracked && frame.trackedAnchors?.has(this.anchor)) {
      this.out.tracked = true;
      this.done();
    }
    if (this.started) return;
    this.started = true;
    this.out.create = "running";
    void this.run(frame, space).finally(() => this.done());
  }

  private async run(frame: XRFrame, space: XRReferenceSpace) {
    const s = frame.session as PersistentSession;
    if (typeof frame.createAnchor !== "function") {
      this.out.create = "no createAnchor";
      return;
    }
    const t0 = performance.now();
    try {
      const anchor = (await frame.createAnchor(new XRRigidTransform({ x: 0, y: 0.5, z: -1 }), space)) as PersistentAnchor | undefined;
      if (!anchor) throw new Error("resolved without an anchor");
      this.anchor = anchor;
      this.out.create = "ok";
      this.out.createMs = round(performance.now() - t0);
      this.out.persistentApi = typeof anchor.requestPersistentHandle === "function";
      if (!this.out.persistentApi) return;
      const listed = Array.from(s.persistentAnchors ?? []);
      const ours = stored();
      this.out.oldFound = ours.filter((u) => listed.includes(u)).length;
      this.out.otherFound = listed.filter((u) => !ours.includes(u)).length;
      const last = ours[ours.length - 1];
      if (last && s.restorePersistentAnchor) {
        try {
          const restored = await s.restorePersistentAnchor(last);
          this.out.restoredOld = "ok";
          restored.delete();
        } catch (e) {
          this.out.restoredOld = `failed: ${msg(e)}`;
        }
      }
      for (const uuid of ours) {
        try {
          await s.deletePersistentAnchor?.(uuid);
          this.out.deletedOld++;
        } catch (e) {
          this.out.errors.push(`delete: ${msg(e)}`);
        }
      }
      store([]);
      const handle = await anchor.requestPersistentHandle!();
      store([handle]);
      this.out.handle = "ok";
    } catch (e) {
      if (this.out.create !== "ok") this.out.create = `failed: ${msg(e)}`;
      else this.out.errors.push(msg(e));
    }
  }

  release() {
    try {
      this.anchor?.delete();
    } catch {
      // the session has ended
    }
    this.anchor = null;
  }
}

export type VisEvent = { atS: number; kind: "xr" | "page" | "end"; state: string };
export type OffOn = {
  events: VisEvent[]; offPeriodsS: number[]; longestFrameGapS: number; survived: boolean | null;
  sparkXrWouldEnd: boolean; // SparkXr (the viewer's session helper) ends the session on visible -> visible-blurred
  endedWhileOff: boolean;
};

/** Visibility of the session and the page while it runs; frame gaps come from the loop. */
export class VisibilityLog {
  readonly out: OffOn = { events: [], offPeriodsS: [], longestFrameGapS: 0, survived: null, sparkXrWouldEnd: false, endedWhileOff: false };
  private t0 = performance.now();
  private offSince: number | null = null;
  private last: XRVisibilityState = "visible";
  private onPage = () => this.add("page", document.visibilityState);

  constructor(private s: XRSession, private changed: () => void) {
    this.last = s.visibilityState;
    s.addEventListener("visibilitychange", () => {
      const state = s.visibilityState;
      if (this.last === "visible" && state === "visible-blurred") this.out.sparkXrWouldEnd = true;
      this.last = state;
      if (state === "visible") {
        if (this.offSince !== null) {
          this.out.offPeriodsS.push(round((performance.now() - this.offSince) / 1000));
          this.out.survived = true;
        }
        this.offSince = null;
      } else if (this.offSince === null) this.offSince = performance.now();
      this.add("xr", state);
    });
    document.addEventListener("visibilitychange", this.onPage);
  }

  private add(kind: VisEvent["kind"], state: string) {
    this.out.events.push({ atS: round((performance.now() - this.t0) / 1000), kind, state });
    if (this.out.events.length > 40) this.out.events.splice(0, 1);
    this.changed();
  }

  frameGap(ms: number) {
    this.out.longestFrameGapS = Math.max(this.out.longestFrameGapS, round(ms / 1000));
  }

  ended() {
    document.removeEventListener("visibilitychange", this.onPage);
    if (this.offSince !== null || this.last !== "visible") {
      this.out.endedWhileOff = true;
      this.out.survived = false;
    }
    this.add("end", "ended");
  }

  /** One line for the HUD. */
  line(): string {
    const o = this.out;
    const xr = o.events.filter((e) => e.kind !== "page").map((e) => e.state.replace("visible-blurred", "blurred")).join(">");
    const spark = o.sparkXrWouldEnd ? ", SparkXr would exit" : "";
    if (o.endedWhileOff) return `Off/on: SESSION ENDED while off${spark}  (${xr})`;
    if (!o.offPeriodsS.length) return xr ? `Off/on: so far ${xr}` : "Off/on: take the headset off, count to 10, put it back on";
    return `Off/on: off ${o.offPeriodsS.join("+")} s, session alive, frame gap ${o.longestFrameGapS} s${spark}  (${xr})`;
  }
}
