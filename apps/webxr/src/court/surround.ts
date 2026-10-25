// The arena round the footage when a bundle carries `surround` (format.ts SurroundInfo): the maths, three-free so
// surround.test.ts runs it under node. The imagined bowl (world.ts draws it, one merged mesh) is a rounded rectangle
// of seating round the court: 20 lower tiers rising from just beyond the apron (pushed back behind the footage's
// stands proxy where that stands farther out, so the far image always owns the space in front of it), an LED dasher
// at their foot, the ribbon board on the upper deck's fascia, 14 steeper upper tiers, a back wall, a dark domed roof
// and a centre-hung scoreboard. Each tier carries one row of real crowd from `surround.crowd`'s atlas on a billboard
// standing on its tread, the tiles laid along it at real scale (pxPerM), chosen and mirrored at random per section;
// a few tiers in a row share their tiles (the same columns on the straights), each showing the next of the tile's
// rows, so a tile shows whole and its rows sit on the tiers. The mesh is written back to front
// (it draws without depth), every face toward the court. `farCamera` is the far image's pinhole camera (camera F's
// centre and rotation, its own intrinsics): proxies.ts projects it onto the floor, the stands proxy and the backboard.
import type { PinholeCamera } from "./camera";
import type { Court, ShowFrame, SurroundCrowd, SurroundFar } from "./format";

/** The out-of-bounds apron (world.ts's floor shader stains it), metres past the lines. */
export const APRON_M = 2.0;
/** The lower bowl: its tiers, the first tread's height, the billboard's place on its tread and a seated person's height over it. */
export const LOWER = { rows: 20, tread: 0.85, rise: 0.4, firstTread: 0.45, seat: 0.3, person: 0.8, gap: 0.6 } as const;
/** The upper deck: steeper tiers above the ribbon board. */
export const UPPER = { rows: 14, tread: 0.8, rise: 0.5, person: 0.9 } as const;
/** The bowl's inner corners are rounded by this, metres: at most LOWER.gap x (2 + sqrt 2), so the apron's corner stays clear. */
const CORNER_R = 2.0;
/** The LED dasher at the bowl's foot, metres tall (and just off the inner edge, so it never stands on the apron). */
export const DASHER = { o: 0.02, h: 0.9 };
/** The lower bowl's back wall, the ribbon board and the upper deck's parapet: one band behind the top tier. */
const BACK_O = LOWER.seat + (LOWER.rows - 1) * LOWER.tread + 0.55;
const RIBBON = { y0: LOWER.firstTread + (LOWER.rows - 1) * LOWER.rise + LOWER.person + 0.35, h: 1.0 };
const PARAPET_H = 0.4;
/** The upper deck's first tread and billboard offsets. */
const UPPER_Y0 = RIBBON.y0 + RIBBON.h + PARAPET_H + 0.2;
const UPPER_O0 = BACK_O + 0.9;
const UPPER_BACK_O = UPPER_O0 + (UPPER.rows - 1) * UPPER.tread + 0.6;
/** The roof: its height at the upper deck's back wall and at the centre (a shallow dome). */
const ROOF = { edge: 24, top: 26.5 };
/** The centre-hung scoreboard: half sizes and height of its box, and the LED band under it. */
const BOARD = { hx: 4.2, hz: 3.2, y0: 14, y1: 18.5, band: { inset: 0.5, y0: 13.4 } };
/** Arc segments every this many radians (chord sag under 6 mm on the inner corners). */
const ARC_STEP = (6 * Math.PI) / 180;
/** Segments per corner arc in ringPoints (each arc is ARC_N + 1 points). */
const ARC_N = Math.max(1, Math.ceil(Math.PI / 2 / ARC_STEP));
/**
 * The crowd's rows as the tiles show them on the stands wall (surround.crowd's vertical metres): the broadcast camera
 * looks up the rake, so a seat row's 0.4 m rise shows as ~0.475 m between head rows. A tile holds round(its height /
 * this) rows; each tier shows one of them over its own rise.
 */
