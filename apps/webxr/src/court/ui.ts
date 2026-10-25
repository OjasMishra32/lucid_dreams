// What the judge reads and presses (3.6): the caption, the honesty label and the source credit (P22), low in front of
// you and following you lazily through the watch, and over the 3D (open, walking, returning) a smaller card above the
// pair, turned to you, fading as you come within a metre of it, so it never sits inside or in front of a player, and
// while a person stands between your eye and any of it (it has no depth test and the splats write no depth, so it
// would be drawn over them: a stereo conflict); the Reality check's panel (blue = never seen, the seen % per player,
// the interpolated share of the show: P7, P23); and the palm menu (left palm up, right index; xr/menu.ts HandMenu, 2
// columns, first row on top):
//   [Change seat, Look]                every phase after Seat here: Change seat goes back to the setup page after a 2 s
//                                      hold (HoldButton), for the presenter between judges; Look cycles LookName
//   [Walk closer] | [Next view]        while the world is open and you're not in the room: Walk closer before the walking
//                                      anchoring, Next view after it, only where a second placement fits
//   [Step into the court | Back to my seat, Reality check]
//   [Reset, See my room]               nearest the palm; this row never moves (See my room flips to "Back to the arena", stays lit)
// and the setup page, [Seat here] over [See my room], where Seat here acts only after a 2 s hold (P32: HoldButton).
// No gesture acts by itself and there is no other control path (P21): no keys. Every surface is painted in one of three
// looks (LookName; vision's is visionOS glass, faked: glass() a translucent body lit from above, a rim light, a soft shadow, no blur), drawn once per change of
// content; the motion is eased (fades, the menu's spring, the watch card's glide), never a pop. Stream C (`core`); tested
// through the e2e (`window.__courtUi`, probe pages only), not node.
import * as THREE from "three";
import { XrButton, liveJoints, type ButtonLook } from "../xr/hands";
import { HandMenu, handIndex } from "../xr/menu";
import type { CourtBundle } from "./format";
import type { Head, Phase } from "./types";

/** True once stream C has built this module. */
export const BUILT = true;

/** Every button, by what it does. */
export type UiAction = "step" | "back" | "reality" | "replay" | "room" | "closer" | "nextView" | "seatHere" | "changeSeat" | "look";

/**
 * The three looks of every surface here (`&ui=<name>` picks one, vision by default; the Look button beside Change seat
 * cycles them live): what changes is paint (glass, type, accents), never the layout, the hit boxes or what's said.
 *   vision     visionOS frosted glass: lighter glass lit from above with a specular sheen, bold display type
 *   broadcast  NBA broadcast graphics: sharp navy plates, an orange accent bar, condensed caps; the card a lower third
 *   minimal    almost no chrome: hairline outlines, text over a soft shadow
 */
export type LookName = "vision" | "broadcast" | "minimal";
export const LOOK_NAMES: readonly LookName[] = ["vision", "broadcast", "minimal"];
const LOOK_TITLES: Record<LookName, string> = { vision: "Vision", broadcast: "Broadcast", minimal: "Minimal" };
function lookFromUrl(): LookName {
  if (typeof location === "undefined") return "vision";
  const v = new URLSearchParams(location.search).get("ui");
  return LOOK_NAMES.includes(v as LookName) ? (v as LookName) : "vision";
}
let look: LookName = lookFromUrl();
/** The Look button's label: the look now. */
const lookLabel = (): string => `Look: ${LOOK_TITLES[look]}`;

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
/**
 * The caption's plane, metres, laid out in DESIGN px (its 1024 x 384) and drawn at TEXELS canvas px per design px: in
 * front, ~48 texels a degree at the watch's 1.05 m (about twice the Quest 3S's ~20 px a degree: crisp after
 * mipmapping); over the pair the card spans at most ~17 deg, so half as many still give ~45.
 */
const CAPTION_W = 0.6;
const CAPTION_H = 0.225;
const DESIGN = [1024, 384] as const;
const TEXELS = { front: 1.5, pair: 0.75 } as const;
/** The card's fades, seconds (in: ease-out; out: ease-in; out for a change of place), growing in from `from` of its size. */
const FADE = { in: 0.35, out: 0.3, swap: 0.2, from: 0.96 };
/** The Reality panel's fade, seconds, and how far it rises into place as it comes in, metres. */
const REALITY_FADE = { s: 0.25, rise: 0.008 };
/** The watch's lazy follow: once you turn 30 deg away it glides (critically damped, about `time` s) back in front, until it is within `settle` m of its place and slower than `still` m/s. */
const FOLLOW = { time: 0.45, settle: 0.015, still: 0.03 };
/** The palm menu draws after stream D's footage (50-90, no depth test) and the drawn hands (vrhands HANDS_ORDER 100), so neither paints over it. */
const MENU_ORDER = 110;
/** The menu's open and close (xr/menu.ts MenuEase): a 220 ms fade and spring in, 160 ms out. */
const MENU_EASE = { inS: 0.22, outS: 0.16, from: 0.92 };

/** A fingertip lost to tracking for this long ends a hold (blinks shorter than this don't); one seen coming out ends it at once. */
const HOLD_GRACE_MS = 150;
/** A holding tip stays in until it is this far back in front of the face, metres (jitter at the surface never lets go). */
const HOLD_OUT = 0.004;

// ---------------- the look: type and glass ----------------

/** The system font (Roboto on the Quest, SF on a Mac): the SF feel comes from weight, size, tracking and spacing, not a download. */
const FONT_STACK = `-apple-system, BlinkMacSystemFont, "SF Pro Text", Roboto, "Helvetica Neue", Arial, sans-serif`;
/** Vision's display cut (SF Pro Display on a Mac, Roboto on the Quest). */
const DISPLAY_STACK = `"SF Pro Display", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, sans-serif`;
/** Broadcast's condensed cut: Roboto Condensed on the Quest (Android's sans-serif-condensed), Avenir Next Condensed on a Mac. */
const CONDENSED_STACK = `"Roboto Condensed", sans-serif-condensed, "Avenir Next Condensed", "Helvetica Neue Condensed", "Arial Narrow", Roboto, sans-serif`;

/** A text style: weight, size and the smallest it may shrink to (px), line height (px), tracking (em), colour; optionally its family and caps. */
interface TextStyle {
  weight: number;
  px: number;
  min: number;
  lead: number;
  track: number;
  color: string;
  family?: string;
  caps?: boolean;
}

function setFont(g: CanvasRenderingContext2D, s: TextStyle, px: number): void {
  g.font = `${s.weight} ${px}px ${s.family ?? FONT_STACK}`;
  // tracking in em, tighter as type grows (SF's optical sizes); a browser without letterSpacing draws it untracked
  if ("letterSpacing" in g) g.letterSpacing = `${(s.track * px).toFixed(2)}px`;
}

