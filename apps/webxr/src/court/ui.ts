// What the judge reads and presses (3.6): the caption, the honesty label and the source credit (P22), low in front of
// you and following you lazily through the watch, and over the 3D (open, walking, returning) a smaller card above the
// pair, turned to you, fading as you come within a metre of it, so it never sits inside or in front of a player, and
// while a person stands between your eye and any of it (it has no depth test and the splats write no depth, so it
// would be drawn over them: a stereo conflict); the Reality check's panel (blue = never seen, the seen % per player,
// the interpolated share of the show: P7, P23); and the palm menu (left palm up, right index; xr/menu.ts HandMenu, 2
// columns, first row on top):
//   [Change seat]                      every phase after Seat here: back to the setup page after a 2 s hold (HoldButton),
//                                      for the presenter between judges
//   [Walk closer] | [Next view]        while the world is open and you're not in the room: Walk closer before the walking
//                                      anchoring, Next view after it, only where a second placement fits
//   [Step into the court | Back to my seat, Reality check]
//   [Replay, See my room]              nearest the palm; this row never moves (See my room flips to "Back to the arena", stays lit)
// and the setup page, [Seat here] over [See my room], where Seat here acts only after a 2 s hold (P32: HoldButton).
// No gesture acts by itself and there is no other control path (P21): no keys. Stream C (`core`); tested through the
// e2e (`window.__courtUi`, probe pages only), not node.
import * as THREE from "three";
import { XrButton, liveJoints } from "../xr/hands";
import { HandMenu, handIndex } from "../xr/menu";
import type { CourtBundle } from "./format";
import type { Head, Phase } from "./types";

/** True once stream C has built this module. */
export const BUILT = true;

/** Every button, by what it does. */
export type UiAction = "step" | "back" | "reality" | "replay" | "room" | "closer" | "nextView" | "seatHere" | "changeSeat";

/** What the menu shows besides the phase. */
export interface UiFlags {
  /** See my room is on (the button reads "Back to the arena"; Walk closer and Next view hide). */
  inRoom: boolean;
  /** Reality check is on. */
  reality: boolean;
  /** Seat here hasn't been held yet: the setup page. */
  setup: boolean;
  /** Next view applies (a second placement fits the bounds and the ring is off). */
  nextView: boolean;
}

/** xr/menu.ts's row and column pitch (the menu lays out its own rows; ours keep the bottom row still). */
const ROW = 0.036;
const COL = 0.1;
/** See my room's two labels, padded on the left to clear its window glyph (no AR or VR words). */
const ROOM_OUT = "   See my room";
const ROOM_BACK = "   Back to the arena";
/** Seat here's hold (P32). */
export const HOLD_MS = 2000;
/**
 * The caption over the 3D: centred over the pair, its lower edge `clear` above the highest of their capsules and bounds
 * and at least `minY` up, metres; sized to about `deg` degrees wide wherever you stand (`scale` its bounds: smaller
 * than the watch's card up close, readable from the seat); gone within `near[1]` of the eye, full from `near[0]`. The
 * swap between the two placements fades out and in.
 */
const OVER_PAIR = { minY: 2.4, clear: 0.25, deg: 12, scale: [0.5, 1.6] as const, near: [1.0, 0.6] as const };
/**
 * The people the card must not be drawn through, as capsules `grow` metres fatter (each player's torso and head; each
 * extra upright from `extra.foot` over their foot to `extra.head` under their height, radius `extra.r`); it fades out
 * over `fade` s while one stands between the eye and any of its `grid` points, and back in once none does.
 */
const BLOCK = { grow: 0.05, extra: { r: 0.2, foot: 0.3, head: 0.15 }, fade: 0.2, grid: [5, 3] as const };
/** The caption's plane, metres (the canvas's 1024 x 384). */
const CAPTION_W = 0.6;
const CAPTION_H = 0.225;

/** A fingertip lost to tracking for this long ends a hold (blinks shorter than this don't); one seen coming out ends it at once. */
const HOLD_GRACE_MS = 150;
/** A holding tip stays in until it is this far back in front of the face, metres (jitter at the surface never lets go). */
const HOLD_OUT = 0.004;

/**
 * A button that acts only after a fingertip has pushed into it and stayed there HOLD_MS (Seat here, P32). A blue bar
 * fills along its bottom while held; a shorter press, a tap or a hand passing through changes nothing. It fires once
 * per hold: the tip must come out before it can fire again.
 */
