// The screenshot diff for Court Side checks: PSNR (dB, optionally inside a mask), SSIM (Gaussian window on luma, the
// P9 bar), and alignment in degrees of view (the plan's unit: 0.05 deg is ~1 px at the Quest's centre, 19.5 px/deg),
// measured as each textured tile's shift between the two images (median, p95, max).
//   node apps/webxr/scripts/court/diff.mjs a.png b.png [--mask m.png] [--px-per-deg 19.5 | --fov-y <deg>]
//        [--max-deg 0.05] [--min-psnr 30] [--min-ssim 0.95] [--tile 96] [--max-px 8]
// prints one PASS/FAIL line per bar (and the numbers as JSON); exits 1 on any FAIL. Images: { width, height,
// channels, data } as png.mjs reads them; both must be the same size. Masks: one byte per pixel, nonzero = counted.
import { readPng } from "./png.mjs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** BT.709 luma, 0-255, one float per pixel (alpha ignored). */
export function toLuma(img) {
  const { width: w, height: h, channels: c, data } = img;
  const out = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * c;
    out[i] = c >= 3 ? 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2] : data[o];
  }
  return out;
}

const same = (a, b) => {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`diff: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
};

/** PSNR in dB over the colour channels (Infinity when equal); with a mask, only where it is nonzero. */
export function psnr(a, b, mask) {
  same(a, b);
  const ca = Math.min(3, a.channels);
  const cb = Math.min(3, b.channels);
  if (ca !== cb) throw new Error("psnr: different channel counts");
  let se = 0;
  let n = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    if (mask && !mask[i]) continue;
    for (let k = 0; k < ca; k++) {
      const d = a.data[i * a.channels + k] - b.data[i * b.channels + k];
      se += d * d;
    }
    n += ca;
  }
  if (!n) throw new Error("psnr: empty mask");
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n));
}

function gaussBlur(src, w, h, sigma = 1.5) {
  const r = Math.ceil(3 * sigma);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const ks = k.reduce((s, v) => s + v, 0);
  const tmp = new Float64Array(w * h);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
      tmp[y * w + x] = s / ks;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = s / ks;
    }
  return out;
}

/** Mean SSIM on luma (Gaussian window, sigma 1.5; Wang et al. constants), over the mask if given, borders excluded. */
export function ssim(a, b, mask) {
  same(a, b);
  const { width: w, height: h } = a;
  const x = toLuma(a);
  const y = toLuma(b);
  const xx = x.map((v) => v * v);
  const yy = y.map((v) => v * v);
  const xy = x.map((v, i) => v * y[i]);
  const [mx, my, sxx, syy, sxy] = [x, y, xx, yy, xy].map((m) => gaussBlur(m, w, h));
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let sum = 0;
  let n = 0;
  for (let j = 5; j < h - 5; j++)
    for (let i = 5; i < w - 5; i++) {
      const p = j * w + i;
      if (mask && !mask[p]) continue;
      const vx = sxx[p] - mx[p] * mx[p];
      const vy = syy[p] - my[p] * my[p];
      const cxy = sxy[p] - mx[p] * my[p];
      sum += ((2 * mx[p] * my[p] + C1) * (2 * cxy + C2)) / ((mx[p] ** 2 + my[p] ** 2 + C1) * (vx + vy + C2));
      n++;
    }
  if (!n) throw new Error("ssim: no pixels inside the borders (or the mask)");
  return sum / n;
}

/** Mean squared luma difference between A at (x, y) and B at (x + sx, y + sy) over a region, every `step` pixels. */
function sse(A, B, w, sx, sy, r, step) {
  let s = 0;
  let n = 0;
  for (let y = r.y0; y < r.y1; y += step)
    for (let x = r.x0; x < r.x1; x += step) {
      const d = A[y * w + x] - B[(y + sy) * w + x + sx];
      s += d * d;
      n++;
    }
  return s / n;
}

/** Where B's content sits relative to A's inside a region (pixels, sub-pixel): B(x + d) ~ A(x). */
function regionShift(A, B, w, h, maxPx, region) {
  const r = {
    x0: Math.max(region.x0, maxPx + 1), y0: Math.max(region.y0, maxPx + 1),
    x1: Math.min(region.x1, w - maxPx - 1), y1: Math.min(region.y1, h - maxPx - 1),
  };
  if (r.x1 - r.x0 < 4 || r.y1 - r.y0 < 4) return null;
  let best = { sx: 0, sy: 0, e: Infinity };
  for (let sy = -maxPx; sy <= maxPx; sy++)
    for (let sx = -maxPx; sx <= maxPx; sx++) {
      const e = sse(A, B, w, sx, sy, r, 2);
      if (e < best.e) best = { sx, sy, e };
    }
  // then Lucas-Kanade on B sampled bilinearly, from the best whole shift: sub-pixel without a parabola's bias
  let dx = best.sx;
  let dy = best.sy;
  for (let it = 0; it < 10; it++) {
    let gxx = 0, gxy = 0, gyy = 0, bx = 0, by = 0;
    for (let y = r.y0; y < r.y1; y++)
      for (let x = r.x0; x < r.x1; x++) {
        const X = x + dx;
        const Y = y + dy;
        const gX = (bilinear(B, w, X + 0.5, Y) - bilinear(B, w, X - 0.5, Y));
        const gY = (bilinear(B, w, X, Y + 0.5) - bilinear(B, w, X, Y - 0.5));
        const e = bilinear(B, w, X, Y) - A[y * w + x];
        gxx += gX * gX;
        gxy += gX * gY;
        gyy += gY * gY;
        bx += gX * e;
        by += gY * e;
      }
    const det = gxx * gyy - gxy * gxy;
    if (det < 1e-9) break;
    const ux = -(gyy * bx - gxy * by) / det;
    const uy = -(gxx * by - gxy * bx) / det;
    dx = Math.max(-maxPx, Math.min(maxPx, dx + ux));
    dy = Math.max(-maxPx, Math.min(maxPx, dy + uy));
    if (Math.hypot(ux, uy) < 1e-4) break;
  }
  return { dx, dy, error: best.e };
}

/** B at a fractional pixel (x, y), bilinear; (x, y) must be inside by one pixel. */
function bilinear(B, w, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const o = y0 * w + x0;
  return (1 - fy) * ((1 - fx) * B[o] + fx * B[o + 1]) + fy * ((1 - fx) * B[o + w] + fx * B[o + w + 1]);
}

/** The shift of b relative to a over the whole image (pixels): b's content sits at a's + (dx, dy). */
export function shift(a, b, { maxPx = 8 } = {}) {
  same(a, b);
  const s = regionShift(toLuma(a), toLuma(b), a.width, a.height, maxPx, { x0: 0, y0: 0, x1: a.width, y1: a.height });
  if (!s) throw new Error("shift: image too small for maxPx");
  return s;
}

/** Pixels per degree at the centre of an image with a vertical field of view of fovYDeg over heightPx rows. */
export function pxPerDeg(fovYDeg, heightPx) {
  return (heightPx / 2 / Math.tan(((fovYDeg / 2) * Math.PI) / 180)) * (Math.PI / 180);
}

/**
 * Alignment in degrees: each textured tile's shift (luma std > minStd), as an angle at `pxPerDeg`. Returns the median,
 * p95 and max of the tiles' shift magnitudes, the median dx and dy, and how many tiles counted.
 */
export function alignment(a, b, { pxPerDeg: ppd, maxPx = 8, tile = 96, minStd = 6, mask } = {}) {
  same(a, b);
  if (!ppd) throw new Error("alignment: pxPerDeg is needed");
  const { width: w, height: h } = a;
  const A = toLuma(a);
  const B = toLuma(b);
  const mags = [];
  const dxs = [];
  const dys = [];
  for (let y0 = 0; y0 + tile <= h; y0 += tile)
    for (let x0 = 0; x0 + tile <= w; x0 += tile) {
      let s = 0, s2 = 0, n = 0, inMask = 0;
      for (let y = y0; y < y0 + tile; y += 2)
        for (let x = x0; x < x0 + tile; x += 2) {
          const v = A[y * w + x];
          s += v;
          s2 += v * v;
          n++;
          if (!mask || mask[y * w + x]) inMask++;
        }
      const std = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
      if (std < minStd || inMask < n / 2) continue;
      const r = regionShift(A, B, w, h, maxPx, { x0, y0, x1: x0 + tile, y1: y0 + tile });
      if (!r) continue;
      mags.push(Math.hypot(r.dx, r.dy) / ppd);
      dxs.push(r.dx / ppd);
      dys.push(r.dy / ppd);
    }
  if (!mags.length) throw new Error("alignment: no textured tiles");
  const pct = (list, p) => {
    const s = [...list].sort((x, y) => x - y);
    return s[Math.max(0, Math.ceil(s.length * p) - 1)];
  };
  return { medianDeg: pct(mags, 0.5), p95Deg: pct(mags, 0.95), maxDeg: pct(mags, 1), dxDeg: pct(dxs, 0.5), dyDeg: pct(dys, 0.5), tiles: mags.length };
}

/** Every bar given, as PASS/FAIL lines: maxDeg (alignment p95), minPsnr, minSsim. */
export function compare(a, b, { pxPerDeg: ppd, maxDeg, minPsnr, minSsim, mask, tile = 96, maxPx = 8 } = {}) {
  const lines = [];
  const out = { pass: true, lines };
  const bar = (ok, text) => {
    lines.push(`${ok ? "PASS" : "FAIL"} ${text}`);
    if (!ok) out.pass = false;
  };
  if (minPsnr !== undefined) {
    out.psnr = psnr(a, b, mask);
    bar(out.psnr >= minPsnr, `psnr ${out.psnr === Infinity ? "inf" : out.psnr.toFixed(2)} dB >= ${minPsnr}`);
  }
  if (minSsim !== undefined) {
    out.ssim = ssim(a, b, mask);
    bar(out.ssim >= minSsim, `ssim ${out.ssim.toFixed(4)} >= ${minSsim}`);
  }
  if (maxDeg !== undefined) {
    out.alignment = alignment(a, b, { pxPerDeg: ppd, mask, tile, maxPx });
    bar(out.alignment.p95Deg <= maxDeg, `alignment p95 ${out.alignment.p95Deg.toFixed(4)} deg <= ${maxDeg} deg (median ${out.alignment.medianDeg.toFixed(4)}, ${out.alignment.tiles} tiles)`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const num = (name) => (opt(name) === undefined ? undefined : Number(opt(name)));
  const [fa, fb] = args.filter((x, i) => !x.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  if (!fa || !fb) {
    console.error("usage: diff.mjs a.png b.png [--mask m.png] [--px-per-deg N | --fov-y DEG] [--max-deg D] [--min-psnr DB] [--min-ssim S]");
    process.exit(2);
  }
  const a = readPng(fa);
  const b = readPng(fb);
  const m = opt("--mask") ? readPng(opt("--mask")) : null;
  const mask = m ? new Uint8Array(m.width * m.height).map((_, i) => m.data[i * m.channels]) : undefined;
  const ppd = num("--px-per-deg") ?? (num("--fov-y") ? pxPerDeg(num("--fov-y"), a.height) : undefined);
  const res = compare(a, b, { pxPerDeg: ppd, maxDeg: ppd ? num("--max-deg") : undefined, minPsnr: num("--min-psnr"), minSsim: num("--min-ssim"), mask, tile: num("--tile") ?? 96, maxPx: num("--max-px") ?? 8 });
  for (const l of res.lines) console.log(l);
  console.log(JSON.stringify({ psnr: res.psnr, ssim: res.ssim, alignment: res.alignment }));
  process.exit(res.pass ? 0 : 1);
}