/** Where to break `text` in two: after a sentence or a " · " near the middle, else at the space nearest it. */
function halves(text: string): string[] {
  const mid = text.length / 2;
  let best = -1;
  for (const sep of [". ", " · ", ": ", ", ", " "]) {
    for (let i = text.indexOf(sep); i >= 0; i = text.indexOf(sep, i + 1)) {
      const at = sep === " " ? i : i + sep.length - 1;
      if (Math.abs(at - mid) < text.length * (sep === " " ? 0.5 : 0.2) && (best < 0 || Math.abs(at - mid) < Math.abs(best - mid))) best = at;
    }
    if (best >= 0) break;
  }
  return best < 0 ? [text] : [text.slice(0, best).trim(), text.slice(best).trim()];
}

/** `text` in one line as large as fits `max` (down to the style's min), else in two at the style's size (smaller if they must). */
function wrap(g: CanvasRenderingContext2D, text: string, s: TextStyle, max: number): { lines: string[]; px: number } {
  for (let px = s.px; px >= s.min; px--) {
    setFont(g, s, px);
    if (g.measureText(text).width <= max) return { lines: [text], px };
  }
  const two = halves(text);
  let px = s.px;
  for (; px > 12; px--) {
    setFont(g, s, px);
    if (two.every((l) => g.measureText(l).width <= max)) break;
  }
  return { lines: two, px };
}

/** A glass surface's recipe: its body's tint, the light from above (sheen), the rim light, the drop shadow (alpha, blur and drop in design px). */
interface Glass {
  tint: string;
  /** With it, the body runs from `tint` at the top to this at the foot. */
  tint2?: string;
  sheen: number;
  rim: number;
  shadow: number;
  blur: number;
  drop: number;
  grain?: boolean;
}

/** The glass's grain (a fixed speckle: dithers the gradients, so 8-bit displays show no bands), made once. */
let grainPattern: CanvasPattern | null = null;
function grain(g: CanvasRenderingContext2D): CanvasPattern | null {
  if (!grainPattern) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const n = c.getContext("2d")!;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 900; i++) {
      n.fillStyle = rnd() < 0.5 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.07)";
      n.fillRect(Math.floor(rnd() * 64), Math.floor(rnd() * 64), 1, 1);
    }
    grainPattern = g.createPattern(c, "repeat");
  }
  return grainPattern;
}

/**
 * visionOS glass, faked (no blur): a soft drop shadow outside the shape (cast by an opaque copy that is then cut out,
 * so the translucent body never reads darker for it), a translucent body lit from above, an optional grain, and a
 * hairline rim brightest along the top edge. Design px under a `px`-per-design-px transform (shadows don't scale with it).
 */
function glass(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, o: Glass, px: number): void {
  g.save();
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.shadowColor = `rgba(0,0,0,${o.shadow})`;
  g.shadowBlur = o.blur * px;
  g.shadowOffsetY = o.drop * px;
  g.fillStyle = "#000";
  g.fill();
  g.shadowColor = "rgba(0,0,0,0)";
  g.globalCompositeOperation = "destination-out";
  g.fill();
  g.globalCompositeOperation = "source-over";
  if (o.tint2) {
    const body = g.createLinearGradient(0, y, 0, y + h);
    body.addColorStop(0, o.tint);
    body.addColorStop(1, o.tint2);
    g.fillStyle = body;
  } else g.fillStyle = o.tint;
  g.fill();
  const sheen = g.createLinearGradient(0, y, 0, y + h);
  sheen.addColorStop(0, `rgba(255,255,255,${o.sheen})`);
  sheen.addColorStop(0.5, `rgba(255,255,255,${o.sheen * 0.3})`);
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = sheen;
  g.fill();
  const speckle = o.grain ? grain(g) : null;
  if (speckle) {
    g.save();
    g.clip();
    g.fillStyle = speckle;
    g.fillRect(x, y, w, h);
    g.restore();
  }
  const lw = 1.5;
  g.beginPath();
  g.roundRect(x + lw / 2, y + lw / 2, w - lw, h - lw, Math.max(0, r - lw / 2));
  const rim = g.createLinearGradient(0, y, 0, y + h);
  rim.addColorStop(0, `rgba(255,255,255,${o.rim})`);
  rim.addColorStop(0.3, `rgba(255,255,255,${o.rim * 0.2})`);
  rim.addColorStop(1, `rgba(255,255,255,${o.rim * 0.38})`);
  g.strokeStyle = rim;
  g.lineWidth = lw;
  g.stroke();
  g.restore();
}

/** An ease-out curve, used both ways: a fade in eases out and the same fade run back eases in (and a turn mid-fade never jumps). */
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const smooth = (t: number) => t * t * (3 - 2 * t);

// ---------------- the palm menu's buttons ----------------

/** A glyph beside a button's label: drawn in a GLYPH px box from x, centred on y, in the label's colour. */
type Glyph = (g: CanvasRenderingContext2D, x: number, y: number, color: string) => void;
const GLYPH = 38;

/** See my room's glyph: a window of four panes. */
const windowGlyph: Glyph = (g, x, y, color) => {
  g.save();
  g.strokeStyle = color;
  g.lineWidth = 4.5;
  g.lineJoin = "round";
  g.beginPath();
  g.roundRect(x + 2.5, y - 16, GLYPH - 5, 32, 6);
  g.moveTo(x + GLYPH / 2, y - 16);
  g.lineTo(x + GLYPH / 2, y + 16);
  g.moveTo(x + 2.5, y);
  g.lineTo(x + GLYPH - 2.5, y);
  g.stroke();
  g.restore();
};

/** The button canvas (6400 px a metre) and its face: the default pill's 0.09 x 0.028 m, inside room for its shadow. */
const BUTTON = { canvas: [704, 256] as const, plane: [0.11, 0.04] as const, face: [576, 180] as const };
/**
 * Each look's buttons: the label's style off and its colour on, the face's left inset for an accent (design px), the
 * label's shadow (alpha and blur px: it keeps light type legible over the lit floor), and the hold's fill colour.
 */