export const SEEN_ROW = 0.475;
/** Without crowd tiles the procedural crowd's virtual tile is this wide, metres. */
const VIRTUAL_TILE_M = 6;

/** What each part of the bowl is (the shader's aInfo.x). */
export const BOWL_KIND = { crowd: 0, upper: 1, led: 2, structure: 3, roof: 4, board: 5, screen: 6 } as const;

/** The lower bowl's inner edge: a rounded rectangle in court space (x0 < x1 along the court, z0 < z1 across it). */
export interface BowlLayout {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  r: number;
}

/**
 * The bowl's inner edge: LOWER.gap past the apron on every side, except where a vertical stands proxy plane facing
 * the court along an axis stands farther out: that end starts at the nearest such plane, so the bowl is behind the
 * footage's surface there (the far image shows in front of it; off camera F's ray the far image fades and the bowl
 * behind it shows).
 */
export function bowlLayout(court: Court): BowlLayout {
  const hl = court.court.length / 2 + APRON_M + LOWER.gap;
  const hw = court.court.width / 2 + APRON_M + LOWER.gap;
  const l = { x0: -hl, x1: hl, z0: -hw, z1: hw, r: CORNER_R };
  // the nearest plane on each side, when it is farther out than the default front
  const near = { x0: Infinity, x1: Infinity, z0: Infinity, z1: Infinity };
  for (const { points: p } of court.freeze.stands.proxy) {
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const w = [p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const [nx, , nz] = n.map((v) => v / len);
    const mx = p.reduce((s, c) => s + c[0], 0) / p.length;
    const mz = p.reduce((s, c) => s + c[2], 0) / p.length;
    if (Math.abs(nx) > 0.9) {
      if (mx > 0) near.x1 = Math.min(near.x1, mx);
      else near.x0 = Math.min(near.x0, -mx);
    } else if (Math.abs(nz) > 0.9) {
      if (mz > 0) near.z1 = Math.min(near.z1, mz);
      else near.z0 = Math.min(near.z0, -mz);
    }
  }
  if (near.x1 < Infinity && near.x1 > l.x1) l.x1 = near.x1;
  if (near.x0 < Infinity && near.x0 > -l.x0) l.x0 = -near.x0;
  if (near.z1 < Infinity && near.z1 > l.z1) l.z1 = near.z1;
  if (near.z0 < Infinity && near.z0 > -l.z0) l.z0 = -near.z0;
  l.r = Math.min(l.r, (l.x1 - l.x0) / 2, (l.z1 - l.z0) / 2);
  return l;
}

/** Signed distance from (x, z) to the inner edge, positive outside it (the GLSL twin is proxies.ts's bowlDistance). */
export function bowlDistance(l: BowlLayout, x: number, z: number): number {
  const qx = Math.max(l.x0 + l.r - x, x - (l.x1 - l.r));
  const qz = Math.max(l.z0 + l.r - z, z - (l.z1 - l.r));
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - l.r;
}

/** True on the court, the apron and the floor up to the bowl's foot (the far image's floor stops there). */
export function insideBowl(l: BowlLayout, x: number, z: number): boolean {
  return bowlDistance(l, x, z) < 0;
}

/**
 * The inner edge offset outward by o metres, as a closed polyline [x, z] (the first point repeated last), running
 * counter-clockwise seen from above (+x end toward +z first), so a quad from point i to i + 1 wound bottom-left,
 * bottom-right, top-right faces the court.
 */
export function ringPoints(l: BowlLayout, o: number): [number, number][] {
  const R = l.r + o;
  const centres: [number, number, number][] = [
    [l.x1 - l.r, l.z1 - l.r, 0],
    [l.x0 + l.r, l.z1 - l.r, Math.PI / 2],
    [l.x0 + l.r, l.z0 + l.r, Math.PI],
    [l.x1 - l.r, l.z0 + l.r, (3 * Math.PI) / 2],
  ];
  const pts: [number, number][] = [];
  for (const [cx, cz, a0] of centres)
    for (let i = 0; i <= ARC_N; i++) {
      const a = a0 + (i / ARC_N) * (Math.PI / 2);
      pts.push([cx + R * Math.cos(a), cz + R * Math.sin(a)]);
    }
  pts.push([...pts[0]]);
  return pts;
}

/** The far image's pinhole camera: camera F's centre, frames[far.frame]'s rotation, the image's own intrinsics. */
export function farCamera(court: Court, frames: readonly ShowFrame[], far: SurroundFar): PinholeCamera {
  const q = frames[Math.min(frames.length - 1, Math.max(0, far.frame))].q;
  return { centre: [...court.camera.centre], q: [...q], f: far.f, cx: far.cx, cy: far.cy, width: far.width, height: far.height };
}

/** The bowl as typed arrays: positions (court space), surface coordinates, the crowd tile's atlas rect, and per-vertex info. */
export interface BowlArrays {
  position: Float32Array;
  /** Crowd: (u across the tile 0-1, metres down from the billboard's top); else metres along and up (the patterns' coordinates). */
  surf: Float32Array;
  /** Crowd: the tile's atlas rect (u0, v0, u1, v1), texture coordinates with v up (u0 > u1: mirrored); zeros without an atlas. */
  tile: Float32Array;
  /** (BOWL_KIND, the tier's row in its tile, rows per tile, brightness 0.92-1.08); for the LED: (kind, 0 dasher / 1 ribbon / 2 band). */
  info: Float32Array;
  index: Uint32Array;
}

/** mulberry32: a small seeded generator, so the bowl is the same on every load. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build the bowl's merged geometry for a court and its crowd tiles (null: the procedural crowd), back to front. */
export function bowlArrays(court: Court, crowd: SurroundCrowd | null, seed = 1): BowlArrays {
  const l = bowlLayout(court);
  const pos: number[] = [];
  const surf: number[] = [];
  const tile: number[] = [];
  const info: number[] = [];
  const index: number[] = [];
  const vertex = (p: readonly number[], s: readonly number[], t: readonly number[], i: readonly number[]) => {
    pos.push(p[0], p[1], p[2]);
    surf.push(s[0], s[1]);
    tile.push(t[0], t[1], t[2], t[3]);
    info.push(i[0], i[1], i[2], i[3]);
  };
  /** A quad a, b, c, d (counter-clockwise from its front), one attribute set, surface coordinates per corner. */
  const quad = (c: number[][], s: number[][], t: readonly number[], i: readonly number[]) => {
    const v = pos.length / 3;
    for (let k = 0; k < 4; k++) vertex(c[k], s[k], t, i);
    index.push(v, v + 1, v + 2, v, v + 2, v + 3);
  };
  const NO_TILE = [0, 0, 0, 0];
  /** A vertical band round the ring at offset o, from y0 to y1 (a wall, an LED board). */
  const band = (o: number, y0: number, y1: number, i: readonly number[]) => {
    const pts = ringPoints(l, o);
    let s = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [a, b] = [pts[k], pts[k + 1]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-9) continue;
      quad([[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]], [[s, 0], [s + len, 0], [s + len, y1 - y0], [s, y1 - y0]], NO_TILE, i);
      s += len;
    }
  };
  // the crowd tiles: atlas rects (v up, inset two texels: the first mips keep to the tile, farther ones may take in a
  // little of the dark gap round it), widths in metres, rows per tile
  const tiles = (crowd?.tiles ?? []).map((b) => {
    const [W, H] = [crowd!.width, crowd!.height];
    return {
      rect: [(b[0] + 2) / W, 1 - (b[3] - 2) / H, (b[2] - 2) / W, 1 - (b[1] + 2) / H],
      widthM: (b[2] - b[0]) / crowd!.pxPerM,
      heightM: (b[3] - b[1]) / crowd!.pxPerM,
    };
  });
  /** Tiers that share their tiles: the fewest rows any tile holds (its rows stacked up those tiers). */
  const rowsOf = (heightM: number) => Math.max(1, Math.round(heightM / SEEN_ROW));
  const group = tiles.length ? Math.min(...tiles.map((t) => rowsOf(t.heightM))) : 1;
  /**
   * One tier of crowd: billboards round the ring at offset o standing on tread y, tiles laid along it at real scale,
   * from the start of each of the ring's 8 sections (4 corners, 4 straights). Tier r of the deck is row r mod G of
   * its group's tiles (G tiers a group): the group's tiers draw the same tiles, so on the straights their columns
   * line up and each tile shows whole, its top G rows one per tier.
   */
  const tier = (kind: number, o: number, y: number, r: number, G: number) => {
    const pts = ringPoints(l, o);
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const total = cum.at(-1)!;
    const at = (s: number): [number, number] => {
      let k = 1;
      while (k < cum.length - 1 && cum[k] < s) k++;
      const t = (s - cum[k - 1]) / Math.max(cum[k] - cum[k - 1], 1e-9);
      return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t];
    };
    const top = y + (kind === BOWL_KIND.upper ? UPPER.person : LOWER.person);
    const h = top - y;
    // the sections: each corner arc, then the straight after it
    const bounds = [0];
    for (let i = 0; i < 4; i++) bounds.push(cum[i * (ARC_N + 1) + ARC_N], i < 3 ? cum[(i + 1) * (ARC_N + 1)] : total);
    const [p, g] = [r % G, Math.floor(r / G)];
    for (let si = 0; si + 1 < bounds.length; si++) {
      const random = rng(seed * 1000003 + kind * 10007 + g * 101 + si);
      for (let s = bounds[si]; s < bounds[si + 1] - 1e-6; ) {
        // a tile, at random and either way round (the same for the group's tiers)
        const pick = tiles.length ? tiles[Math.floor(random() * tiles.length)] : null;
        const w = pick ? pick.widthM : VIRTUAL_TILE_M;
        const k = pick ? rowsOf(pick.heightM) : 1;
        const row = k - G + p;
        const mirror = random() < 0.5;
        const shade = 0.92 + 0.16 * random();
        const rect = pick ? (mirror ? [pick.rect[2], pick.rect[1], pick.rect[0], pick.rect[3]] : pick.rect) : NO_TILE;
        const end = Math.min(bounds[si + 1], s + w);
        // split at the ring's own corners inside [s, end]
        const cuts = [s, ...cum.filter((c) => c > s + 1e-6 && c < end - 1e-6), end];
        for (let c = 0; c + 1 < cuts.length; c++) {
          const [a, b] = [at(cuts[c]), at(cuts[c + 1])];
          const [ua, ub] = [(cuts[c] - s) / w, (cuts[c + 1] - s) / w];
          quad([[a[0], y, a[1]], [b[0], y, b[1]], [b[0], top, b[1]], [a[0], top, a[1]]], [[ua, h], [ub, h], [ub, 0], [ua, 0]], rect, [kind, row, k, shade]);
        }
        s = end;
      }
    }
  };

  // the roof: a shallow dome over everything, a fan from its centre (faces down)
  {
    const pts = ringPoints(l, UPPER_BACK_O);
    const cx = (l.x0 + l.x1) / 2;
    const cz = (l.z0 + l.z1) / 2;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [a, b] = [pts[k], pts[k + 1]];
      const v = pos.length / 3;
      // centre, a, b: its front faces down
      vertex([cx, ROOF.top, cz], [cx, cz], NO_TILE, [BOWL_KIND.roof, 0, 0, 0]);
      vertex([a[0], ROOF.edge, a[1]], [a[0], a[1]], NO_TILE, [BOWL_KIND.roof, 0, 0, 0]);
      vertex([b[0], ROOF.edge, b[1]], [b[0], b[1]], NO_TILE, [BOWL_KIND.roof, 0, 0, 0]);
      index.push(v, v + 1, v + 2);
    }
  }
  // the upper deck: its back wall, the tiers outermost first, the parapet and the ribbon board on its fascia
  band(UPPER_BACK_O, UPPER_Y0 + (UPPER.rows - 3) * UPPER.rise, ROOF.edge + 0.01, [BOWL_KIND.structure, 1, 0, 0]);
  for (let u = UPPER.rows - 1; u >= 0; u--) tier(BOWL_KIND.upper, UPPER_O0 + u * UPPER.tread, UPPER_Y0 + u * UPPER.rise, u, group);
  band(BACK_O, RIBBON.y0 + RIBBON.h, RIBBON.y0 + RIBBON.h + PARAPET_H, [BOWL_KIND.structure, 2, 0, 0]);
  band(BACK_O, RIBBON.y0, RIBBON.y0 + RIBBON.h, [BOWL_KIND.led, 1, 0, 0]);
  // the lower bowl: its back wall, the tiers outermost first, the LED dasher at its foot
  band(BACK_O, LOWER.firstTread + (LOWER.rows - 6) * LOWER.rise, RIBBON.y0, [BOWL_KIND.structure, 0, 0, 0]);
  for (let r = LOWER.rows - 1; r >= 0; r--) tier(BOWL_KIND.crowd, LOWER.seat + r * LOWER.tread, LOWER.firstTread + r * LOWER.rise, r, group);
  band(DASHER.o, 0, DASHER.h, [BOWL_KIND.led, 0, 0, 0]);
  // the centre-hung scoreboard over centre court: its bottom, the four screens, then the LED band under it (faces out)
  {
    const { hx, hz, y0, y1 } = BOARD;
    const box = (x: number, z: number, b0: number, b1: number, side: number, under: number) => {
      quad([[-x, b0, -z], [x, b0, -z], [x, b0, z], [-x, b0, z]], [[0, 0], [1, 0], [1, 1], [0, 1]], NO_TILE, [under, 2, 0, 0]);
      const faces: [number[], number[]][] = [
        [[-x, z], [x, z]], [[x, z], [x, -z]], [[x, -z], [-x, -z]], [[-x, -z], [-x, z]],
      ];
      for (const [a, b] of faces)
        quad([[a[0], b0, a[1]], [b[0], b0, b[1]], [b[0], b1, b[1]], [a[0], b1, a[1]]], [[0, 0], [1, 0], [1, 1], [0, 1]], NO_TILE, [side, 2, 0, 0]);
    };
    box(hx, hz, y0, y1, BOWL_KIND.screen, BOWL_KIND.board);
    // the top, seen only from far off
    quad([[-hx, y1, hz], [hx, y1, hz], [hx, y1, -hz], [-hx, y1, -hz]], [[0, 0], [1, 0], [1, 1], [0, 1]], NO_TILE, [BOWL_KIND.board, 2, 0, 0]);
    box(hx - BOARD.band.inset, hz - BOARD.band.inset, BOARD.band.y0, y0, BOWL_KIND.led, BOWL_KIND.board);
  }
  return {
    position: new Float32Array(pos),
    surf: new Float32Array(surf),
    tile: new Float32Array(tile),
    info: new Float32Array(info),
    index: new Uint32Array(index),
  };
}