export class HoldButton extends XrButton {
  /** Every hold, for the e2e: when it started and when it fired (null: let go first), in `now` ms. */
  readonly holds: { start: number; fired: number | null }[] = [];
  /** 0-1: how far through the hold the current press is. */
  progress = 0;
  readonly holdMs: number;
  private readonly onHeld: () => void;
  private readonly bar: THREE.Mesh;
  private holdStart: number | null = null;
  private lastIn = 0;
  private fired = false;
  private readonly from = [false, false];
  /** Per hand: this tip is the one holding (it pushed in and hasn't been seen coming out). */
  private readonly holding = [false, false];
  private readonly tip = new THREE.Vector3();

  constructor(id: string, label: string, onHeld: () => void, holdMs = HOLD_MS) {
    super(id, label, () => {}); // a plain push does nothing: only the hold acts
    this.onHeld = onHeld;
    this.holdMs = holdMs;
    const geo = new THREE.PlaneGeometry(0.076, 0.0026);
    geo.translate(0.038, 0, 0);
    this.bar = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x0a84ff, transparent: true, depthWrite: false }));
    this.bar.position.set(-0.038, -0.0105, 0.0004);
    this.bar.scale.x = 0.0001;
    this.mesh.add(this.bar);
  }

  /** Both index fingertips in world space (null when not tracked), once a frame from the menu. */
  override touch(fingertips: (THREE.Vector3 | null)[], now: number): void {
    if (!this.mesh.visible) return;
    let pressing = false;
    let out = false;
    for (let h = 0; h < fingertips.length; h++) {
      const tip = fingertips[h];
      if (!tip) continue; // lost to tracking: the hold rides out HOLD_GRACE_MS
      this.mesh.worldToLocal(this.tip.copy(tip));
      const { x, y, z } = this.tip;
      const over = Math.abs(x) < 0.047 && Math.abs(y) < 0.016;
      const near = Math.abs(x) < 0.08 && Math.abs(y) < 0.05;
      // as XrButton: only a tip that came from in front counts, and one well behind the menu never does
      if (near && z > 0.015 && z < 0.12) this.from[h] = true;
      else if (!near || z < -0.08) this.from[h] = false;
      // in: pushed 2 mm into the face from in front; a holding tip stays in until it is back HOLD_OUT in front or off the face
      const stays = this.holding[h] && Math.abs(x) < 0.055 && Math.abs(y) < 0.024 && z < HOLD_OUT;
      if (stays || (over && z < -0.002 && this.from[h])) {
        this.holding[h] = pressing = true;
      } else if (this.holding[h]) {
        this.holding[h] = false;
        out = true;
      }
    }
    // a tip seen coming out ends the hold at once; one the menu stopped seeing (it closed, or the tip was lost) for longer
    // than the grace ends it too, even if the tip is back in: a new hold starts from now
    if (this.holdStart !== null && ((out && !pressing) || now - this.lastIn > HOLD_GRACE_MS)) {
      this.holdStart = null;
      if (this.fired) this.setOn(false);
      this.fired = false;
    }
    if (pressing) {
      this.lastIn = now;
      if (this.holdStart === null) {
        this.holdStart = now;
        this.holds.push({ start: now, fired: null });
      }
      if (!this.fired && now - this.holdStart >= this.holdMs) {
        this.fired = true;
        this.holds[this.holds.length - 1].fired = now;
        this.setOn(true);
        this.onHeld();
      }
    }
    this.progress = this.holdStart === null ? 0 : Math.min(1, (now - this.holdStart) / this.holdMs);
    this.bar.scale.x = Math.max(0.0001, this.progress);
  }
}

/** The middle of the caption card's lower edge over the pair, court space: over the middle of the pair's bounds, `clear` above the highest of their bounds and capsules (at least `minY` up). */
function overPair(bundle: CourtBundle): THREE.Vector3 {
  const players = bundle.court.freeze.players;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  let top = 0;
  for (const p of players) {
    x0 = Math.min(x0, p.bounds.min[0]);
    x1 = Math.max(x1, p.bounds.max[0]);
    z0 = Math.min(z0, p.bounds.min[2]);
    z1 = Math.max(z1, p.bounds.max[2]);
    top = Math.max(top, p.bounds.max[1], ...p.capsules.flatMap((c) => [c.a[1] + c.r, c.b[1] + c.r]));
  }
  const y = Math.max(OVER_PAIR.minY, top + OVER_PAIR.clear);
  return players.length ? new THREE.Vector3((x0 + x1) / 2, y, (z0 + z1) / 2) : new THREE.Vector3(0, y, 0);
}