const BUTTON_STYLES: Record<LookName, { text: TextStyle; onColor: string; inset: number; shadow: [number, number]; fill: THREE.Color }> = {
  vision: {
    text: { weight: 700, px: 60, min: 42, lead: 0, track: -0.016, color: "rgba(255,255,255,0.98)", family: DISPLAY_STACK },
    onColor: "#111114",
    inset: 0,
    shadow: [0.38, 8],
    fill: new THREE.Color(0.04, 0.52, 1.0),
  },
  broadcast: {
    text: { weight: 800, px: 62, min: 42, lead: 0, track: 0.03, color: "#ffffff", family: CONDENSED_STACK, caps: true },
    onColor: "#0b1024",
    inset: 22,
    shadow: [0, 0],
    fill: new THREE.Color(1.0, 0.42, 0.07),
  },
  minimal: {
    text: { weight: 500, px: 60, min: 42, lead: 0, track: -0.006, color: "rgba(255,255,255,0.97)" },
    onColor: "#111114",
    inset: 0,
    shadow: [0.6, 10],
    fill: new THREE.Color(0.04, 0.52, 1.0),
  },
};
/** Vision, off: frosted glass lighter at the top than the foot, over a deep shadow; on: white glass with a dark label (a visionOS toggle that's on). */
const VISION_OFF: Glass = { tint: "rgba(132,134,150,0.66)", tint2: "rgba(64,66,80,0.80)", sheen: 0.24, rim: 0.9, shadow: 0.55, blur: 22, drop: 6, grain: true };
const VISION_ON: Glass = { tint: "rgba(255,255,255,0.97)", tint2: "rgba(222,226,236,0.95)", sheen: 0, rim: 0.9, shadow: 0.55, blur: 22, drop: 6 };
/** Broadcast: a navy plate (orange when on), squared off. */
const BROADCAST_OFF: Glass = { tint: "rgba(26,34,66,0.97)", tint2: "rgba(7,10,24,0.97)", sheen: 0.08, rim: 0.32, shadow: 0.6, blur: 16, drop: 6 };
const BROADCAST_ON: Glass = { tint: "rgba(255,138,40,0.98)", tint2: "rgba(236,84,10,0.98)", sheen: 0.1, rim: 0.5, shadow: 0.6, blur: 16, drop: 6 };
const ORANGE = "#ff6a13";

/** visionOS's specular: a soft white bloom along the top of a shape, clipped to it. */
function specular(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, a: number): void {
  g.save();
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.clip();
  const bloom = g.createRadialGradient(x + w / 2, y - h * 0.15, 0, x + w / 2, y - h * 0.15, w * 0.55);
  bloom.addColorStop(0, `rgba(255,255,255,${a})`);
  bloom.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = bloom;
  g.fillRect(x, y, w, h * 0.6);
  g.restore();
}

/** A button's face in the current look, at x, y (canvas px, 1:1). */
function paintFace(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, lit: boolean): void {
  if (look === "vision") {
    glass(g, x, y, w, h, h / 2, lit ? VISION_ON : VISION_OFF, 1);
    if (!lit) specular(g, x, y, w, h, h / 2, 0.22);
  } else if (look === "broadcast") {
    glass(g, x, y, w, h, 10, lit ? BROADCAST_ON : BROADCAST_OFF, 1);
    g.save();
    g.beginPath();
    g.roundRect(x, y, w, h, 10);
    g.clip();
    g.fillStyle = lit ? "#0b1024" : ORANGE; // the accent bar down the left edge
    g.fillRect(x, y, BUTTON_STYLES.broadcast.inset - 4, h);
    g.fillStyle = "rgba(255,255,255,0.22)"; // a hairline along the top
    g.fillRect(x, y, w, 2);
    g.restore();
  } else {
    g.save();
    g.beginPath();
    g.roundRect(x + 1.5, y + 1.5, w - 3, h - 3, h / 2);
    g.fillStyle = lit ? "rgba(255,255,255,0.95)" : "rgba(0,0,0,0.34)";
    g.fill();
    g.strokeStyle = lit ? "rgba(255,255,255,1)" : "rgba(255,255,255,0.72)";
    g.lineWidth = 3;
    g.stroke();
    g.restore();
  }
}

/** A button's label (and glyph) centred on its face: the look's type, tracked, shrunk to fit, never cut off. */
function paintLabel(g: CanvasRenderingContext2D, label: string, color: string, glyph?: Glyph, lit = false): void {
  const [cw, ch] = BUTTON.canvas;
  const st = BUTTON_STYLES[look];
  const s = st.text;
  const text = s.caps ? label.trim().toUpperCase() : label.trim();
  const room = glyph ? GLYPH + 14 : 0;
  let px = s.px;
  do setFont(g, s, px);
  while (g.measureText(text).width > BUTTON.face[0] - 96 - st.inset - room && (px -= 2) > s.min);
  const left = cw / 2 + st.inset / 2 - (room + g.measureText(text).width) / 2;
  g.save();
  if (!lit && st.shadow[0] > 0) {
    g.shadowColor = `rgba(0,0,0,${st.shadow[0]})`;
    g.shadowBlur = st.shadow[1];
    g.shadowOffsetY = 2;
  }
  g.fillStyle = color;
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillText(text, left + room, ch / 2 + 2); // a hair under the middle: the optical centre of caps and lower case
  glyph?.(g, left, ch / 2, color);
  g.restore();
}

/**
 * Court Side's look for the palm menu (xr/hands.ts ButtonLook), painted in the current LookName; hover lifts the
 * face, a press flashes it. `label` false paints the face alone (HoldButton draws its label on its own layer, over its fill).
 */
function courtLook(glyph?: Glyph, label = true): ButtonLook {
  return {
    canvas: BUTTON.canvas,
    plane: BUTTON.plane,
    hover: 2.8,
    press: 3.6,
    rate: 16,
    paint(g, text, on) {
      const [cw, ch] = BUTTON.canvas;
      const [fw, fh] = BUTTON.face;
      const lit = on && label;
      paintFace(g, (cw - fw) / 2, (ch - fh) / 2, fw, fh, lit);
      if (label) paintLabel(g, text, lit ? BUTTON_STYLES[look].onColor : BUTTON_STYLES[look].text.color, glyph, lit);
    },
  };
}
const LOOK = courtLook();
const HOLD_LOOK = courtLook(undefined, false);