// ---------------- the surround's tone: the pan's mosaic (the far image, the crowd tiles) to the plate's exposure ----------------

/**
 * The surround's footage is a mosaic of the pan, blended flatter and a little warmer than the broadcast's own plate.
 * The curve that takes it back, measured where the far image and F's clean plate show the same rays: per-channel
 * gains (their medians matched), then log luminance through five knots (the mosaic's percentiles onto the plate's),
 * slope 1 beyond them. proxies.ts measures it; the far image and the bowl's crowd tiles (cut from the same mosaic)
 * go through it (TONE_GLSL).
 */
export interface ToneCurve {
  gain: [number, number, number];
  /** log(luminance + TONE_EPS) knots: the mosaic's (x) and the plate's (y). */
  x: number[];
  y: number[];
}
export const TONE_EPS = 1e-3;
const TONE_P = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The curve never stretches or squeezes a stretch of log luminance more than this. */
const TONE_SLOPE: [number, number] = [0.6, 2.0];
/** Fewer paired samples than this: the identity. */
const TONE_MIN = 2000;
export const TONE_IDENTITY: ToneCurve = { gain: [1, 1, 1], x: [-6, -5, -4, -3, -2], y: [-6, -5, -4, -3, -2] };

const LUMA = [0.2126, 0.7152, 0.0722];
const lumaOf = (r: number, g: number, b: number) => LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
const quantile = (sorted: Float64Array, p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

/** The curve from paired linear RGB samples of the mosaic and the plate (the same rays, the same count). */
export function toneCurve(far: ArrayLike<number>, plate: ArrayLike<number>): ToneCurve {
  const n = Math.min(far.length, plate.length) / 3;
  if (n < TONE_MIN) return structuredClone(TONE_IDENTITY);
  const median = (a: ArrayLike<number>, c: number) => {
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = a[3 * i + c];
    return quantile(v.sort(), 0.5);
  };
  const gain = [0, 1, 2].map((c) => {
    const mf = median(far, c);
    return mf > 1e-6 ? Math.min(2, Math.max(0.5, median(plate, c) / mf)) : 1;
  }) as [number, number, number];
  const lf = new Float64Array(n);
  const lp = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lf[i] = Math.log(lumaOf(far[3 * i] * gain[0], far[3 * i + 1] * gain[1], far[3 * i + 2] * gain[2]) + TONE_EPS);
    lp[i] = Math.log(lumaOf(plate[3 * i], plate[3 * i + 1], plate[3 * i + 2]) + TONE_EPS);
  }
  lf.sort();
  lp.sort();
  const x = TONE_P.map((p) => quantile(lf, p));
  const y = TONE_P.map((p) => quantile(lp, p));
  // knots strictly increasing, and each segment's slope within TONE_SLOPE, built out from the median
  for (let i = 1; i < x.length; i++) x[i] = Math.max(x[i], x[i - 1] + 1e-3);
  const m = TONE_P.indexOf(0.5);
  const clampSlope = (dy: number, dx: number) => Math.min(TONE_SLOPE[1], Math.max(TONE_SLOPE[0], dy / dx)) * dx;
  for (let i = m + 1; i < x.length; i++) y[i] = y[i - 1] + clampSlope(y[i] - y[i - 1], x[i] - x[i - 1]);
  for (let i = m - 1; i >= 0; i--) y[i] = y[i + 1] - clampSlope(y[i + 1] - y[i], x[i + 1] - x[i]);
  return { gain, x, y };
}