/** A person the card must not be drawn through: a capsule, court space. */
interface Blocker {
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
}

/** The people the card over the pair must not be drawn through (BLOCK). */
function blockers(bundle: CourtBundle): Blocker[] {
  const { players, others = [] } = bundle.court.freeze;
  const out = players.flatMap((p) => p.capsules.map((c) => ({ a: new THREE.Vector3(...c.a), b: new THREE.Vector3(...c.b), r: c.r + BLOCK.grow })));
  for (const o of others) {
    const [x, y, z] = o.foot;
    out.push({ a: new THREE.Vector3(x, y + BLOCK.extra.foot, z), b: new THREE.Vector3(x, y + o.height - BLOCK.extra.head, z), r: BLOCK.extra.r + BLOCK.grow });
  }
  return out;
}

/** A small window glyph for See my room (a frame with four panes), as a child plane at the button's left. */
function windowIcon(): THREE.Mesh {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.strokeStyle = "#f5f5f7";
  g.lineWidth = 5;
  g.strokeRect(10, 12, 44, 40);
  g.beginPath();
  g.moveTo(32, 12);
  g.lineTo(32, 52);
  g.moveTo(10, 32);
  g.lineTo(54, 32);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const icon = new THREE.Mesh(new THREE.PlaneGeometry(0.0095, 0.0095), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  icon.position.set(-0.0365, 0, 0.0004); // in the pill's rounded left end; the label is padded clear of it
  return icon;
}

/** The caption, label and credit panel (and the Reality check's lines above them) drawn on one canvas. */
class CaptionPanel {
  readonly mesh: THREE.Mesh;
  readonly lines: string[] = [];
  /** The fade (0-1) and the near fade over the pair (0-1): drawn at their product. */
  private level = 0;
  private nearness = 1;
  private readonly canvas = document.createElement("canvas");
  private readonly tex: THREE.CanvasTexture;
  private readonly material: THREE.MeshBasicMaterial;

  constructor() {
    this.canvas.width = 1024;
    this.canvas.height = 384;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.material = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(CAPTION_W, CAPTION_H), this.material);
    this.mesh.name = "court-caption";
    this.mesh.renderOrder = 100; // over the arena, under the fade-jump veil
    this.mesh.visible = false;
  }

  set opacity(v: number) {
    this.level = v;
    this.apply();
  }

  get opacity(): number {
    return this.level;
  }

  /** 1 = full, 0 = gone (the eye too close to the card over the pair). */
  set near(v: number) {
    this.nearness = v;
    this.apply();
  }

  private apply(): void {
    this.material.opacity = this.level * this.nearness;
    this.mesh.visible = this.material.opacity > 0.001;
  }

  /** The caption, label and credit always; `reality` lines above them while the Reality check is on. */
  draw(caption: string, label: string, credit: string, reality: string[] | null): void {
    const g = this.canvas.getContext("2d")!;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    const font = (weight: number, px: number) => `${weight} ${px}px -apple-system, "SF Pro Text", Inter, Roboto, sans-serif`;
    const fit = (text: string, weight: number, px: number, max: number) => {
      let size = px;
      do g.font = font(weight, size);
      while (g.measureText(text).width > max && (size -= 2) > 14);
    };
    g.textAlign = "center";
    g.textBaseline = "middle";
    this.lines.length = 0;
    // the Reality panel: a blue-edged pill above the caption
    if (reality?.length) {
      const h = 40 + reality.length * 34;
      g.fillStyle = "rgba(10,20,40,0.78)";
      g.beginPath();
      g.roundRect(96, 8, W - 192, h, 26);
      g.fill();
      g.strokeStyle = "rgba(64,156,255,0.9)";
      g.lineWidth = 3;
      g.stroke();
      reality.forEach((line, i) => {
        g.fillStyle = i === 0 ? "#8cc4ff" : "#e8f1ff";
        fit(line, i === 0 ? 600 : 500, 28, W - 260);
        g.fillText(line, W / 2, 8 + 20 + 17 + i * 34);
        this.lines.push(line);
      });
    }
    const top = 196;
    g.fillStyle = "rgba(20,20,22,0.72)";
    g.beginPath();
    g.roundRect(40, top, W - 80, 180, 36);
    g.fill();
    g.fillStyle = "#f5f5f7";
    fit(caption, 600, 40, W - 140);
    g.fillText(caption, W / 2, top + 48);
    g.fillStyle = "#d2d2d7";
    fit(label, 500, 29, W - 140);
    g.fillText(label, W / 2, top + 104);
    g.fillStyle = "#a1a1a6";
    fit(credit, 400, 24, W - 140);
    g.fillText(credit, W / 2, top + 148);
    this.lines.push(caption, label, credit);
    this.tex.needsUpdate = true;
  }
}