/** The hold's fill: the face's capsule fills with system blue from the left as the hold goes on (under the label), its front edge soft; it drains over `back` s when a hold ends short. The colour is written as is (sRGB). */
const FILL = { color: new THREE.Color(0.04, 0.52, 1.0), alpha: 0.95, feather: 0.007, back: 0.22 };
const FILL_VERT = `varying vec2 vP;
void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FILL_FRAG = `uniform vec3 uColor; uniform vec2 uHalf; uniform float uP; uniform float uFeather; uniform float opacity;
varying vec2 vP;
void main() {
  vec2 q = abs(vP) - (uHalf - vec2(uHalf.y));
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uHalf.y; // outside the capsule, metres
  float aa = fwidth(d);
  float inside = 1.0 - smoothstep(-aa, aa, d);
  float front = -uHalf.x - uFeather + uP * 2.0 * (uHalf.x + uFeather); // off the left end at 0, past the right at 1
  float filled = 1.0 - smoothstep(front - uFeather, front, vP.x);
  gl_FragColor = vec4(uColor, inside * filled * opacity);
}`;

/**
 * A button that acts only after a fingertip has pushed into it and stayed there HOLD_MS (Seat here, P32). The face fills
 * with blue from the left while held, under its label (and drains over FILL.back s when let go short); a shorter press,
 * a tap or a hand passing through changes nothing. It fires once per hold: the tip must come out before it can fire again.
 */
export class HoldButton extends XrButton {
  /** Every hold, for the e2e: when it started and when it fired (null: let go first), in `now` ms. */
  readonly holds: { start: number; fired: number | null }[] = [];
  /** 0-1: how far through the hold the current press is. */
  progress = 0;
  readonly holdMs: number;
  private readonly onHeld: () => void;
  private readonly fill: THREE.Mesh;
  private readonly fillU: { uColor: { value: THREE.Color }; uP: { value: number }; opacity: { value: number } };
  /** The label, on its own layer over the fill (the face is glass alone). */
  private readonly labelCanvas = document.createElement("canvas");
  private readonly labelTex: THREE.CanvasTexture;
  /** What the fill shows: the progress, draining back to 0 when a hold ends short. */
  private shown = 0;
  private lastTouch = -1;
  private holdStart: number | null = null;
  private lastIn = 0;
  private fired = false;
  private readonly from = [false, false];
  /** Per hand: this tip is the one holding (it pushed in and hasn't been seen coming out). */
  private readonly holding = [false, false];
  private readonly tip = new THREE.Vector3();

  constructor(id: string, label: string, onHeld: () => void, holdMs = HOLD_MS) {
    super(id, label, () => {}, HOLD_LOOK); // a plain push does nothing: only the hold acts
    this.onHeld = onHeld;
    this.holdMs = holdMs;
    const [fw, fh] = BUTTON.face.map((v) => v / 6400);
    const uniforms = {
      uColor: { value: FILL.color },
      uHalf: { value: new THREE.Vector2(fw / 2, fh / 2) },
      uP: { value: 0 },
      uFeather: { value: FILL.feather },
      opacity: { value: 1 },
    };
    this.fillU = uniforms;
    const material = new THREE.ShaderMaterial({ uniforms, vertexShader: FILL_VERT, fragmentShader: FILL_FRAG, transparent: true, depthWrite: false });
    this.fill = new THREE.Mesh(new THREE.PlaneGeometry(fw, fh), material);
    this.fill.position.z = 0.0004;
    this.fill.visible = false;
    this.fill.userData.layer = 1;
    // the menu's fade sets the material's opacity; the shader reads it from its uniform
    this.fill.onBeforeRender = () => (uniforms.opacity.value = material.opacity * FILL.alpha);
    this.mesh.add(this.fill);
    [this.labelCanvas.width, this.labelCanvas.height] = BUTTON.canvas;
    this.labelTex = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTex.colorSpace = THREE.SRGBColorSpace;
    this.labelTex.anisotropy = 8;
    const text = new THREE.Mesh(new THREE.PlaneGeometry(...BUTTON.plane), new THREE.MeshBasicMaterial({ map: this.labelTex, transparent: true, depthWrite: false }));
    text.position.z = 0.0008;
    text.userData.layer = 2;
    this.mesh.add(text);
    this.drawLabel(label);
  }

  override setLabel(label: string): void {
    super.setLabel(label);
    this.drawLabel(label);
  }

  private drawLabel(label: string): void {
    const g = this.labelCanvas.getContext("2d")!;
    g.clearRect(0, 0, ...BUTTON.canvas);
    // a breath of white under the text (alpha 1/255, invisible): mipmapping mixes white, not black, into the glyphs' edges, so they don't thin
    g.fillStyle = "rgba(255,255,255,0.004)";
    g.fillRect(0, 0, ...BUTTON.canvas);
    paintLabel(g, label, BUTTON_STYLES[look].text.color);
    this.labelTex.needsUpdate = true;
    this.fillU.uColor.value = BUTTON_STYLES[look].fill;
  }

  /** Both index fingertips in world space (null when not tracked), once a frame from the menu. */
  override touch(fingertips: (THREE.Vector3 | null)[], now: number): void {
    if (!this.mesh.visible) return;
    let pressing = false;
    let out = false;
    let hover = false;
    for (let h = 0; h < fingertips.length; h++) {
      const tip = fingertips[h];
      if (!tip) continue; // lost to tracking: the hold rides out HOLD_GRACE_MS
      this.mesh.worldToLocal(this.tip.copy(tip));
      const { x, y, z } = this.tip;
      const over = Math.abs(x) < 0.047 && Math.abs(y) < 0.016;
      const near = Math.abs(x) < 0.08 && Math.abs(y) < 0.05;
      hover ||= over && z > -0.002 && z < 0.04;
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
    const step = this.lastTouch < 0 ? 0 : Math.min(0.05, (now - this.lastTouch) / 1000);
    this.lastTouch = now;
    this.shown = this.progress >= this.shown ? this.progress : Math.max(this.progress, this.shown - step / FILL.back);
    this.fillU.uP.value = this.shown;
    this.fill.visible = this.shown > 0.001;
    this.glowStep(now, hover || pressing, false);
  }
}

// ---------------- the caption card ----------------

/**
 * The card: the caption, then the honesty label and the credit (each in one line, or two when that keeps it large), on
 * glass at the foot of the canvas with room under it for its shadow, design px. Over the pair it is the same plane seen
 * from metres away, so its type is `pair` times larger there (its own texture, swapped in while the card is faded out).
 */
const CARD = {
  side: 30,
  foot: 24,
  pad: [26, 40, 26] as const,
  gap: 12,
  radius: 40,
  pair: 1.32,
  caption: { weight: 600, px: 38, min: 34, lead: 47, track: -0.014, color: "rgba(255,255,255,0.97)" } as TextStyle,
  label: { weight: 500, px: 28, min: 27, lead: 35, track: -0.004, color: "rgba(255,255,255,0.82)" } as TextStyle,
  credit: { weight: 500, px: 24, min: 22, lead: 31, track: 0, color: "rgba(255,255,255,0.66)" } as TextStyle,
  glass: { tint: "rgba(40,40,46,0.70)", sheen: 0.12, rim: 0.4, shadow: 0.42, blur: 26, drop: 8, grain: true } as Glass,
};
/**
 * The Reality panel, its own plane just above the card (its canvas DESIGN wide, `h` tall, the panel at its foot): a
 * legend swatch of the 3D's never-seen blue (freeze.ts REALITY_BLUE), its title, then the numbers.
 */
const REALITY = {
  h: 190,
  side: 72,
  gap: 12,
  foot: 18,
  pad: [18, 36, 20] as const,
  radius: 30,
  swatch: 20,
  blue: "rgb(70,132,255)",
  title: { weight: 600, px: 25, min: 20, lead: 34, track: -0.006, color: "rgba(255,255,255,0.97)" } as TextStyle,
  body: { weight: 500, px: 22, min: 17, lead: 29, track: 0, color: "rgba(255,255,255,0.78)" } as TextStyle,
  glass: { tint: "rgba(24,32,52,0.74)", sheen: 0.12, rim: 0.44, shadow: 0.34, blur: 20, drop: 6, grain: true } as Glass,
};
/** Metres per design px on the card's plane. */
const M_PER_PX = CAPTION_H / DESIGN[1];
/**
 * Where the watch card's top edge sits on its plane, design px from the top (where it sat before this look): the plane
 * moves so the edge stays there and a longer card grows downward, never up toward the players' feet (P43 judges the
 * floor round them).
 */
const WATCH_TOP = 196;

/** A style `k` times larger (the card over the pair). */
const bigger = (s: TextStyle, k: number): TextStyle => ({ ...s, px: Math.round(s.px * k), min: Math.round(s.min * k), lead: Math.round(s.lead * k) });

/** A canvas `h` design px tall on the card's plane, `texels` canvas px per design px: its texture and its context, cleared and under the design transform. */
class CardCanvas {
  readonly canvas = document.createElement("canvas");
  readonly tex: THREE.CanvasTexture;
  readonly g: CanvasRenderingContext2D;
  /** The panel's top edge, design px from the canvas top, once drawn. */
  top = 0;

  constructor(
    readonly h: number,
    readonly texels: number,
  ) {
    this.canvas.width = Math.round(DESIGN[0] * texels);
    this.canvas.height = Math.round(h * texels);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.g = this.canvas.getContext("2d")!;
  }

  begin(): CanvasRenderingContext2D {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(this.texels, 0, 0, this.texels, 0, 0);
    return g;
  }
}

/** Vision's card: frosted glass a touch lighter than the buttons' foot, bold display type, a hairline under the caption. */
const VISION_CARD = {
  caption: { weight: 700, px: 41, min: 35, lead: 51, track: -0.016, color: "rgba(255,255,255,0.99)", family: DISPLAY_STACK } as TextStyle,
  label: { weight: 600, px: 29, min: 27, lead: 37, track: -0.006, color: "rgba(255,255,255,0.88)", family: DISPLAY_STACK } as TextStyle,
  credit: { weight: 500, px: 25, min: 22, lead: 32, track: 0, color: "rgba(255,255,255,0.72)" } as TextStyle,
  glass: { tint: "rgba(112,114,132,0.62)", tint2: "rgba(44,46,58,0.78)", sheen: 0.2, rim: 0.8, shadow: 0.5, blur: 30, drop: 10, grain: true } as Glass,
  radius: 46,
};
/** Broadcast's lower third: a caps headline on a navy plate behind an orange bar and a COURT SIDE tab, then a light strip with the label and credit. */
const BROADCAST_CARD = {
  caption: { weight: 800, px: 44, min: 34, lead: 52, track: 0.012, color: "#ffffff", family: CONDENSED_STACK, caps: true } as TextStyle,
  label: { weight: 700, px: 28, min: 25, lead: 35, track: 0, color: "#0b1024" } as TextStyle,
  credit: { weight: 500, px: 24, min: 21, lead: 30, track: 0, color: "rgba(11,16,36,0.78)" } as TextStyle,
  plate: { tint: "rgba(26,34,66,0.97)", tint2: "rgba(7,10,24,0.97)", sheen: 0.08, rim: 0.3, shadow: 0.6, blur: 24, drop: 8 } as Glass,
  bar: 18,
  tab: { h: 34, text: { weight: 800, px: 22, min: 18, lead: 34, track: 0.08, color: "#ffffff", family: CONDENSED_STACK } as TextStyle },
};
/** Minimal: no panel, only a soft shadow behind the text and a short hairline. */
const MINIMAL_CARD = {
  caption: { weight: 600, px: 40, min: 34, lead: 50, track: -0.012, color: "rgba(255,255,255,0.99)" } as TextStyle,
  label: { weight: 500, px: 28, min: 26, lead: 36, track: 0, color: "rgba(255,255,255,0.9)" } as TextStyle,
  credit: { weight: 500, px: 24, min: 22, lead: 31, track: 0, color: "rgba(255,255,255,0.76)" } as TextStyle,
};

/** Lines of text centred (or from `left`), each `lead` tall from y; returns the y after them. */
function lines(g: CanvasRenderingContext2D, b: { style: TextStyle; lines: string[]; px: number }, y: number, x: number, align: CanvasTextAlign): number {
  setFont(g, b.style, b.px);
  g.fillStyle = b.style.color;
  g.textAlign = align;
  for (const line of b.lines) {
    g.fillText(line, x, y + b.style.lead / 2);
    y += b.style.lead;
  }
  return y;
}

/** The caption, label and credit in the current look, `k` times the watch's type; the panel's top, design px. */
function drawCard(c: CardCanvas, k: number, caption: string, label: string, credit: string): void {
  if (look === "broadcast") return drawBroadcastCard(c, k, caption, label, credit);
  const g = c.begin();
  const set = look === "vision" ? VISION_CARD : MINIMAL_CARD;
  const max = DESIGN[0] - 2 * (CARD.side + CARD.pad[1]);
  const blocks = [set.caption, set.label, set.credit].map((s, i) => {
    const style = bigger(s, k);
    return { style, ...wrap(g, [caption, label, credit][i], style, max) };
  });
  const gap = CARD.gap + 6;
  const h = CARD.pad[0] + gap + CARD.pad[2] + blocks.reduce((s, b) => s + b.lines.length * b.style.lead, 0);
  const y0 = Math.max(4, c.h - CARD.foot - h);
  const w = DESIGN[0] - 2 * CARD.side;
  g.save();
  if (look === "vision") {
    glass(g, CARD.side, y0, w, h, VISION_CARD.radius, VISION_CARD.glass, c.texels);
    specular(g, CARD.side, y0, w, h, VISION_CARD.radius, 0.16);
    g.shadowColor = "rgba(0,0,0,0.3)";
    g.shadowBlur = 6 * c.texels;
    g.shadowOffsetY = 1.5 * c.texels;
  } else {
    // a soft dark pool behind the text, no edge anywhere
    const pool = g.createRadialGradient(DESIGN[0] / 2, y0 + h / 2, 0, DESIGN[0] / 2, y0 + h / 2, w * 0.55);
    pool.addColorStop(0, "rgba(0,0,0,0.5)");
    pool.addColorStop(0.6, "rgba(0,0,0,0.3)");
    pool.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = pool;
    g.fillRect(0, Math.max(0, y0 - 20), DESIGN[0], h + 40);
    g.shadowColor = "rgba(0,0,0,0.75)";
    g.shadowBlur = 10 * c.texels;
    g.shadowOffsetY = 1.5 * c.texels;
  }
  g.textBaseline = "middle";
  let y = y0 + CARD.pad[0];
  y = lines(g, blocks[0], y, DESIGN[0] / 2, "center");
  g.shadowColor = "rgba(0,0,0,0)";
  g.fillStyle = look === "vision" ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.5)";
  const rule = look === "vision" ? w * 0.6 : 120 * k;
  g.fillRect(DESIGN[0] / 2 - rule / 2, y + gap / 2 - 0.75, rule, 1.5);
  if (look === "vision") g.shadowColor = "rgba(0,0,0,0.3)";
  else g.shadowColor = "rgba(0,0,0,0.75)";
  y += gap;
  y = lines(g, blocks[1], y, DESIGN[0] / 2, "center");
  lines(g, blocks[2], y, DESIGN[0] / 2, "center");
  g.restore();
  c.top = y0;
  c.tex.needsUpdate = true;
}

/** Broadcast's lower third (see BROADCAST_CARD); its top is the tab's. */
function drawBroadcastCard(c: CardCanvas, k: number, caption: string, label: string, credit: string): void {
  const g = c.begin();
  const B = BROADCAST_CARD;
  const x0 = CARD.side;
  const w = DESIGN[0] - 2 * CARD.side;
  const bar = B.bar * k;
  const padX = 30;
  const max = w - bar - 2 * padX;
  const cap = bigger(B.caption, k);
  const lab = bigger(B.label, k);
  const cre = bigger(B.credit, k);
  const head = { style: cap, ...wrap(g, caption.toUpperCase(), cap, max) };
  const lb = { style: lab, ...wrap(g, label, lab, max) };
  const cr = { style: cre, ...wrap(g, credit, cre, max) };
  const tabH = B.tab.h * k;
  const topH = 20 + head.lines.length * cap.lead + 16;
  const stripH = 14 + lb.lines.length * lab.lead + cr.lines.length * cre.lead + 14;
  const total = tabH + topH + stripH;
  const y0 = Math.max(4, c.h - CARD.foot - total);
  const plateY = y0 + tabH;
  // the plate and strip as one shadowed block, square-cornered but for a small radius
  glass(g, x0, plateY, w, topH + stripH, 6, B.plate, c.texels);
  g.save();
  g.beginPath();
  g.roundRect(x0, plateY, w, topH + stripH, 6);
  g.clip();
  g.fillStyle = "rgba(244,246,250,0.97)";
  g.fillRect(x0, plateY + topH, w, stripH);
  g.fillStyle = ORANGE;
  g.fillRect(x0, plateY, bar, topH + stripH);
  g.fillStyle = "rgba(255,255,255,0.18)";
  g.fillRect(x0, plateY, w, 1.5);
  g.fillStyle = ORANGE; // a thin orange rule between the tiers
  g.fillRect(x0, plateY + topH - 3, w, 3);
  g.restore();
  // the tab: COURT SIDE on orange, sitting on the plate's left
  const ts = bigger(B.tab.text, k);
  setFont(g, ts, ts.px);
  const tabText = "COURT SIDE";
  const tabW = g.measureText(tabText).width + 36 * k;
  g.fillStyle = ORANGE;
  g.beginPath();
  g.roundRect(x0, y0, tabW, tabH + 2, [6, 6, 0, 0]);
  g.fill();
  g.fillStyle = "#ffffff";
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillText(tabText, x0 + 18 * k, y0 + tabH / 2 + 1);
  let y = plateY + 20;
  y = lines(g, head, y, x0 + bar + padX, "left");
  y = plateY + topH + 14;
  y = lines(g, lb, y, x0 + bar + padX, "left");
  lines(g, cr, y, x0 + bar + padX, "left");
  c.top = y0;
  c.tex.needsUpdate = true;
}

/** The Reality panel at the foot of its canvas, `k` times the watch's type. */
function drawReality(c: CardCanvas, k: number, lines: string[]): void {
  const g = c.begin();
  const R = REALITY;
  const w = DESIGN[0] - 2 * R.side;
  const max = w - 2 * R.pad[1];
  const [title, ...body] = lines;
  const ts = bigger(R.title, k);
  const bs = bigger(R.body, k);
  const swatch = R.swatch * k;
  const head = wrap(g, title, ts, max - swatch - 12);
  const rows = body.map((l) => wrap(g, l, bs, max));
  const want = R.pad[0] + R.pad[2] + head.lines.length * ts.lead + rows.reduce((s, r) => s + r.lines.length * bs.lead, 0);
  // never taller than its canvas: the line height gives way, never the type below its min
  const fit = Math.min(1, (c.h - R.foot - 4) / want);
  const y0 = c.h - R.foot - want * fit;
  glass(g, R.side, y0, w, want * fit, R.radius, R.glass, c.texels);
  g.textBaseline = "middle";
  let y = y0 + R.pad[0] * fit;
  setFont(g, ts, head.px);
  head.lines.forEach((line, i) => {
    const tw = g.measureText(line).width;
    const left = DESIGN[0] / 2 - (swatch + 12 + tw) / 2;
    const cy = y + (ts.lead * fit) / 2;
    if (i === 0) {
      g.fillStyle = R.blue;
      g.beginPath();
      g.roundRect(left, cy - swatch / 2, swatch, swatch, 6 * k);
      g.fill();
    }
    g.fillStyle = ts.color;
    g.textAlign = "left";
    g.fillText(line, left + swatch + 12, cy + 1);
    y += ts.lead * fit;
  });
  g.textAlign = "center";
  for (const r of rows) {
    setFont(g, bs, r.px);
    g.fillStyle = bs.color;
    for (const line of r.lines) {
      g.fillText(line, DESIGN[0] / 2, y + (bs.lead * fit) / 2);
      y += bs.lead * fit;
    }
  }
  c.top = y0;
  c.tex.needsUpdate = true;
}

/**
 * The caption, label and credit card (drawn once per placement's type size), and the Reality check's panel: its own plane
 * just above the card, drawn once per change of its lines, fading and rising in while it's on.
 */
class CaptionPanel {
  readonly mesh: THREE.Mesh;
  /** The Reality panel's plane (a child of the card), for the card's sight-line test. */
  readonly reality: THREE.Mesh;
  readonly lines: string[] = [];
  /** The fade (0-1) and the near fade over the pair (0-1): drawn at their product. */
  private level = 0;
  private nearness = 1;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly realityMaterial: THREE.MeshBasicMaterial;
  private readonly cards = { front: new CardCanvas(DESIGN[1], TEXELS.front), pair: new CardCanvas(DESIGN[1], TEXELS.pair) };
  private readonly realities = { front: new CardCanvas(REALITY.h, TEXELS.front), pair: new CardCanvas(REALITY.h, TEXELS.pair) };
  private placement: "front" | "pair" = "front";
  /** The Reality panel: on or off, how far shown (0-1, linear in time), the lines it was drawn with. */
  private realityOn = false;
  private realityT = 0;
  private realityLines: string[] = [];
  private text: string[] = [];
  /** The Reality plane's resting height in the card's plane, metres. */
  private realityY = 0;

  constructor() {
    this.material = new THREE.MeshBasicMaterial({ map: this.cards.front.tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(CAPTION_W, CAPTION_H), this.material);
    this.mesh.name = "court-caption";
    this.mesh.renderOrder = 100; // over the arena, under the fade-jump veil
    this.mesh.visible = false;
    this.realityMaterial = new THREE.MeshBasicMaterial({ map: this.realities.front.tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    this.reality = new THREE.Mesh(new THREE.PlaneGeometry(CAPTION_W, REALITY.h * M_PER_PX), this.realityMaterial);
    this.reality.name = "court-reality";
    this.reality.renderOrder = 101;
    this.reality.visible = false;
    this.mesh.add(this.reality);
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

  /** How far the watch's plane sits below its place so the card's top edge stays at WATCH_TOP, metres. */
  get frontDrop(): number {
    return (WATCH_TOP - this.cards.front.top) * M_PER_PX;
  }

  /** How far the Reality panel shows, 0-1: its own fade alone (the card's is on top of it). */
  get realityShown(): number {
    return easeOut(this.realityT);
  }

  /** Low in front (the watch's type) or over the pair (larger type): swapped while the card is faded out. */
  place(placement: "front" | "pair"): void {
    this.placement = placement;
    this.material.map = this.cards[placement].tex; // one map for another: the same program, no recompile
    this.realityMaterial.map = this.realities[placement].tex;
    this.restReality();
  }

  /** Once a frame: the Reality panel's fade (ease-out in, ease-in out) and its rise into place. */
  step(dt: number): void {
    this.realityT = Math.min(1, Math.max(0, this.realityT + (this.realityOn ? dt : -dt) / REALITY_FADE.s));
    this.reality.position.set(0, this.realityY - (1 - this.realityShown) * REALITY_FADE.rise, 0.0005);
    this.apply();
  }

  private apply(): void {
    this.material.opacity = this.level * this.nearness;
    this.mesh.visible = this.material.opacity > 0.001;
    this.realityMaterial.opacity = this.material.opacity * this.realityShown;
    this.reality.visible = this.realityMaterial.opacity > 0.001;
  }

  /** The Reality plane's foot `gap` above the card's top edge (the panel's own shadow overlaps the card a little). */
  private restReality(): void {
    const top = this.cards[this.placement].top;
    const foot = top - REALITY.gap + REALITY.foot; // design px from the card canvas's top
    this.realityY = CAPTION_H / 2 - (foot - REALITY.h / 2) * M_PER_PX;
  }

  /** The caption, label and credit (the bundle's: drawn once, in both type sizes). */
  draw(caption: string, label: string, credit: string): void {
    drawCard(this.cards.front, 1, caption, label, credit);
    drawCard(this.cards.pair, CARD.pair, caption, label, credit);
    this.text = [caption, label, credit];
    this.restReality();
    this.lines.splice(0, this.lines.length, ...(this.realityOn ? this.realityLines : []), ...this.text);
  }

  /** The Reality check's lines (the legend first), or null while it's off: the panel fades in or out; it's redrawn only when its lines change. */
  setReality(lines: string[] | null): void {
    this.realityOn = !!lines;
    if (lines && lines.join("\n") !== this.realityLines.join("\n")) {
      drawReality(this.realities.front, 1, lines);
      drawReality(this.realities.pair, CARD.pair, lines);
      this.realityLines = [...lines];
    }
    this.lines.splice(0, this.lines.length, ...(this.realityOn ? this.realityLines : []), ...this.text);
  }
}

/** A critically damped glide of `p` toward `to` carrying velocity `v`, settling in about `time` s (Game Programming Gems 4's SmoothDamp). */
function glide(p: THREE.Vector3, to: THREE.Vector3, v: THREE.Vector3, time: number, dt: number): void {
  const w = 2 / time;
  const x = w * dt;
  const k = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  for (const a of ["x", "y", "z"] as const) {
    const change = p[a] - to[a];
    const temp = (v[a] + w * change) * dt;
    v[a] = (v[a] - w * temp) * k;
    p[a] = to[a] + (change + temp) * k;
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

/** What the e2e reads (probe pages only). */
export interface UiProbe {
  menuOpen(): boolean;
  /** The buttons on the menu now, top row first: id, label, lit, and the world points just in front of and inside the face. */
  buttons(): { id: string; label: string; on: boolean; front: number[]; inside: number[] }[];
  /** Seat here's holds (start and fired, in the frame loop's `now` ms). */
  holds(): { start: number; fired: number | null }[];
  /** The look the surfaces are painted in. */
  look(): LookName;
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
  /** The card's fade, 0-1, linear in time (drawn eased). */
  private fade = 0;
  /** The watch's glide back in front: on once you've turned away, and its velocity. */
  private gliding = false;
  private readonly glideV = new THREE.Vector3();
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
  private readonly toCourt = new THREE.Matrix4();
  /** The card's plane and the Reality panel's, with their sizes, for the sight-line test. */
  private readonly planes: [THREE.Object3D, number, number][] = [
    [this.caption.mesh, CAPTION_W, CAPTION_H],
    [this.caption.reality, CAPTION_W, REALITY.h * M_PER_PX],
  ];
  private readonly headV = new THREE.Vector3();
  private readonly target = new THREE.Vector3();

  constructor(scene: THREE.Scene, hands: THREE.Object3D[], sideOf: (i: number) => XRHandedness | null, bundle: CourtBundle) {
    this.scene = scene;
    this.hands = hands;
    this.sideOf = sideOf;
    this.bundle = bundle;
    this.menu = new HandMenu(hands, sideOf, scene, 2, MENU_EASE);
    const button = (action: UiAction, label: string, look = LOOK) => new XrButton(action, label, () => this.press(action), look);
    this.seatHere = new HoldButton("seatHere", "Hold to seat here", () => this.press("seatHere"));
    this.b = {
      step: button("step", "Step into the court"),
      back: button("back", "Back to my seat"),
      reality: button("reality", "Reality check"),
      replay: button("replay", "Reset"), // the show from the top: the video, then the 3D again
      room: button("room", ROOM_OUT, courtLook(windowGlyph)),
      closer: button("closer", "Walk closer"),
      nextView: button("nextView", "Next view"),
      seatHere: this.seatHere,
      changeSeat: new HoldButton("changeSeat", "Hold to change seat", () => this.press("changeSeat")),
      look: button("look", lookLabel()),
    };
    // the menu over the footage; a button's own layers (a hold's fill, then its label) over its face
    for (const btn of Object.values(this.b)) btn.mesh.traverse((o) => (o.renderOrder = MENU_ORDER + (o === btn.mesh ? 0 : (o.userData.layer ?? 1))));
    this.world = scene.getObjectByName("court-world") ?? null;
    this.overPair.copy(overPair(bundle));
    this.blockers = blockers(bundle);
    scene.add(this.caption.mesh);
    this.caption.draw(bundle.court.caption, bundle.court.label, bundle.court.credit);
    this.drawCaption();
    this.relayout();
    if (typeof window !== "undefined" && window.__court) window.__courtUi = this.probe();
  }

  /** The next look (LookName): every button and the card repainted in it, nothing moved (court.ts's "look" handler). */
  cycleLook(): void {
    look = LOOK_NAMES[(LOOK_NAMES.indexOf(look) + 1) % LOOK_NAMES.length];
    this.b.look.setLabel(lookLabel());
    // a button repaints its face (and a hold button its label layer) on a new label: give each its own back
    for (const btn of Object.values(this.b)) btn.setLabel((btn as unknown as { label: string }).label);
    const c = this.bundle.court;
    this.caption.draw(c.caption, c.label, c.credit);
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
    const rate = mode !== this.mode ? 1 / FADE.swap : want ? 1 / FADE.in : 1 / FADE.out;
    this.fade = Math.min(1, Math.max(0, this.fade + Math.sign(want - this.fade) * dt * rate));
    if (mode !== this.mode && this.fade <= 0) {
      this.mode = mode;
      this.placed = false;
      cap.place(mode);
    }
    const shown = easeOut(this.fade);
    cap.opacity = shown;
    cap.step(dt);
    // it grows into place as it fades in, and shrinks a little as it goes
    const appear = FADE.from + (1 - FADE.from) * shown;
    const m = cap.mesh;
    if (this.mode === "pair" && this.world) {
      this.world.updateWorldMatrix(true, false);
      m.position.copy(this.overPair);
      this.world.localToWorld(m.position);
      const far = m.position.distanceTo(this.headV);
      const scale = appear * Math.min(OVER_PAIR.scale[1], Math.max(OVER_PAIR.scale[0], (far * Math.tan(((OVER_PAIR.deg / 2) * Math.PI) / 180) * 2) / CAPTION_W));
      m.scale.setScalar(scale);
      // the lower edge stays put; the card grows upward (the court group turns about y only, so up is up)
      m.position.add(this.lift.set(0, (CAPTION_H * scale) / 2, 0));
      const [full, gone] = OVER_PAIR.near;
      const near = Math.min(1, Math.max(0, (m.position.distanceTo(this.headV) - gone) / (full - gone)));
      m.lookAt(this.headV);
      this.clearView = Math.min(1, Math.max(0, this.clearView + (this.blocked(m) ? -1 : 1) * (dt / BLOCK.fade)));
      cap.near = near * smooth(this.clearView);
      return;
    }
    m.scale.setScalar(appear);
    this.clearView = 1;
    cap.near = 1;
    const fx = -Math.sin(head.yaw);
    const fz = -Math.cos(head.yaw);
    this.target.set(head.room[0] + fx * 1.05, head.room[1] - 0.42 - cap.frontDrop, head.room[2] + fz * 1.05);
    if (!this.placed) {
      m.position.copy(this.target);
      this.glideV.set(0, 0, 0);
      this.gliding = false;
      this.placed = true;
    } else {
      const dx = m.position.x - head.room[0];
      const dz = m.position.z - head.room[2];
      const off = Math.abs(Math.atan2(dx * fz - dz * fx, dx * fx + dz * fz));
      const dist = Math.hypot(dx, dz);
      const dy = Math.abs(m.position.y - this.target.y);
      if (off > (30 * Math.PI) / 180 || Math.abs(dist - 1.05) > 0.45 || dy > 0.3) this.gliding = true;
      if (this.gliding) {
        glide(m.position, this.target, this.glideV, FOLLOW.time, dt);
        if (m.position.distanceTo(this.target) < FOLLOW.settle && this.glideV.length() < FOLLOW.still) {
          this.gliding = false;
          this.glideV.set(0, 0, 0);
        }
      }
    }
    m.lookAt(this.headV);
  }

  /** Whether a person (BLOCK) stands between the eye and any of the card's grid points (and the Reality panel's, while it shows). */
  private blocked(m: THREE.Mesh): boolean {
    if (!this.world) return false;
    m.updateMatrixWorld(true);
    this.toCourt.copy(this.world.matrixWorld).invert();
    this.eyeC.copy(this.headV).applyMatrix4(this.toCourt);
    const [nu, nv] = BLOCK.grid;
    for (let k = 0; k < (this.caption.realityShown > 0 ? 2 : 1); k++) {
      const [plane, w, h] = this.planes[k];
      for (let i = 0; i < nu; i++)
        for (let j = 0; j < nv; j++) {
          this.ptC.set((i / (nu - 1) - 0.5) * w, (j / (nv - 1) - 0.5) * h, 0);
          plane.localToWorld(this.ptC).applyMatrix4(this.toCourt);
          const reach = this.eyeC.distanceTo(this.ptC);
          this.ray.origin.copy(this.eyeC);
          this.ray.direction.subVectors(this.ptC, this.eyeC).normalize();
          // the nearest point of the sight line to a capsule's axis is inside it, and nearer than the card
          for (const { a, b, r } of this.blockers) if (this.ray.distanceSqToSegment(a, b, this.hitC) < r * r && this.eyeC.distanceTo(this.hitC) < reach) return true;
        }
    }
    return false;
  }

  /** The Reality panel's lines while Reality check is on (the card itself is drawn once). */
  private drawCaption(): void {
    const c = this.bundle.court;
    this.caption.setReality(
      this.flags.reality
        ? [
            "Blue: what the camera never saw",
            c.freeze.players.map((p) => `${p.name} ${Math.round(p.seenFraction * 100)}% seen`).join(" · "),
            `In-between frames interpolated: ${Math.round(c.metrics.interpShare * 100)}% of the show`,
          ]
        : null,
    );
  }

  /** The menu's rows for this phase (top row first); the bottom row is always [Replay, See my room]. */
  private rows(): XrButton[][] {
    const b = this.b;
    if (this.flags.setup) return [[b.seatHere], [b.room]];
    const rows: XrButton[][] = [[b.changeSeat, b.look]];
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
      look: () => look,
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
