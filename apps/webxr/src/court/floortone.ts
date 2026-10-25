// The clean floor's colours (world.ts's floor shader, everywhere but the filmed floor from the dolly seat), measured
// once from the real floor: court/floor.jpg where floor-seen.png marks it filmed. The wood is the median of the seen
// floor off the lanes and the centre circle, so a logo, a painted-on sign or a band smeared along the camera's ray
// never tints it; the lanes' paint is their own median; the boards' tone spread is measured across them. One colour
// each, so nothing of the footage shows in the floor you walk on (no soft blobs where the real floor had a logo).
// Stream E (`look`) builds it.

/** The rulebook's board width, metres (2.25 in): the tone is measured one board apart. */
export const BOARD_M = 0.057;
/** The lane (both ends): its length from the baseline and half width, metres (16 ft by 16 ft), as world.ts draws it. */
export const LANE = { length: 5.79, half: 2.44 };
/** The centre circle's radius, metres, plus a margin: a logo lives there. */
export const CENTRE_R = 1.83 + 0.1;
/** Fewer seen texels than this and a colour isn't measured (the bundle's hardwood or the rulebook's paint stand). */
export const MIN_TEXELS = 400;
/** The rulebook's tone spread, when the real floor can't give one. */
export const TONE_DEFAULT = 0.05;

export interface FloorTones {
  /** The wood, sRGB 0-1, or null (nothing measured). */
  wood: [number, number, number] | null;
  /** The lanes' paint, sRGB 0-1, or null. */
  paint: [number, number, number] | null;
  /** The boards' tone spread, as a share of the mean (0.02-0.12). */
  tone: number;
}

/** The per-channel median of a 256-bin histogram per channel, sRGB 0-1. */
function median(hist: Uint32Array, n: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    let v = 0;
    while (v < 255 && (acc += hist[c * 256 + v]) * 2 < n) v++;
    out[c] = v / 255;
  }
  return out;
}

/**
 * The clean floor's colours from the real floor's RGBA bytes and its seen mask's (same size, `w` x `h`, rows along +z
 * from -width/2, columns along +x from -length/2: floor.jpg's layout as the floor shader reads it; seen = red >= 250).
 */
export function floorTones(
  rgb: ArrayLike<number>,
  mask: ArrayLike<number>,
  w: number,
  h: number,
  length: number,
  width: number,
): FloorTones {
  const woodHist = new Uint32Array(768);
  const paintHist = new Uint32Array(768);
  let nWood = 0;
  let nPaint = 0;
  for (let y = 0; y < h; y++) {
    const z = ((y + 0.5) / h) * width - width / 2;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (mask[o] < 250) continue;
      const cx = ((x + 0.5) / w) * length - length / 2;
      const lane = Math.abs(cx) >= length / 2 - LANE.length && Math.abs(z) <= LANE.half;
      if (!lane && Math.hypot(cx, z) < CENTRE_R) continue;
      const hist = lane ? paintHist : woodHist;
      for (let c = 0; c < 3; c++) hist[c * 256 + rgb[o + c]]++;
      if (lane) nPaint++;
      else nWood++;
    }
  }
  // the boards' tone: luma one board apart across them, on seen texels, as a share of the mean (median |d| / 0.954 /
  // sqrt(2) is the std of one board's tone when boards are independent)
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const LUT = Float32Array.from({ length: 256 }, (_, i) => lin(i));
  const luma = (o: number) => 0.2126 * LUT[rgb[o]] + 0.7152 * LUT[rgb[o + 1]] + 0.0722 * LUT[rgb[o + 2]];
  const step = Math.max(1, Math.round((BOARD_M / width) * h));
  const ds: number[] = [];
  let sumY = 0;
  for (let y = 0; y + step < h; y += 2)
    for (let x = 0; x < w; x += 2) {
      const o = (y * w + x) * 4;
      const o2 = ((y + step) * w + x) * 4;
      if (mask[o] < 250 || mask[o2] < 250) continue;
      const y1 = luma(o);
      ds.push(Math.abs(y1 - luma(o2)));
      sumY += y1;
    }
  let tone = TONE_DEFAULT;
  if (ds.length >= 100) {
    ds.sort((a, b) => a - b);
    tone = Math.min(0.12, Math.max(0.02, ds[ds.length >> 1] / 0.954 / Math.SQRT2 / (sumY / ds.length)));
  }
  return {
    wood: nWood >= MIN_TEXELS ? median(woodHist, nWood) : null,
    paint: nPaint >= MIN_TEXELS ? median(paintHist, nPaint) : null,
    tone,
  };
}