/** What the e2e reads (probe pages only). */
export interface UiProbe {
  menuOpen(): boolean;
  /** The buttons on the menu now, top row first: id, label, lit, and the world points just in front of and inside the face. */
  buttons(): { id: string; label: string; on: boolean; front: number[]; inside: number[] }[];
  /** Seat here's holds (start and fired, in the frame loop's `now` ms). */
  holds(): { start: number; fired: number | null }[];
  /** The text on the caption panel now (Reality lines first, then caption, label, credit), and whether it shows. */
  text(): { lines: string[]; visible: boolean };
  /** Where the caption card is: its placement, drawn opacity and four corners (court space when the court group is in the scene). */
  caption(): { mode: "front" | "pair"; opacity: number; visible: boolean; corners: number[][] };
  /** A tracked hand joint's world position and orientation (the e2e moves IWER's hands by them); null when not tracked. */
  joint(side: "left" | "right", name: string): { p: number[]; q: number[] } | null;
}

declare global {
  interface Window {
    __courtUi?: UiProbe;
  }
}

export class Ui {
  /** See my room's handler (the plan's name; the same as on("room", fn)). */
  onToggleRoom: (() => void) | null = null;
  /** The palm menu (xr/menu.ts). */
  readonly menu: HandMenu;
  private readonly handlers = new Map<UiAction, () => void>();
  private readonly scene: THREE.Scene;
  private readonly hands: THREE.Object3D[];
  private readonly sideOf: (i: number) => XRHandedness | null;
  private readonly bundle: CourtBundle;
  private readonly b: Record<UiAction, XrButton>;
  private readonly seatHere: HoldButton;
  private readonly caption = new CaptionPanel();
  private phase: Phase = "arrival";
  private flags: UiFlags = { inRoom: false, reality: false, setup: true, nextView: false };
  private placed = false;
  /** Where the caption is: low in front (the watch), or over the pair (the 3D). */
  private mode: "front" | "pair" = "front";
  /** The court group (court.ts's "court-world"): the card over the pair rides it. */
  private readonly world: THREE.Object3D | null;
  /** Over the pair, court space: the middle of the card's lower edge. */
  private readonly overPair = new THREE.Vector3();
  private readonly lift = new THREE.Vector3();
  /** Court space: the people between the eye and the card, and the card's fade for them (1 = nobody, 0 = hidden). */
  private readonly blockers: Blocker[];
  private clearView = 1;
  private readonly eyeC = new THREE.Vector3();
  private readonly ptC = new THREE.Vector3();
  private readonly hitC = new THREE.Vector3();
  private readonly ray = new THREE.Ray();
  private readonly headV = new THREE.Vector3();
  private readonly target = new THREE.Vector3();

  constructor(scene: THREE.Scene, hands: THREE.Object3D[], sideOf: (i: number) => XRHandedness | null, bundle: CourtBundle) {
    this.scene = scene;
    this.hands = hands;
    this.sideOf = sideOf;
    this.bundle = bundle;
    this.menu = new HandMenu(hands, sideOf, scene, 2);
    const button = (action: UiAction, label: string) => new XrButton(action, label, () => this.press(action));
    this.seatHere = new HoldButton("seatHere", "Hold to seat here", () => this.press("seatHere"));
    this.b = {
      step: button("step", "Step into the court"),
      back: button("back", "Back to my seat"),
      reality: button("reality", "Reality check"),
      replay: button("replay", "Replay"),
      room: button("room", ROOM_OUT),
      closer: button("closer", "Walk closer"),
      nextView: button("nextView", "Next view"),
      seatHere: this.seatHere,
      changeSeat: new HoldButton("changeSeat", "Hold to change seat", () => this.press("changeSeat")),
    };
    this.b.room.mesh.add(windowIcon());
    this.world = scene.getObjectByName("court-world") ?? null;
    this.overPair.copy(overPair(bundle));
    this.blockers = blockers(bundle);
    scene.add(this.caption.mesh);
    this.drawCaption();
    this.relayout();
    if (typeof window !== "undefined" && window.__court) window.__courtUi = this.probe();
  }