/** A linear RGB colour through the curve (TONE_GLSL's toneToPlate). */
export function toneApply(c: readonly number[], t: ToneCurve): [number, number, number] {
  const g = [c[0] * t.gain[0], c[1] * t.gain[1], c[2] * t.gain[2]];
  const l = lumaOf(g[0], g[1], g[2]);
  const x = Math.log(l + TONE_EPS);
  const k = t.x.length - 1;
  let y = x - t.x[0] + t.y[0];
  for (let i = 0; i < k; i++) if (x >= t.x[i]) y = t.y[i] + ((x - t.x[i]) * (t.y[i + 1] - t.y[i])) / Math.max(t.x[i + 1] - t.x[i], 1e-4);
  if (x > t.x[k]) y = t.y[k] + (x - t.x[k]);
  const s = Math.max(Math.exp(y) - TONE_EPS, 0) / Math.max(l, 1e-6);
  return [g[0] * s, g[1] * s, g[2] * s];
}

/** toneApply in GLSL: uniforms uToneGain (vec3), uToneX[5], uToneY[5] (toneUniforms). */
export const TONE_GLSL = /* glsl */ `
uniform vec3 uToneGain;
uniform float uToneX[5];
uniform float uToneY[5];
vec3 toneToPlate(vec3 lin) {
  vec3 c = lin * uToneGain;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float x = log(l + ${TONE_EPS.toExponential()});
  float y = x - uToneX[0] + uToneY[0];
  for (int i = 0; i < 4; i++) if (x >= uToneX[i]) y = uToneY[i] + (x - uToneX[i]) * (uToneY[i + 1] - uToneY[i]) / max(uToneX[i + 1] - uToneX[i], 1e-4);
  if (x > uToneX[4]) y = uToneY[4] + (x - uToneX[4]);
  return c * (max(exp(y) - ${TONE_EPS.toExponential()}, 0.0) / max(l, 1e-6));
}
`;