  /** Register what a button does (court.ts wires every action). */
  on(action: UiAction, fn: () => void): void {
    this.handlers.set(action, fn);
  }

  /** Act as if a button were pressed (the e2e's shortcut; the real presses come from the palm menu). */
  press(action: UiAction): void {
    if (action === "reality") {
      // court.ts flips Reality on every press (no phase gate): the panel and the lit button follow it right away
      this.flags.reality = !this.flags.reality;
      this.b.reality.setOn(this.flags.reality);
      this.drawCaption();
    }
    if (action === "room" && this.onToggleRoom) this.onToggleRoom();
    else this.handlers.get(action)?.();
  }

  /** Which buttons show, and their labels, for this phase. */
  setPhase(phase: Phase, flags: UiFlags): void {
    const realityChanged = flags.reality !== this.flags.reality;
    this.phase = phase;
    this.flags = { ...flags };
    this.b.room.setLabel(flags.inRoom ? ROOM_BACK : ROOM_OUT);
    this.b.room.setOn(flags.inRoom);
    this.b.reality.setOn(flags.reality);
    if (realityChanged) this.drawCaption();
    this.relayout();
  }

  /** Once a frame while presenting: the menu follows the palm and takes fingertip presses; the caption follows lazily. */
  update(head: Head, now: number, dt: number): void {
    this.headV.set(head.room[0], head.room[1], head.room[2]);
    this.menu.update(this.headV, now, dt);
    // the caption: shown from the watch on (the arrival is black); low in front through the watch, catching up only when
    // you turn away; over the 3D, above the pair. A change of place fades out, moves, and fades in.
    const cap = this.caption;
    const mode = this.world && (this.phase === "open" || this.phase === "walking" || this.phase === "returning") ? "pair" : "front";
    const want = this.flags.setup || this.phase === "arrival" || mode !== this.mode ? 0 : 1;
    cap.opacity = Math.min(1, Math.max(0, cap.opacity + Math.sign(want - cap.opacity) * dt * (mode !== this.mode ? 4 : 2)));
    if (mode !== this.mode && cap.opacity <= 0) {
      this.mode = mode;
      this.placed = false;
    }
    const m = cap.mesh;
    if (this.mode === "pair" && this.world) {
      this.world.updateWorldMatrix(true, false);
      m.position.copy(this.overPair);
      this.world.localToWorld(m.position);
      const far = m.position.distanceTo(this.headV);
      const scale = Math.min(OVER_PAIR.scale[1], Math.max(OVER_PAIR.scale[0], (far * Math.tan(((OVER_PAIR.deg / 2) * Math.PI) / 180) * 2) / CAPTION_W));
      m.scale.setScalar(scale);
      // the lower edge stays put; the card grows upward (the court group turns about y only, so up is up)
      m.position.add(this.lift.set(0, (CAPTION_H * scale) / 2, 0));
      const [full, gone] = OVER_PAIR.near;
      const near = Math.min(1, Math.max(0, (m.position.distanceTo(this.headV) - gone) / (full - gone)));
      m.lookAt(this.headV);
      this.clearView = Math.min(1, Math.max(0, this.clearView + (this.blocked(m) ? -1 : 1) * (dt / BLOCK.fade)));
      cap.near = near * this.clearView;
      return;
    }
    m.scale.setScalar(1);
    this.clearView = 1;
    cap.near = 1;
    const fx = -Math.sin(head.yaw);
    const fz = -Math.cos(head.yaw);
    this.target.set(head.room[0] + fx * 1.05, head.room[1] - 0.42, head.room[2] + fz * 1.05);
    if (!this.placed) {
      m.position.copy(this.target);
      this.placed = true;
    } else {
      const dx = m.position.x - head.room[0];
      const dz = m.position.z - head.room[2];
      const off = Math.abs(Math.atan2(dx * fz - dz * fx, dx * fx + dz * fz));
      const dist = Math.hypot(dx, dz);
      if (off > (30 * Math.PI) / 180 || Math.abs(dist - 1.05) > 0.45 || Math.abs(m.position.y - this.target.y) > 0.3)
        m.position.lerp(this.target, Math.min(1, dt * 2.5));
    }
    m.lookAt(this.headV);
  }

  /** Whether a person (BLOCK) stands between the eye and any of the card's grid points. */
  private blocked(m: THREE.Mesh): boolean {
    if (!this.world) return false;
    m.updateMatrixWorld();
    this.eyeC.copy(this.headV);
    this.world.worldToLocal(this.eyeC);
    const [nu, nv] = BLOCK.grid;
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        this.ptC.set((i / (nu - 1) - 0.5) * CAPTION_W, (j / (nv - 1) - 0.5) * CAPTION_H, 0);
        m.localToWorld(this.ptC);
        this.world.worldToLocal(this.ptC);
        const reach = this.eyeC.distanceTo(this.ptC);
        this.ray.origin.copy(this.eyeC);
        this.ray.direction.subVectors(this.ptC, this.eyeC).normalize();
        // the nearest point of the sight line to a capsule's axis is inside it, and nearer than the card
        for (const { a, b, r } of this.blockers) if (this.ray.distanceSqToSegment(a, b, this.hitC) < r * r && this.eyeC.distanceTo(this.hitC) < reach) return true;
      }
    return false;
  }

  private drawCaption(): void {
    const c = this.bundle.court;
    const reality = this.flags.reality
      ? [
          "Blue: what the camera never saw",
          c.freeze.players.map((p) => `${p.name} ${Math.round(p.seenFraction * 100)}% seen`).join(" · "),
          `In-between frames interpolated: ${Math.round(c.metrics.interpShare * 100)}% of the show`,
        ]
      : null;
    this.caption.draw(c.caption, c.label, c.credit, reality);
  }

  /** The menu's rows for this phase (top row first); the bottom row is always [Replay, See my room]. */
  private rows(): XrButton[][] {
    const b = this.b;
    if (this.flags.setup) return [[b.seatHere], [b.room]];
    const rows: XrButton[][] = [[b.changeSeat]];
    const open = this.phase === "open" || this.phase === "walking";
    if (this.phase === "open" && !this.flags.inRoom) rows.push([b.closer]);
    if (this.phase === "walking" && !this.flags.inRoom && this.flags.nextView) rows.push([b.nextView]);
    if (this.phase === "watching") rows.push([b.step, b.reality]);
    else if (open) rows.push([b.back, b.reality]);
    else rows.push([b.reality]);
    rows.push([b.replay, b.room]);
    return rows;
  }

  /** Put exactly this phase's buttons on the menu, each row centred, the last row at the palm. */
  private relayout(): void {
    const rows = this.rows();
    const flat = rows.flat();
    for (const btn of [...this.menu.buttons]) if (!flat.includes(btn)) this.menu.remove(btn);
    for (const btn of flat) if (!this.menu.buttons.includes(btn)) this.menu.add(btn);
    rows.forEach((row, r) =>
      row.forEach((btn, k) => btn.mesh.position.set((k - (row.length - 1) / 2) * COL, (rows.length - 1 - r) * ROW, 0)),
    );
  }

  private probe(): UiProbe {
    return {
      menuOpen: () => this.menu.open && this.menu.group.visible,
      buttons: () =>
        this.rows().flat().map((btn) => {
          btn.mesh.updateWorldMatrix(true, false);
          return {
            id: btn.id,
            label: (btn as unknown as { label: string }).label.trim(),
            on: (btn as unknown as { on: boolean }).on,
            front: btn.mesh.localToWorld(new THREE.Vector3(0, 0, 0.06)).toArray(),
            inside: btn.mesh.localToWorld(new THREE.Vector3(0, 0, -0.006)).toArray(),
          };
        }),
      holds: () => this.seatHere.holds.map((h) => ({ ...h })),
      text: () => ({ lines: [...this.caption.lines], visible: this.caption.mesh.visible }),
      caption: () => {
        const m = this.caption.mesh;
        m.updateWorldMatrix(true, false);
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
          const p = m.localToWorld(new THREE.Vector3((x * CAPTION_W) / 2, (y * CAPTION_H) / 2, 0));
          if (this.world) this.world.worldToLocal(p);
          return p.toArray();
        });
        return { mode: this.mode, opacity: (m.material as THREE.MeshBasicMaterial).opacity, visible: m.visible, corners };
      },
      joint: (side, name) => {
        const j = liveJoints(this.hands[handIndex(this.sideOf, side)])[name];
        if (!j?.visible) return null;
        return { p: j.getWorldPosition(new THREE.Vector3()).toArray(), q: j.getWorldQuaternion(new THREE.Quaternion()).toArray() };
      },
    };
  }
}
